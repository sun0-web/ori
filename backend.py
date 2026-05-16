"""
Ori — 익명 데이터 수집 + Gemini LLM 응답 + 자기 발전 사이클 백엔드
================================================
세 가지 핵심 역할:
  1) 프론트엔드의 contributeData() 익명 스냅샷 수집 → 학습용 데이터 누적
  2) 프론트의 buildResponse() 호출을 받아 Gemini API로 응답 생성
  3) 자기 발전 사이클 (Self-Improvement Loop):
     · 단계 A — 모인 데이터에서 집단 인사이트 추출 → 시스템 프롬프트에 자동 주입
     · 단계 B — scikit-learn으로 위험도 분류기 학습 → 응답마다 위험도 추정

설치:
    pip install flask flask-cors sqlalchemy google-generativeai
    pip install scikit-learn numpy        # 단계 B (위험도 분류기) 사용 시
실행:
    export GEMINI_API_KEY=your_key_here
    python backend.py

API 키 발급:
    https://aistudio.google.com/apikey  (무료, 신용카드 불필요)
    무료 티어 (2026년 5월 기준):
      · Gemini 2.5 Flash: 분당 10 요청, 일 500 요청
      · Gemini 2.5 Flash-Lite: 분당 15 요청, 일 1,000 요청

엔드포인트:
    POST /v1/respond              — Gemini 응답 (인사이트·분류기 자동 적용)
    POST /v1/contribute           — 익명 데이터 수집 (옵트인)
    POST /v1/contribute/forget    — 익명 ID로 본인 기여분 삭제
    GET  /v1/admin/aggregate      — ML 학습용 집계 (관리자)
    GET  /v1/admin/insights       — 현재 활성화된 집단 인사이트 조회
    POST /v1/admin/train          — 위험도 분류기 강제 재학습
    GET  /v1/admin/classifier     — 분류기 상태 조회
    GET  /v1/health               — 서버·Gemini·분류기 상태

자기 발전 사이클 작동:
    [집단 인사이트 — A]
      · 매시간 자동 갱신
      · 시간대 부정 감정 패턴, PCL-5 군집 평균, 감정 카테고리 비중,
        임상 기준선 초과 비율을 추출해 시스템 프롬프트에 추가
      · 5건 이상 모이면 자동 활성화 (개발 임계값. 실배포 50+ 권장)

    [위험도 분류기 — B]
      · POST /v1/admin/train 호출 시 학습
      · 피처: 시간대(24차원) + 카테고리 비중(5차원) = 29차원
      · 라벨: PCL-5 ≥ 33 (임상 기준선)
      · Logistic Regression vs Random Forest 교차검증, recall 우선
      · .pkl 저장, 부팅 시 자동 로드
      · 위험도 ≥ 0.6 추정 시 시스템 프롬프트에 안내 추가

배포 시 체크리스트:
    [ ] HTTPS 강제 (개인정보 전송이므로 필수)
    [ ] 도메인 화이트리스트 CORS
    [ ] Rate limiting (IP당 분당 5회 정도)
    [ ] DB는 PostgreSQL 또는 동급 (SQLite는 개발용)
    [ ] PIPA 제3자 제공 동의 절차 준수
    [ ] 익명 ID 외 IP·UA·Referer 등 부가 정보 로깅 금지
    [ ] GEMINI_API_KEY는 환경변수로만 (코드 커밋 금지)
    [ ] Gemini 무료 티어는 입력을 학습에 사용함 — 사용자 약관에 명시 필수
    [ ] 위기 신호는 LLM 거치지 않고 사전 차단 (오답 위험)
    [ ] /v1/admin/* 엔드포인트엔 인증 필수 (현재 코드엔 미구현)
"""

import os
import re
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS
from sqlalchemy import create_engine, Column, Integer, String, JSON, DateTime, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker

# Gemini SDK — 없어도 다른 엔드포인트는 작동
try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

# scikit-learn — 위험도 분류기 (단계 B). 없으면 분류기 비활성화
try:
    import pickle
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import cross_val_score
    from sklearn.preprocessing import StandardScaler
    import numpy as np
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False

app = Flask(__name__)
# 개발·시연 단계에선 모든 origin 허용 (file:// 더블클릭 포함)
# 배포 시에는 아래 줄을 주석 처리하고 화이트리스트 origins로 좁힐 것
CORS(app, resources={r"/v1/*": {"origins": "*"}})
# 배포용(예시): CORS(app, resources={r"/v1/*": {"origins": ["https://your-domain.example.com"]}})

# Gemini 초기화
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
GEMINI_MODEL_NAME = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')

if GEMINI_AVAILABLE and GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    print(f"[Ori] Gemini 활성화: {GEMINI_MODEL_NAME}")
else:
    print("[Ori] Gemini 비활성화 — GEMINI_API_KEY 미설정 또는 SDK 미설치")

# DB 설정
engine = create_engine('sqlite:///ori_contributions.db')
Base = declarative_base()
Session = sessionmaker(bind=engine)


class Contribution(Base):
    """단건 익명 기여 — 한 익명 ID가 여러 건 보낼 수 있음"""
    __tablename__ = 'contributions'

    id              = Column(Integer, primary_key=True, autoincrement=True)
    anonymous_id    = Column(String(64), nullable=False, index=True)
    client_version  = Column(String(32))
    snapshot_at     = Column(DateTime, nullable=False)
    received_at     = Column(DateTime, nullable=False, default=datetime.utcnow)
    session_count   = Column(Integer)
    payload         = Column(JSON, nullable=False)  # 익명화된 전체 스냅샷
    deleted         = Column(Boolean, default=False)


