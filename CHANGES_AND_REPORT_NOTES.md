# 오리(Ori) — 교수님 피드백 반영 작업 내역

> 작업 일자: 2026-05
> 작업 범위: 우선순위 1 ~ 8번 전체 (script.js · backend.py · index.html · style.css · README.md)

---

## 1. 교수님 피드백 요약과 반영 상태

| 피드백 | 반영 위치 | 상태 |
|---|---|---|
| ① 점수 진단 후 고위험/중위험/저위험 위험 평가 | `script.js` · `finishConversationalAssessment` | ✅ 완료 |
| ② 평가 데이터를 채팅 진단에 넘겨 상담 내용 출력 | `script.js` · `buildLLMContext`, `backend.py` · `build_user_prompt` | ✅ 완료 |
| ③ 다수 사용자 사용 가능하도록 홍보 방안 강구 | 보고서 문장 (이 문서 §5) | ✅ 문장 제공 |
| ④ 만족도 조사 추가 | 모달 UI + 저장 + 익명 집계 + 자동 안내 | ✅ 완료 |

---

## 2. 코드 변경 요약 (파일별)

### `script.js` (변경 7곳)

1. **`API_BASE` 환경 자동 판단** (25줄 부근)
   - 로컬 시연(localhost) → 자동으로 `http://localhost:5000`
   - 배포 환경 → 같은 도메인 백엔드 사용 (또는 별도 URL 교체 가능)
   - 백엔드 없으면 자동 규칙 기반 폴백 — 시연 안전망 보존

2. **state 확장** (53줄 부근)
   - `lastAssessmentResult` — 통합 진단 결과 객체
   - `satisfactionLog` — 만족도 평가 로컬 보관
   - `satisfactionPromptCount` — 자동 안내 스팸 방지

3. **`startOnboarding()` 흐름 재구성** (1606줄 부근)
   - 첫 방문자: 자가진단 자동 시작 (위기 우회로 한 개만 보존)
   - 재방문자: 점검 여부 선택지 (재점검/바로 대화/위기)

4. **`finishConversationalAssessment()` 결과 객체 생성** (2086줄 부근)
   - `assessmentHistory.push` 에 `riskLevel`(`'high'|'mid'|'low'`)·`dominantCluster`(`'B'|'C'|'D'|'E'`) 추가
   - `state.lastAssessmentResult` 에 통합 객체 저장:
     ```
     {
       riskLevel, riskLabel,
       displayLabel,     // 기존 UX 문구 보존
       pcl5Total, iesrTotal,
       pcl5Clusters, dominantCluster,
       suggestions, createdAt
     }
     ```

5. **`afterInitialAssessment()` 신규 추가**
   - 위험도별로 다른 안내 출력 후 자유 대화 진입
   - 의학적 진단 표현 금지("위험 신호가 높게 나타남" 정도)
   - 고위험: 1393/1577-0195/112·119 안내 + 안전계획 제안
   - 중위험: 호흡/그라운딩 도구 제안
   - 저위험: 곧장 자유 대화 진입

6. **`buildLLMContext()` 풍부화** (901줄 부근)
   - `riskLevel`, `riskLabel`, `pcl5Total`, `iesrTotal`, `dominantCluster`, `clusters`, `createdAt` 전달

7. **만족도 조사 모듈 신규** (섹션 16.5)
   - `setupSatisfactionModal()` — 별점·칩 핸들러
   - `openSatisfactionModal()` / `submitSatisfaction()` — 평가 제출
   - `maybeOfferSatisfactionPrompt()` — 자유 대화 8턴 이상 시 1회 부드럽게 안내, 위기 모드에서는 절대 안내 X
   - `buildContributionPayload`에 `satisfactionSummary`(평균값·카운트만) 포함 — 개별 코멘트 원문은 절대 서버 전송 X

### `backend.py` (변경 2곳)

1. **`build_user_prompt()` 위험도·군집 반영** (378줄 부근)
   - 신규 형식(`riskLevel` 보유) 우선 처리, 옛 형식 호환 유지
   - 군집 코드 `B/C/D/E` → 한국어 설명("재경험", "회피", "인지·기분의 부정적 변화", "각성·반응성") 변환
   - 위험도별 응답 가이드 1줄을 시스템 프롬프트에 자동 주입