class DeletionRequest(Base):
    """사용자가 옵트아웃하면서 자기 기여분 삭제 요청한 이력"""
    __tablename__ = 'deletion_requests'
    id              = Column(Integer, primary_key=True, autoincrement=True)
    anonymous_id    = Column(String(64), nullable=False, index=True)
    requested_at    = Column(DateTime, nullable=False, default=datetime.utcnow)
    completed       = Column(Boolean, default=False)


Base.metadata.create_all(engine)


# =====================================================================
# 엔드포인트
# =====================================================================

@app.route('/v1/contribute', methods=['POST'])
def contribute():
    """프론트엔드가 보낸 익명 스냅샷 배치를 저장."""
    data = request.get_json(silent=True)
    if not data or 'batch' not in data:
        return jsonify({'error': 'invalid payload'}), 400

    batch = data['batch']
    if not isinstance(batch, list) or len(batch) > 10:
        return jsonify({'error': 'batch size invalid'}), 400

    session = Session()
    accepted = 0
    try:
        for item in batch:
            # 필수 필드 검증
            anon_id = item.get('anonymousId')
            if not anon_id or len(anon_id) < 16:
                continue

            # 삭제 요청된 익명 ID는 무시
            if session.query(DeletionRequest).filter_by(anonymous_id=anon_id, completed=True).first():
                continue

            # 대화 원문이 실수로 들어왔으면 거부 (방어 로직)
            if any(k in item for k in ('history', 'note', 'safetyPlan')):
                return jsonify({'error': 'forbidden field present'}), 400

            try:
                snapshot_at = datetime.fromtimestamp(item['snapshotAt'] / 1000)
            except (KeyError, TypeError, ValueError):
                continue

            row = Contribution(
                anonymous_id   = anon_id,
                client_version = item.get('clientVersion', 'unknown'),
                snapshot_at    = snapshot_at,
                session_count  = item.get('sessionCount', 0),
                payload        = {
                    'lexiconHashed': item.get('lexiconHashed', {}),
                    'timePattern':   item.get('timePattern', []),
                    'assessments':   item.get('assessments', []),
                    'moodDist':      item.get('moodDist', []),
                    'satisfactionSummary': item.get('satisfactionSummary'),  # 평균값만, 코멘트 원문 X
                },
            )
            session.add(row)
            accepted += 1

        session.commit()
        return jsonify({'accepted': accepted}), 200
    except Exception as e:
        session.rollback()
        app.logger.exception('contribute failed')
        return jsonify({'error': 'server error'}), 500
    finally:
        session.close()


@app.route('/v1/contribute/forget', methods=['POST'])
def forget():
    """사용자 옵트아웃 — 익명 ID로 본인 기여분 삭제 요청."""
    data = request.get_json(silent=True) or {}
    anon_id = data.get('anonymousId')
    if not anon_id:
        return jsonify({'error': 'anonymousId required'}), 400

    session = Session()
    try:
        # 1) 삭제 요청 기록
        req = DeletionRequest(anonymous_id=anon_id)
        session.add(req)
        session.commit()

        # 2) 즉시 soft-delete (실제 삭제는 야간 배치)
        session.query(Contribution).filter_by(anonymous_id=anon_id).update({
            'deleted': True,
            'payload': {},  # 페이로드 즉시 비움
        })

        req.completed = True
        session.commit()
        return jsonify({'status': 'deleted'}), 200
    except Exception:
        session.rollback()
        return jsonify({'error': 'server error'}), 500
    finally:
        session.close()


# =====================================================================
# ML 파이프라인용 데이터 추출 (관리자 전용 — 인증 추가 필요)
# =====================================================================

@app.route('/v1/admin/aggregate', methods=['GET'])
def aggregate():
    """학습용 집계 데이터 — 시간대별 부정 감정 분포, 자가진단 점수 분포 등."""
    # ★ 실제 배포 시 관리자 인증 필수
    session = Session()
    try:
        rows = session.query(Contribution).filter_by(deleted=False).all()

        # 1) 시간대별 평균 기분 (부정 감정 시간대 식별 — 진단 정확도 향상에 사용)
        hour_buckets = [{'count': 0, 'mood_sum': 0.0} for _ in range(24)]
        for r in rows:
            for hour, slot in enumerate(r.payload.get('timePattern', [])):
                if hour >= 24: break
                hour_buckets[hour]['count'] += slot.get('count', 0)
                hour_buckets[hour]['mood_sum'] += slot.get('moodAvg', 0) * slot.get('count', 0)

        hour_avg = []
        for h, b in enumerate(hour_buckets):
            avg = b['mood_sum'] / b['count'] if b['count'] > 0 else 0.0
            hour_avg.append({'hour': h, 'mood_avg': round(avg, 3), 'samples': b['count']})

        # 2) PCL-5 / IES-R 점수 분포
        pcl5_scores = []
        iesr_scores = []
        for r in rows:
            for a in r.payload.get('assessments', []):
                if a.get('type') == 'pcl5':
                    pcl5_scores.append(a['total'])
                elif a.get('type') == 'iesr':
                    iesr_scores.append(a['total'])

        # 3) 단어 해시 빈도 (감정 카테고리별) — 모델 학습 시 피처
        lexicon_aggregate = {}
        for r in rows:
            for cat, hashes in r.payload.get('lexiconHashed', {}).items():
                lexicon_aggregate.setdefault(cat, {})
                for h, count in hashes.items():
                    lexicon_aggregate[cat][h] = lexicon_aggregate[cat].get(h, 0) + count

        return jsonify({
            'total_contributions': len(rows),
            'hour_pattern': hour_avg,
            'pcl5_distribution': {
                'count': len(pcl5_scores),
                'mean':  sum(pcl5_scores) / len(pcl5_scores) if pcl5_scores else 0,
                'over_cutoff': sum(1 for s in pcl5_scores if s >= 33),
            },
            'iesr_distribution': {
                'count': len(iesr_scores),
                'mean':  sum(iesr_scores) / len(iesr_scores) if iesr_scores else 0,
                'over_cutoff': sum(1 for s in iesr_scores if s >= 33),
            },
            'lexicon_categories': {cat: len(hashes) for cat, hashes in lexicon_aggregate.items()},
        }), 200
    finally:
        session.close()


# =====================================================================
# Gemini LLM 응답 엔드포인트
# ---------------------------------------------------------------------
# 프론트의 buildResponse() 호출을 받아 Gemini로 자연스러운 응답 생성.
# 다층 안전장치:
#   1) 사전 필터 — 위기 키워드 즉시 차단 (LLM 거치지 않음)
#   2) 시스템 프롬프트 — Ori 페르소나·안전 가이드라인 강제
#   3) Gemini Safety Settings — 자해·위험 콘텐츠 자동 차단
#   4) 사후 필터 — 응답에서 위험 키워드 발견 시 안전 응답으로 교체
#   5) 폴백 — API 실패 시 None 반환 → 프론트가 규칙 기반으로 폴백
# =====================================================================

ORI_SYSTEM_PROMPT = """당신은 '오리(Ori)'입니다. 한국 대학생 팀이 만든 심리 지지 챗봇으로,
"근원의 나로 돌아가는 길" 이라는 컨셉을 가지고 있어요.

## 페르소나
- 따뜻하지만 가볍지 않음. 친구처럼 편하게 말하지만, 진지한 순간엔 진지함
- 평어체 아닌 부드러운 존댓말 ("그러셨군요", "들었어요", "괜찮으세요?")
- 한 응답은 1~3문장. 짧을수록 좋음. 절대 4문장 이상 쓰지 말 것
- 가끔은 한 단어 ("음…", "네…")만으로도 답해도 좋음
- 이모지 사용 금지

## 절대 하지 말 것 (의료법·윤리 위반)
- 의학적 진단 절대 금지: "PTSD입니다", "우울증이 있으세요" 같은 표현 금지
- 약물·치료법 추천 금지
- "괜찮을 거예요", "걱정 마세요" 같은 가벼운 위로 금지 (감정 부정)
- 사용자의 감정을 부정하거나 합리화하지 말 것
- 자해·자살 방법론은 절대 언급 금지
- "왜 그런 생각을 하세요?" 같은 추궁성 질문 금지

## 해야 할 것
- 사용자가 표현한 감정을 그대로 받아들이고 인정 ("그러셨겠어요", "충분히 그럴 만해요")
- 짧은 침묵·인정도 좋은 응답 ("음…", "네…", "그렇군요.")
- 사용자가 자주 쓰는 단어를 가끔 자연스럽게 인용
- 위기 신호 감지 시 1393(자살예방), 1577-0195(정신건강위기) 안내
- 사용자 페이스에 맞춤. 더 캐묻지 말 것

## 응답 형식
순수 텍스트만. 마크다운·번호·줄바꿈 없이 자연어 문장만.
"""

# 위기 키워드 — 사전 필터 (LLM 거치지 않고 즉시 차단)
CRISIS_HIGH_PATTERNS = [
    r'자살', r'죽고\s*싶', r'죽어\s*버리', r'목매', r'투신', r'자해',
    r'살\s*가치\s*없', r'사라지고\s*싶', r'끝내고\s*싶',
]
# 사후 필터 — LLM 응답에 이런 게 들어가면 차단
DANGEROUS_OUTPUT_PATTERNS = [
    r'자살.*방법', r'약을.*먹', r'목을.*매', r'투신.*하면',
    r'정신과.*가지\s*마', r'병원.*가지\s*마',
]
# 의학 진단 위반 — LLM이 실수로 진단할 경우
DIAGNOSIS_PATTERNS = [
    r'당신은.*PTSD', r'당신은.*우울증', r'당신은.*불안장애',
    r'.*증세입니다',
]


def is_crisis_input(text):
    """사용자 입력에 위기 키워드가 있으면 True"""
    if not text:
        return False
    return any(re.search(p, text) for p in CRISIS_HIGH_PATTERNS)


def is_dangerous_output(text):
    """LLM 응답에 위험한 내용이 있으면 True"""
    if not text:
        return True
    return any(re.search(p, text) for p in DANGEROUS_OUTPUT_PATTERNS + DIAGNOSIS_PATTERNS)