2. **`/v1/contribute`에 `satisfactionSummary` 저장 + `/v1/admin/satisfaction` 신규 엔드포인트**
   - 평균값·카운트만 저장 (개별 코멘트 원문 X)
   - 보고서 작성 시 `curl http://localhost:5000/v1/admin/satisfaction` 으로 집계 조회

### `index.html` (변경 2곳)

1. 사이드 패널 도구 카드에 "만족도 평가" 버튼 추가
2. 만족도 조사 모달(`#satisfaction-modal`) 추가
   - 별점 3개 (도움·편의·재사용 의향, 5단계)
   - 칩 1개 (가장 도움된 기능, 5개 중 단일 선택)
   - 자유 텍스트 코멘트 (선택)
   - 제출 후 감사 화면 → 자동 닫기

### `style.css` (변경 1곳)

- 만족도 조사 모달 전용 스타일 (별점·칩·감사 화면) — 기존 디자인 토큰(`--coral-deep` 등) 재사용

### `README.md` (변경 3곳)

- 4단계 설명 → `API_BASE` 자동 판단 방식으로 업데이트
- 흐름 다이어그램 → 첫 방문 진단 우선·만족도 안내 포함
- 엔드포인트 표에 `/v1/admin/insights`, `/v1/admin/satisfaction` 추가

---

## 3. 새 흐름 요약

```
[첫 방문]
  ↓
간단 안내 (4문장)
  ↓
초기 자가진단 (PCL-5/IES-R 대화형, 6 토픽)
  ↓
점수 산출 → 고위험/중위험/저위험 분류
  ↓
결과 카드 + 위험도별 안내 (afterInitialAssessment)
  ↓
state.lastAssessmentResult 저장
  ↓
자유 대화 시작 — Gemini/규칙 기반 응답이 위험도·군집 정보 반영
  ↓
사용자 메시지 8개 이상 → 만족도 평가 1회 부드럽게 안내
```

---

## 4. 시연 시 동작 확인 시나리오

1. 브라우저 시크릿창에서 `index.html` 열기 → "안녕하세요, 저는 오리예요... 자유롭게 대화하기 전에 먼저 살펴볼게요" → **진단 자동 시작**
2. 진단 진행 → 결과 카드 → 위험도별 안내 → 자유 대화 진입
3. F12 → Network 탭 → `/v1/respond` 요청 → Payload 확인:
   ```json
   "context": {
     "lastAssessment": {
       "riskLevel": "mid",
       "riskLabel": "중위험",
       "pcl5Total": 25,
       "dominantCluster": "C",
       "clusters": { "B": 5, "C": 9, "D": 7, "E": 4 }
     }
   }
   ```
4. 자유 대화 8턴 진행 → "잠깐, 짧은 평가 한 번 부탁드려도 될까요?" 안내
5. 사이드 패널 "만족도 평가" 클릭 → 모달 → 제출 → 감사 화면

---

## 5. 보고서·발표용 문장

### 5-1. 기능 보완 설명 (보고서 본문용)

> 기존에는 사용자가 자유 대화와 자가진단 중 하나를 선택하는 구조였으나, 교수님 피드백을 반영하여 **첫 대화 전 문답식 초기 진단을 자동 수행하는 흐름**으로 개선하였다. 사용자는 6개 토픽의 자연스러운 질문에 답하고, 시스템은 PCL-5(20문항) 및 IES-R(22문항) 기반 점수를 산출해 **고위험·중위험·저위험** 세 단계로 분류한다. 이후 해당 진단 결과를 통합 객체(`lastAssessmentResult`)에 저장하고, 자유 대화 단계에서 챗봇 응답 모듈(Gemini 2.5 Flash 및 규칙 기반 폴백)에 컨텍스트로 전달한다. 그 결과 자유 대화에서도 **사용자의 위험도와 가장 두드러진 PCL-5 증상 군집(B/C/D/E)을 반영한 상담형 피드백**이 출력되도록 설계하였다. 또한 의학적 진단 표현은 모든 단계에서 금지하고, "위험 신호가 높게 나타납니다", "전문가와 연결되는 것이 안전합니다" 등의 표현을 사용해 의료법 회피 원칙을 유지하였다.

### 5-2. 만족도 조사 설명 (보고서 본문용)