def build_user_prompt(payload):
    """프론트에서 받은 컨텍스트를 Gemini 입력 텍스트로 변환"""
    parts = []

    # 사용자 컨텍스트 (개인화)
    ctx = payload.get('context', {})
    mode = ctx.get('mode', 'daily')
    parts.append(f"[현재 모드: {mode}]")

    if ctx.get('topLexicon'):
        words = ', '.join(ctx['topLexicon'][:8])
        parts.append(f"[사용자가 자주 쓰는 단어: {words}]")

    if ctx.get('topThemes'):
        themes = ', '.join(ctx['topThemes'][:3])
        parts.append(f"[반복되는 주제: {themes}]")

    if ctx.get('lastAssessment'):
        a = ctx['lastAssessment']

        # 신규 형식 (riskLevel/riskLabel 통합 결과) 우선 처리
        if a.get('riskLevel'):
            risk_label = a.get('riskLabel', '-')
            risk_level = a.get('riskLevel', '-')
            score_line = f"[자가점검 결과: {risk_label}({risk_level})"
            pcl5 = a.get('pcl5Total')
            iesr = a.get('iesrTotal')
            if pcl5:
                score_line += f", PCL-5 {pcl5}/80"
            if iesr:
                score_line += f", IES-R {iesr}/88"
            score_line += "]"
            parts.append(score_line)

            # 두드러진 PTSD 증상 군집(B/C/D/E)을 사람이 읽는 이름으로 변환
            cluster_map = {
                'B': '재경험(침습 기억·악몽·플래시백)',
                'C': '회피(상황·감정·기억을 피하기)',
                'D': '인지·기분의 부정적 변화(자책·무감각·고립)',
                'E': '각성·반응성(과경계·수면 어려움·짜증)',
            }
            dom = a.get('dominantCluster')
            if dom:
                parts.append(f"[가장 두드러진 영역: {cluster_map.get(dom, dom)}]")
            if a.get('clusters'):
                parts.append(f"[PCL-5 군집 점수(B/C/D/E): {a.get('clusters')}]")

            # 위험도별 응답 가이드 — Gemini가 톤을 맞추도록
            if risk_level == 'high':
                parts.append("[응답 가이드: 위험 신호가 높게 나타남. 의학적 진단 표현은 절대 금지하되, "
                             "혼자 견디지 말고 전문기관(1393·1577-0195)과 연결될 수 있음을 안전하게 안내. "
                             "단정·재촉 금지, 공감과 안전 우선.]")
            elif risk_level == 'mid':
                parts.append("[응답 가이드: 반복되는 신호가 보이는 상태. 감정 라벨링·호흡·기록을 부드럽게 제안. "
                             "압박 없이, 사용자의 속도를 따라가며.]")
            else:
                parts.append("[응답 가이드: 두드러진 고위험 신호는 낮음. 일상적 정서 지지·자기 친절 강조.]")
        else:
            # 옛 형식(type/total/level만 있는 경우) 호환
            parts.append(f"[최근 자가점검: {a.get('type','').upper()} {a.get('total','-')}점, {a.get('level','-')}]")

    # 최근 대화 (최대 5턴)
    history = payload.get('history', [])
    if history:
        parts.append("\n[최근 대화]")
        for h in history[-5:]:
            role = '사용자' if h.get('role') == 'user' else '오리'
            parts.append(f"{role}: {h.get('text','')}")

    # 이번 사용자 메시지
    user_msg = payload.get('userMessage', '')
    parts.append(f"\n[이번 사용자 메시지]\n사용자: {user_msg}")
    parts.append("\n위 맥락을 반영해 1~3문장으로 자연스럽게 응답하세요. 다른 설명·번호·접두어 없이 답변만:")

    return '\n'.join(parts)


# =====================================================================
# 집단 인사이트 자동 학습 (Self-Improvement Loop · 단계 A)
# ---------------------------------------------------------------------
# 모인 익명 데이터에서 패턴을 추출해 시스템 프롬프트에 자동 주입.
# 모델 재학습 없이 봇이 "전체 사용자 경향"을 반영해 응답하도록.
#
# 캐시: 시간 단위로 갱신 (매 호출마다 DB 쿼리 안 함)
# =====================================================================

_INSIGHT_CACHE = {
    'lines': [],          # 시스템 프롬프트에 추가할 가이드라인 문자열들
    'updated_at': None,   # 마지막 갱신 시각
    'sample_size': 0,     # 학습에 사용된 표본 수
}
_INSIGHT_CACHE_TTL_SEC = 3600   # 1시간마다 자동 갱신
_INSIGHT_MIN_SAMPLES = 5        # 이만큼 모이면 인사이트 활성화 (개발 단계 임계값, 실제 배포 시 50+ 권장)


def refresh_collective_insights():
    """DB에서 익명 기여 데이터를 읽어 집단 패턴을 추출하고 _INSIGHT_CACHE 갱신.

    패턴 종류:
      1) 시간대별 부정 감정 분포 → "이 시간대 사용자들은 ~한 경향이 있다"
      2) PCL-5 군집 평균 → "전체 사용자에서 ~ 영역이 가장 무겁다"
      3) 감정 카테고리 비중 → "사용자들이 가장 많이 표현하는 감정"
      4) 점수 분포 → "임상 기준선 초과 비율"
    """
    session = Session()
    try:
        rows = session.query(Contribution).filter_by(deleted=False).all()
        sample_size = len(rows)

        if sample_size < _INSIGHT_MIN_SAMPLES:
            _INSIGHT_CACHE['lines'] = []
            _INSIGHT_CACHE['updated_at'] = datetime.utcnow().isoformat()
            _INSIGHT_CACHE['sample_size'] = sample_size
            return

        lines = []

        # 1) 시간대 패턴 — 부정 감정이 몰리는 시간대 찾기
        hour_buckets = [{'count': 0, 'mood_sum': 0.0} for _ in range(24)]
        for r in rows:
            for h, slot in enumerate(r.payload.get('timePattern', [])):
                if h >= 24:
                    break
                hour_buckets[h]['count'] += slot.get('count', 0)
                hour_buckets[h]['mood_sum'] += slot.get('moodAvg', 0) * slot.get('count', 0)

        valid_hours = [
            (h, b['mood_sum'] / b['count'])
            for h, b in enumerate(hour_buckets) if b['count'] >= 3
        ]
        if valid_hours:
            valid_hours.sort(key=lambda x: x[1])  # 가장 어두운 시간 순
            darkest = valid_hours[0]
            if darkest[1] < -0.3:
                lines.append(
                    f"전체 사용자 데이터에서 {darkest[0]}시 즈음에 어려움을 표현하는 경향이 두드러집니다. "
                    f"이 시간대 사용자에겐 더 부드럽게 다가가세요."
                )

        # 2) PCL-5 군집 — 전체에서 가장 무거운 영역
        cluster_sums = {'B': [], 'C': [], 'D': [], 'E': []}
        for r in rows:
            for a in r.payload.get('assessments', []):
                if a.get('type') == 'pcl5' and a.get('clusters'):
                    for k, v in a['clusters'].items():
                        if k in cluster_sums:
                            cluster_sums[k].append(v)

        # 군집별 평균을 최대치 대비 비율로 (B=20, C=8, D=28, E=24)
        cluster_max = {'B': 20, 'C': 8, 'D': 28, 'E': 24}
        cluster_label = {'B': '재경험', 'C': '회피', 'D': '부정적 인지·감정', 'E': '각성·반응성'}
        cluster_ratios = {}
        for k, vs in cluster_sums.items():
            if vs:
                cluster_ratios[k] = (sum(vs) / len(vs)) / cluster_max[k]

        if cluster_ratios:
            top_cluster = max(cluster_ratios.items(), key=lambda x: x[1])
            if top_cluster[1] > 0.35:
                lines.append(
                    f"전체 사용자 자가점검에서 '{cluster_label[top_cluster[0]]}' 영역이 가장 두드러진 경향이 있습니다. "
                    f"관련 호소를 들으실 때 충분히 인정하고 받아주세요."
                )

        # 3) 감정 카테고리 비중 — 가장 자주 표현되는 감정
        cat_totals = {}
        for r in rows:
            for cat, hashes in r.payload.get('lexiconHashed', {}).items():
                cat_totals[cat] = cat_totals.get(cat, 0) + sum(hashes.values())

        non_neutral = {k: v for k, v in cat_totals.items() if k != 'neutral' and v > 0}
        if non_neutral:
            total = sum(non_neutral.values())
            top_cat = max(non_neutral.items(), key=lambda x: x[1])
            if top_cat[1] / total >= 0.35:
                cat_label_map = {'sad': '슬픔', 'anxious': '불안', 'angry': '분노', 'tired': '피로', 'positive': '안정'}
                lines.append(
                    f"전체 사용자 대화에서 '{cat_label_map.get(top_cat[0], top_cat[0])}' 감정이 가장 자주 표현됩니다 "
                    f"(전체의 {int(top_cat[1] / total * 100)}%). "
                    f"비슷한 감정 호소엔 깊이 공명해 주세요."
                )

        # 4) PCL-5/IES-R 임상 기준선 초과 비율
        pcl5_scores = []
        iesr_scores = []
        for r in rows:
            for a in r.payload.get('assessments', []):
                if a.get('type') == 'pcl5':
                    pcl5_scores.append(a['total'])
                elif a.get('type') == 'iesr':
                    iesr_scores.append(a['total'])

        if pcl5_scores and len(pcl5_scores) >= 3:
            over = sum(1 for s in pcl5_scores if s >= 33)
            ratio = over / len(pcl5_scores)
            if ratio > 0.4:
                lines.append(
                    f"전체 사용자의 {int(ratio*100)}% 가 PCL-5 임상 기준선을 넘는 점수를 보입니다. "
                    f"트라우마 신호를 가볍게 넘기지 말고 전문가 연계를 적극 권유하세요."
                )

        _INSIGHT_CACHE['lines'] = lines
        _INSIGHT_CACHE['updated_at'] = datetime.utcnow().isoformat()
        _INSIGHT_CACHE['sample_size'] = sample_size

        if lines:
            app.logger.info(f"[Insights] {len(lines)} patterns extracted from {sample_size} contributions")

    except Exception:
        app.logger.exception('refresh_collective_insights failed')
    finally:
        session.close()


def get_collective_insights_block():
    """현재 캐시된 인사이트를 시스템 프롬프트용 텍스트 블록으로 반환.
    캐시가 만료되었거나 비어 있으면 자동 갱신."""
    now = datetime.utcnow()
    needs_refresh = False

    if not _INSIGHT_CACHE['updated_at']:
        needs_refresh = True
    else:
        try:
            updated = datetime.fromisoformat(_INSIGHT_CACHE['updated_at'])
            if (now - updated).total_seconds() > _INSIGHT_CACHE_TTL_SEC:
                needs_refresh = True
        except Exception:
            needs_refresh = True

    if needs_refresh:
        refresh_collective_insights()

    lines = _INSIGHT_CACHE.get('lines', [])
    if not lines:
        return ''

    block = "\n## 집단 데이터에서 학습한 패턴 (참고용)\n"
    for line in lines:
        block += f"- {line}\n"
    block += f"(표본 {_INSIGHT_CACHE['sample_size']}건 기반, 매시간 갱신)\n"
    return block


@app.route('/v1/admin/insights', methods=['GET'])
def insights_view():
    """현재 활성화된 집단 인사이트 조회 (디버그·발표용)"""
    refresh_collective_insights()  # 강제 갱신
    return jsonify({
        'sample_size': _INSIGHT_CACHE.get('sample_size', 0),
        'min_required': _INSIGHT_MIN_SAMPLES,
        'updated_at':   _INSIGHT_CACHE.get('updated_at'),
        'lines':        _INSIGHT_CACHE.get('lines', []),
        'active':       bool(_INSIGHT_CACHE.get('lines')),
    }), 200