> 사용자 경험 개선과 다수 사용자 대상 운영을 위해 **5문항 만족도 조사 기능**을 추가하였다. 별점 형식의 3개 정량 문항(도움 정도·사용 편의성·재사용 의향, 각 5단계)과 가장 도움된 기능(자가진단/상담 응답/기분 기록/위기 연계/안전 계획) 선택, 자유 의견 입력으로 구성된다. 평가는 자유 대화가 일정 턴 이상 진행된 시점에 1회 부드럽게 안내되며, 사이드 패널에서도 언제든 다시 평가할 수 있다. 위기 모드에서는 절대 안내되지 않도록 안전장치를 두었다. 익명 기여에 동의한 사용자의 경우 **평균값과 카운트만** 서버로 전송되며, 개별 코멘트 원문은 사용자 기기 내에만 보관된다. 집계 결과는 `/v1/admin/satisfaction` 엔드포인트로 조회 가능하다.

### 5-3. 홍보 방안 (보고서 본문용)

> 홍보는 **교내 상담센터, 학과 게시판, LMS 공지, 포스터 QR코드**를 중심으로 진행한다. 정신건강 서비스 이용에 대한 심리적 장벽을 낮추기 위해 "**익명 사용 가능**", "**의료 진단이 아닌 정서 지지 도구**", "**필요 시 전문기관 연계**"라는 메시지를 전면에 배치한다. 또한 **초기 진단부터 상담 피드백, 만족도 조사까지 1분 내 체험 가능한 시연형 홍보 방식**을 활용하여 다수 사용자의 접근성을 높인다. 운영 측면에서는 정적 호스팅(Netlify/Vercel) 기반 프론트엔드와 무료 클라우드(Render) 기반 백엔드로 배포하여 별도 인프라 비용 없이 다수 사용자 동시 접속을 지원할 수 있도록 설계하였다.

### 5-4. 위험도별 응답 전략 (보고서 부록용)

| 위험도 | 출력 방향 |
|---|---|
| 고위험 | "위험 신호가 높게 나타납니다." 의학적 진단 금지. 혼자 견디지 말고 전문기관 연결 권유. 1393(자살예방) · 1577-0195(정신건강위기) · 112/119(응급) 안내. 안전계획(Stanley-Brown) 제안. |
| 중위험 | "반복되는 신호가 있어요." 압박 없이 사용자의 속도를 따라가며 호흡·그라운딩·기록을 부드럽게 제안. 일정 기간 후 재점검 안내. |
| 저위험 | "두드러진 고위험 신호는 낮게 보여요." 일상적 정서 지지·자기 친절 강조. 기분 기록과 자유 대화 안내. |

---

## 6. 시연 환경 체크리스트

```
□ Python 3.8+ 설치 확인
□ pip install flask flask-cors sqlalchemy google-generativeai scikit-learn numpy
□ https://aistudio.google.com/apikey 에서 GEMINI_API_KEY 발급 (무료, 신용카드 불필요)
□ 환경변수 설정:
    Windows PowerShell: $env:GEMINI_API_KEY="발급받은_키"
    macOS/Linux:        export GEMINI_API_KEY="발급받은_키"
□ python backend.py 실행 → "[Ori] Gemini 활성화: gemini-2.5-flash" 메시지 확인
□ index.html 브라우저로 열기 → 헤더에 "AI · Gemini" 뱃지 확인
□ 시크릿창에서 새로 열어 초기 진단 자동 시작 확인
□ 8턴 이상 자유 대화로 만족도 안내 자동 트리거 확인
□ 사이드 패널 "만족도 평가" 버튼 동작 확인
□ (선택) curl http://localhost:5000/v1/admin/satisfaction 으로 집계 조회
```

---

## 7. 향후 배포 시 보강 사항

- `API_BASE` 자동 판단 로직에서 배포 환경(다른 도메인) 시 `https://your-backend.onrender.com` 등 실제 백엔드 URL로 교체 (`script.js` 25줄 부근의 빈 문자열 반환 줄 수정)
- CORS 화이트리스트 좁히기 (`backend.py`의 `CORS(app)` 부분)
- HTTPS 강제
- Rate limiting 적용 (IP당 분당 5회)
- SQLite → PostgreSQL 전환
- GEMINI_API_KEY는 환경변수 또는 비밀 관리자(예: Render Secret Files)에만 보관