@app.route('/v1/admin/satisfaction', methods=['GET'])
def satisfaction_summary():
    """전체 만족도 평가 집계 조회 (발표·보고서용).

    개별 코멘트 원문은 저장하지 않음 — 평균과 카운트만 노출.
    """
    session = Session()
    try:
        rows = session.query(Contribution).filter_by(deleted=False).all()
        total_count = 0
        sum_help = 0.0
        sum_ease = 0.0
        sum_reuse = 0.0
        feature_counts = {}

        for r in rows:
            s = (r.payload or {}).get('satisfactionSummary')
            if not s or not s.get('count'):
                continue
            c = int(s.get('count', 0))
            if c <= 0:
                continue
            total_count += c
            sum_help  += float(s.get('avgHelpfulness', 0)) * c
            sum_ease  += float(s.get('avgEase', 0)) * c
            sum_reuse += float(s.get('avgReuseIntent', 0)) * c
            for feat, n in (s.get('bestFeatureCounts') or {}).items():
                feature_counts[feat] = feature_counts.get(feat, 0) + int(n)

        if total_count == 0:
            return jsonify({
                'total_responses': 0,
                'avg_helpfulness': None,
                'avg_ease':        None,
                'avg_reuse_intent': None,
                'best_feature_counts': {},
            }), 200

        return jsonify({
            'total_responses':    total_count,
            'avg_helpfulness':    round(sum_help / total_count, 2),
            'avg_ease':           round(sum_ease / total_count, 2),
            'avg_reuse_intent':   round(sum_reuse / total_count, 2),
            'best_feature_counts': feature_counts,
        }), 200
    except Exception:
        app.logger.exception('satisfaction summary failed')
        return jsonify({'error': 'server error'}), 500
    finally:
        session.close()


# =====================================================================
# 위험도 분류기 (Self-Improvement Loop · 단계 B)
# ---------------------------------------------------------------------
# scikit-learn으로 PCL-5 임상 기준선 33점 초과 여부를 분류하는 모델 학습.
# 피처: 시간대별 부정 감정 분포(24차원) + 감정 카테고리 비중(5차원) = 29차원
# 라벨: PCL-5 ≥ 33 (1: 위험군, 0: 비위험군)
# 모델: Logistic Regression vs Random Forest 교차검증, 더 좋은 쪽 채택
#
# 학습된 모델은 디스크(.pkl)에 저장되고 매 호출 시 메모리에서 즉시 추론.
# 추론 결과는 Gemini 시스템 프롬프트에 추가되어 더 정확한 위기 감지에 활용.
# =====================================================================

_CLASSIFIER_CACHE = {
    'model': None,
    'scaler': None,
    'metadata': None,         # { type, accuracy, samples, trained_at }
    'updated_at': None,
}
_CLASSIFIER_FILE = 'ori_risk_classifier.pkl'
_CLASSIFIER_MIN_SAMPLES = 10  # 학습 최소 표본
_CLASSIFIER_MIN_POSITIVE = 3  # 위험군 최소 표본 (불균형 방지)


def extract_features_from_payload(payload):
    """단일 기여 페이로드에서 분류기 피처 벡터(29차원) 추출.

    - 24차원: 시간대별 부정 감정 평균 (mood_avg, [-1, 1] 범위)
    - 5차원:  감정 카테고리 비중 (sad/anxious/angry/tired/positive 정규화)
    """
    if not SKLEARN_AVAILABLE:
        return None

    # 시간대 (24차원) — 데이터 없으면 0
    time_feat = []
    time_pattern = payload.get('timePattern', [])
    for h in range(24):
        if h < len(time_pattern):
            slot = time_pattern[h]
            mood = slot.get('moodAvg', 0) if slot.get('count', 0) > 0 else 0
            time_feat.append(float(mood))
        else:
            time_feat.append(0.0)

    # 카테고리 비중 (5차원)
    cat_keys = ['sad', 'anxious', 'angry', 'tired', 'positive']
    lex = payload.get('lexiconHashed', {})
    cat_totals = {k: sum(lex.get(k, {}).values()) for k in cat_keys}
    total = sum(cat_totals.values()) + sum(lex.get('neutral', {}).values())
    if total > 0:
        cat_feat = [cat_totals[k] / total for k in cat_keys]
    else:
        cat_feat = [0.0] * 5

    return np.array(time_feat + cat_feat, dtype=np.float32)


def extract_label_from_payload(payload):
    """라벨: 그 사용자의 가장 최근 PCL-5 점수가 33점 이상이면 1, 아니면 0.
    PCL-5 점검이 없으면 None (학습 데이터 제외)"""
    pcl5 = [a for a in payload.get('assessments', []) if a.get('type') == 'pcl5']
    if not pcl5:
        return None
    latest = sorted(pcl5, key=lambda x: x.get('weekBucket', 0))[-1]
    return 1 if latest.get('total', 0) >= 33 else 0


def train_risk_classifier():
    """DB에서 데이터 읽어 분류기 학습 + .pkl 저장 + 캐시 갱신.
    학습 결과 메타데이터 반환."""
    if not SKLEARN_AVAILABLE:
        return {'error': 'scikit-learn not installed'}

    session = Session()
    try:
        rows = session.query(Contribution).filter_by(deleted=False).all()

        X, y = [], []
        for r in rows:
            label = extract_label_from_payload(r.payload)
            if label is None:
                continue
            feat = extract_features_from_payload(r.payload)
            if feat is None:
                continue
            X.append(feat)
            y.append(label)

        n = len(X)
        n_positive = sum(y)

        if n < _CLASSIFIER_MIN_SAMPLES:
            return {
                'trained': False,
                'reason': f'표본 부족 ({n} < {_CLASSIFIER_MIN_SAMPLES})',
                'samples': n,
            }
        if n_positive < _CLASSIFIER_MIN_POSITIVE or (n - n_positive) < _CLASSIFIER_MIN_POSITIVE:
            return {
                'trained': False,
                'reason': f'클래스 불균형 (위험군 {n_positive}, 비위험군 {n - n_positive})',
                'samples': n,
            }

        X = np.array(X)
        y = np.array(y)

        # 표준화
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        # 두 모델 교차검증
        models_to_try = {
            'logistic': LogisticRegression(max_iter=1000, class_weight='balanced'),
            'forest':   RandomForestClassifier(n_estimators=100, class_weight='balanced', random_state=42),
        }

        best_name = None
        best_score = -1
        best_model = None
        cv_folds = min(5, n_positive, n - n_positive)

        for name, model in models_to_try.items():
            try:
                # recall 우선 (기획서 원칙: 고위험군 절대 놓치지 않기)
                scores = cross_val_score(model, X_scaled, y, cv=cv_folds, scoring='recall')
                mean_score = scores.mean()
                if mean_score > best_score:
                    best_score = mean_score
                    best_name = name
                    best_model = model
            except Exception as e:
                app.logger.warning(f'CV failed for {name}: {e}')

        if best_model is None:
            return {'trained': False, 'reason': '모든 모델 학습 실패', 'samples': n}

        # 전체 데이터로 재학습 (배포용)
        best_model.fit(X_scaled, y)

        metadata = {
            'type': best_name,
            'recall': round(float(best_score), 3),
            'samples': n,
            'positive_samples': int(n_positive),
            'trained_at': datetime.utcnow().isoformat(),
        }

        # 디스크에 저장
        with open(_CLASSIFIER_FILE, 'wb') as f:
            pickle.dump({'model': best_model, 'scaler': scaler, 'metadata': metadata}, f)

        # 메모리 캐시 갱신
        _CLASSIFIER_CACHE['model'] = best_model
        _CLASSIFIER_CACHE['scaler'] = scaler
        _CLASSIFIER_CACHE['metadata'] = metadata
        _CLASSIFIER_CACHE['updated_at'] = datetime.utcnow().isoformat()

        app.logger.info(f"[Classifier] {best_name} trained: recall={best_score:.3f}, n={n}")

        return {'trained': True, **metadata}
    except Exception as e:
        app.logger.exception('train_risk_classifier failed')
        return {'trained': False, 'error': str(e)[:200]}
    finally:
        session.close()


def load_classifier_from_disk():
    """서버 시작 시 호출 — 저장된 모델이 있으면 메모리로 로드"""
    if not SKLEARN_AVAILABLE:
        return False
    if not os.path.exists(_CLASSIFIER_FILE):
        return False
    try:
        with open(_CLASSIFIER_FILE, 'rb') as f:
            data = pickle.load(f)
        _CLASSIFIER_CACHE['model'] = data['model']
        _CLASSIFIER_CACHE['scaler'] = data['scaler']
        _CLASSIFIER_CACHE['metadata'] = data['metadata']
        _CLASSIFIER_CACHE['updated_at'] = data['metadata'].get('trained_at')
        app.logger.info(f"[Classifier] loaded from disk: {data['metadata']}")
        return True
    except Exception:
        app.logger.exception('load_classifier_from_disk failed')
        return False


def predict_risk_for_user(user_context):
    """현재 사용자의 컨텍스트로 위험도 예측. 모델 없으면 None.
    user_context 는 프론트가 보낸 ctx (topLexicon, topThemes, lastAssessment 등)에서 추론.

    참고: 프론트가 보내는 컨텍스트엔 timePattern·lexiconHashed가 없어서
    이 함수는 단순화된 프록시 피처만 사용. 정밀하게 하려면 프론트가 더 보내야 함.
    """
    if _CLASSIFIER_CACHE['model'] is None:
        return None

    # 단순화된 피처 — 시간대(현재 시각)로 hour bucket 1개 채움
    hour = datetime.now().hour
    time_feat = [0.0] * 24
    # lastAssessment 가 있으면 그 점수가 약한 시간대 신호
    last = user_context.get('lastAssessment')
    if last:
        pcl5_total = last.get('pcl5Total', 0)
        iesr_total = last.get('iesrTotal', 0)
        risk_level = str(last.get('riskLevel') or '').lower()
        signal = 0
        if risk_level == 'high' or pcl5_total >= 33 or iesr_total >= 33:
            signal = -0.5
        elif risk_level == 'mid':
            signal = -0.25
        time_feat[hour] = signal

    # 카테고리 비중 — topLexicon 길이를 카테고리별 가중치로 (proxy)
    cat_feat = [0.0] * 5  # 사용 가능한 정보 부족, 모두 0

    feat = np.array([time_feat + cat_feat], dtype=np.float32)
    scaler = _CLASSIFIER_CACHE['scaler']
    if scaler is None:
        return None

    try:
        X_scaled = scaler.transform(feat)
        prob = _CLASSIFIER_CACHE['model'].predict_proba(X_scaled)[0][1]
        return float(prob)
    except Exception:
        return None


@app.route('/v1/admin/train', methods=['POST'])
def admin_train():
    """관리자 — 분류기 강제 학습 트리거 (실제 배포 시 인증 필수)"""
    if not SKLEARN_AVAILABLE:
        return jsonify({'error': 'scikit-learn not installed', 'install': 'pip install scikit-learn numpy'}), 503
    result = train_risk_classifier()
    return jsonify(result), 200


@app.route('/v1/admin/classifier', methods=['GET'])
def classifier_status():
    """현재 분류기 상태 조회"""
    return jsonify({
        'sklearn_available':  SKLEARN_AVAILABLE,
        'model_loaded':       _CLASSIFIER_CACHE['model'] is not None,
        'metadata':           _CLASSIFIER_CACHE['metadata'],
        'min_samples':        _CLASSIFIER_MIN_SAMPLES,
    }), 200


@app.route('/v1/respond', methods=['POST'])
def respond():
    """Gemini 응답 생성 — 다층 안전장치 통과 후 반환"""
    if not (GEMINI_AVAILABLE and GEMINI_API_KEY):
        return jsonify({'error': 'gemini-not-configured'}), 503

    data = request.get_json(silent=True) or {}
    user_msg = (data.get('userMessage') or '').strip()
    if not user_msg:
        return jsonify({'error': 'userMessage required'}), 400
    if len(user_msg) > 1000:
        return jsonify({'error': 'message too long'}), 400

    # === 1) 사전 필터: 위기 키워드 즉시 차단 ===
    if is_crisis_input(user_msg):
        # LLM 거치지 않고 즉시 안전 응답 — 프론트가 위기 흐름 진입하도록 신호
        return jsonify({
            'text': '말씀해 주셔서 감사해요. 지금 그런 마음이 드신다면, 혼자 두지 마세요.',
            'crisisDetected': True,
            'source': 'safety-bypass',
        }), 200

    # === 2) Gemini 호출 ===
    try:
        # Safety Settings — 자해·위험 카테고리 강하게 차단
        safety_settings = [
            {'category': 'HARM_CATEGORY_DANGEROUS_CONTENT', 'threshold': 'BLOCK_LOW_AND_ABOVE'},
            {'category': 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'threshold': 'BLOCK_LOW_AND_ABOVE'},
            {'category': 'HARM_CATEGORY_HATE_SPEECH', 'threshold': 'BLOCK_LOW_AND_ABOVE'},
            {'category': 'HARM_CATEGORY_HARASSMENT', 'threshold': 'BLOCK_LOW_AND_ABOVE'},
        ]

        # 시스템 프롬프트에 집단 인사이트 자동 주입 (자기 발전 사이클 - A)
        insights_block = get_collective_insights_block()
        full_system_prompt = ORI_SYSTEM_PROMPT + (insights_block if insights_block else '')

        # 위험도 분류기 추정 (자기 발전 사이클 - B)
        ctx = data.get('context', {}) or {}
        risk_score = predict_risk_for_user(ctx)
        if risk_score is not None and risk_score >= 0.6:
            full_system_prompt += (
                f"\n## 이 사용자의 추정 위험도\n"
                f"분류기 추정 위험도: {risk_score:.2f} (0~1 스케일)\n"
                f"이 사용자는 위험군으로 추정됩니다. 응답에서 더 신중하고, "
                f"전문가 연계 권유의 톤을 자연스럽게 강화하세요. 단정짓는 표현은 금지.\n"
            )

        model = genai.GenerativeModel(
            model_name=GEMINI_MODEL_NAME,
            system_instruction=full_system_prompt,
            safety_settings=safety_settings,
            generation_config={
                'temperature': 0.85,    # 살짝 다양성
                'max_output_tokens': 200,
                'top_p': 0.92,
            },
        )

        prompt = build_user_prompt(data)
        result = model.generate_content(prompt)

        # Safety로 차단됐으면 candidates가 비어있거나 finish_reason이 SAFETY
        if not result.candidates:
            return jsonify({'error': 'blocked-by-safety', 'fallback': True}), 200

        cand = result.candidates[0]
        if hasattr(cand, 'finish_reason') and str(cand.finish_reason) in ('SAFETY', '3'):
            return jsonify({'error': 'blocked-by-safety', 'fallback': True}), 200

        text = (result.text or '').strip()

        # === 3) 사후 필터 ===
        if not text or len(text) < 2:
            return jsonify({'error': 'empty-response', 'fallback': True}), 200

        if is_dangerous_output(text):
            app.logger.warning(f"Dangerous output filtered: {text[:100]}")
            return jsonify({'error': 'dangerous-output', 'fallback': True}), 200

        # 너무 길면 잘라냄 (4문장 초과 방지)
        sentences = re.split(r'(?<=[.!?])\s+', text)
        if len(sentences) > 4:
            text = ' '.join(sentences[:3])

        # 마크다운 잔재 제거
        text = re.sub(r'^[*\-\d]+\.?\s*', '', text)
        text = re.sub(r'\*\*?', '', text)

        return jsonify({
            'text': text,
            'source': 'gemini',
            'model': GEMINI_MODEL_NAME,
            'riskScore':       risk_score,
            'insightsApplied': bool(insights_block),
        }), 200

    except Exception as e:
        app.logger.exception('Gemini call failed')
        # 폴백 신호 — 프론트가 규칙 기반으로 전환
        return jsonify({'error': 'api-error', 'fallback': True, 'detail': str(e)[:200]}), 200


@app.route('/v1/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'time': datetime.utcnow().isoformat(),
        'gemini': bool(GEMINI_AVAILABLE and GEMINI_API_KEY),
        'gemini_model': GEMINI_MODEL_NAME if (GEMINI_AVAILABLE and GEMINI_API_KEY) else None,
        'collective_insights': bool(_INSIGHT_CACHE.get('lines')),
        'insights_updated_at': _INSIGHT_CACHE.get('updated_at'),
        'insights_sample_size': _INSIGHT_CACHE.get('sample_size', 0),
        'classifier':         {
            'sklearn':       SKLEARN_AVAILABLE,
            'loaded':        _CLASSIFIER_CACHE['model'] is not None,
            'metadata':      _CLASSIFIER_CACHE['metadata'],
        },
    }), 200


if __name__ == '__main__':
    # 저장된 분류기가 있으면 메모리로 로드
    if SKLEARN_AVAILABLE:
        load_classifier_from_disk()
    # 개발 모드 — 배포 시 gunicorn/uvicorn + nginx
    app.run(host='0.0.0.0', port=5000, debug=False)
