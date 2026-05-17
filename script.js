/* =====================================================================
   Ori — 학습형 심리 지지 챗봇
   ---------------------------------------------------------------------
   주요 모듈
   1) State & Storage  - 영구 저장, 학습 데이터 누적
   2) 자가진단 도구    - PCL-5 / IES-R
   3) 위기 감지        - 키워드·맥락·점수 기반 3단계
   4) Personal Lexicon - 사용자 어휘 학습 + 미러링
   5) Insights Engine  - 패턴·트렌드·재점검 알림
   6) 어댑티브 응답    - 학습된 어휘를 사용한 공감 응답
   7) 안전 계획 (Stanley-Brown)
   8) UI 라우팅        - 사이드패널 탭 / 모달
   ===================================================================== */

// =====================================================================
// 1) STATE & STORAGE
// =====================================================================
const STORAGE_KEY = 'ori-state-v2';
const SAFETY_KEY  = 'ori-safety-plan';
const THEME_KEY   = 'ori-theme';
const CONTRIB_KEY = 'ori-contribution-queue';

/* ★ 백엔드 베이스 URL — 환경별 자동 판단
 *  - 로컬 시연(파일 더블클릭 또는 localhost): http://localhost:5000 (별도로 backend.py 실행 필요)
 *  - 배포 환경: 같은 도메인을 사용한다면 '' 그대로,
 *              백엔드가 별도 도메인이면 'https://your-backend.onrender.com' 으로 교체
 *  - 백엔드가 안 떠 있거나 호출 실패 시 자동으로 규칙 기반 폴백으로 전환됨 */
const API_BASE = (() => {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') {
        return 'http://localhost:5000';
    }
    return 'https://ori-hp3l.onrender.com'; // Render 백엔드
})();
const API_RESPOND_URL    = API_BASE ? `${API_BASE}/v1/respond`    : '';
const API_CONTRIBUTE_URL = API_BASE ? `${API_BASE}/v1/contribute` : '';
const API_FORGET_URL     = API_BASE ? `${API_BASE}/v1/contribute/forget` : '';
const DEBUG_DISABLE_AUTO_SATISFACTION = false;
const DAILY_LLM_LIMIT = 50;

const state = {
    /* 대화 흐름 */
    mode: 'daily',              // 'daily' | 'special' | 'crisis'
    flow: 'onboarding',         // 'onboarding' | 'gateway' | 'pcl5' | 'iesr' | 'idle'
    awaitingInput: false,

    /* 학습 / 데이터 기여 설정 */
    learningEnabled: true,      // 로컬 개인화 학습 (기기 안에서만)
    contributionEnabled: false, // 익명 데이터 기여 (서버로 전송) — 명시적 옵트인 필요
    anonymousId: null,          // 난수 기반 익명 ID (재식별 불가)

    /* 자가진단 진행 상태 */
    assessment: { type: null, index: 0, answers: [], startedAt: null },

    /* 누적 데이터 */
    history: [],                // {role, text, ts, sentiment?}
    moodLog: [],                // {score(1-10), note, ts, source}
    lexicon: {                  // 감정 카테고리별 단어 빈도
        sad: {}, anxious: {}, angry: {}, tired: {},
        positive: {}, neutral: {},
    },
    nounFrequency: {},          // 일반 명사·핵심 단어 빈도 (트리거 후보)
    timePattern: Array(24).fill(null).map(() => ({ count: 0, mood: 0 })),
    assessmentHistory: [],      // {type, total, ts, clusters?, riskLevel?, dominantCluster?}
    lastAssessmentResult: null, // {riskLevel, riskLabel, pcl5Total, iesrTotal, pcl5Clusters, dominantCluster, ...}
    satisfactionLog: [],        // [{helpfulness, ease, reuseIntent, bestFeature, comment, ts}]
    satisfactionPromptCount: 0, // 자동 안내를 한 횟수 (스팸 방지)
    dailyModeStartedAt: null,   // 자유 대화 모드 진입 시각
    dailyUserTurns: 0,          // 자유 대화 모드 사용자 메시지 수
    autoAssessmentSuppressed: false, // "바로 이야기" 선택 후 자동 점검 제안 차단
    llmUsage: { date: '', count: 0 },
    sessionCount: 0,
    lastSession: null,

    /* 맥락 메모리 (Episodic Memory) — 다음 세션에 호출 */
    entityMemory: {},           // { '회사': { count, lastSeen, sentiments: {sad:3,...} } }
    themeMemory: {},            // { 'sleep_difficulty': { count, lastSeen } }
    episodicLog: [],            // [{ ts, summary, topThemes, topEntities }]
    sessionBuffer: {            // 현재 세션 동안 임시 누적, 세션 종료 시 episodicLog로 flush
        entitiesSeen: {},
        themesSeen: {},
        startedAt: null,
    },

    /* 마지막 서버 동기화 시각 */
    lastSyncAt: null,
};

function saveState() {
    try {
        const persisted = {
            mode: state.mode,
            history: state.history.slice(-100),
            moodLog: state.moodLog.slice(-200),
            lexicon: state.lexicon,
            nounFrequency: state.nounFrequency,
            timePattern: state.timePattern,
            assessmentHistory: state.assessmentHistory,
            lastAssessmentResult: state.lastAssessmentResult,
            satisfactionLog: state.satisfactionLog,
            satisfactionPromptCount: state.satisfactionPromptCount,
            dailyModeStartedAt: state.dailyModeStartedAt,
            dailyUserTurns: state.dailyUserTurns,
            autoAssessmentSuppressed: state.autoAssessmentSuppressed,
            llmUsage: state.llmUsage,
            sessionCount: state.sessionCount,
            lastSession: state.lastSession,
            learningEnabled: state.learningEnabled,
            contributionEnabled: state.contributionEnabled,
            anonymousId: state.anonymousId,
            lastSyncAt: state.lastSyncAt,
            entityMemory: state.entityMemory,
            themeMemory: state.themeMemory,
            episodicLog: state.episodicLog.slice(-50),  // 최근 50회만
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (e) { /* private mode 등 */ }
}
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        Object.assign(state, data);
        // 누락 필드 보정
        if (!state.lexicon) state.lexicon = { sad:{}, anxious:{}, angry:{}, tired:{}, positive:{}, neutral:{} };
        if (!state.nounFrequency) state.nounFrequency = {};
        if (!state.timePattern || state.timePattern.length !== 24)
            state.timePattern = Array(24).fill(null).map(() => ({ count:0, mood:0 }));
        if (!state.assessmentHistory) state.assessmentHistory = [];
        if (!Array.isArray(state.satisfactionLog)) state.satisfactionLog = [];
        if (typeof state.satisfactionPromptCount !== 'number') state.satisfactionPromptCount = 0;
        if (typeof state.dailyUserTurns !== 'number') state.dailyUserTurns = 0;
        if (typeof state.autoAssessmentSuppressed !== 'boolean') state.autoAssessmentSuppressed = false;
        if (!state.llmUsage) state.llmUsage = { date: '', count: 0 };
        if (!state.entityMemory) state.entityMemory = {};
        if (!state.themeMemory) state.themeMemory = {};
        if (!state.episodicLog) state.episodicLog = [];
        // sessionBuffer는 부팅마다 새로 시작
        state.sessionBuffer = { entitiesSeen: {}, themesSeen: {}, startedAt: Date.now() };
    } catch (e) { /* ignore */ }
}

function clearAllData() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SAFETY_KEY);
    localStorage.removeItem(CONTRIB_KEY);
    location.reload();
}

// =====================================================================
// 1.5) DATA CONTRIBUTION PIPELINE — 익명 데이터 서버 전송
// ---------------------------------------------------------------------
// 정책
// · 명시적 옵트인이 있어야만 작동 (state.contributionEnabled === true)
// · 대화 원문, 안전 계획 내용, 노트는 절대 전송하지 않음
// · 단어는 SHA-256 해시 후 처음 8자리만 (재식별 불가, 빈도 분포만 학습 가능)
// · 익명 ID는 난수 기반 (브라우저 fingerprint 미사용)
// · 큐에 쌓고 일정 주기로 배치 전송 (오프라인/실패 시 재시도)
// · 사용자가 옵트아웃하면 큐 비우고 서버에 삭제 요청 가능
// =====================================================================

/** 난수 기반 익명 ID 생성 */
function ensureAnonymousId() {
    if (state.anonymousId) return state.anonymousId;
    const arr = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    state.anonymousId = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    saveState();
    return state.anonymousId;
}

/** 짧은 SHA-256 해시 (단어를 식별 불가능한 토큰으로 변환) */
async function shortHash(text) {
    if (!window.crypto || !window.crypto.subtle) {
        // 폴백: 매우 단순한 해시 (실제 배포 시는 crypto.subtle 보장됨)
        let h = 0;
        for (let i = 0; i < text.length; i++) {
            h = (h * 31 + text.charCodeAt(i)) | 0;
        }
        return ('00000000' + (h >>> 0).toString(16)).slice(-8);
    }
    const buf = new TextEncoder().encode(text);
    const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf)).slice(0, 4)
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 현재 상태에서 서버로 보낼 익명 스냅샷 생성 */
async function buildContributionPayload() {
    // 1) 감정 카테고리 분포 (단어는 해시화)
    const lexiconHashed = {};
    for (const [cat, words] of Object.entries(state.lexicon)) {
        lexiconHashed[cat] = {};
        for (const [word, count] of Object.entries(words)) {
            const h = await shortHash(word);
            lexiconHashed[cat][h] = count;
        }
    }

    // 2) 시간대 패턴 (이미 집계된 형태)
    const timePattern = state.timePattern.map(s => ({
        count: s.count,
        moodAvg: Number(s.mood.toFixed(2)),
    }));

    // 3) 자가점검 이력 (점수만)
    const assessments = state.assessmentHistory.map(a => ({
        type: a.type,
        total: a.total,
        clusters: a.clusters || null,
        level: a.level,
        // 시각은 시간대(시 단위)만 — 정확한 timestamp는 보내지 않음
        hour: new Date(a.ts).getHours(),
        // 일자는 7일 단위로 버킷팅 (재식별 위험 감소)
        weekBucket: Math.floor(a.ts / (7 * 24 * 60 * 60 * 1000)),
    }));

    // 4) 기분 기록 분포 (점수만)
    const moodDist = Array(10).fill(0);
    state.moodLog.forEach(m => {
        if (m.score >= 1 && m.score <= 10) moodDist[m.score - 1]++;
    });

    // 5) 만족도 조사 집계 (개별 응답 원문 X, 평균/카운트만)
    let satisfactionSummary = null;
    if (state.satisfactionLog && state.satisfactionLog.length > 0) {
        const N = state.satisfactionLog.length;
        const sum = (k) => state.satisfactionLog.reduce((s, r) => s + (r[k] || 0), 0);
        const bestCounts = {};
        state.satisfactionLog.forEach(r => {
            if (r.bestFeature) bestCounts[r.bestFeature] = (bestCounts[r.bestFeature] || 0) + 1;
        });
        satisfactionSummary = {
            count: N,
            avgHelpfulness: Number((sum('helpfulness') / N).toFixed(2)),
            avgEase:        Number((sum('ease') / N).toFixed(2)),
            avgReuseIntent: Number((sum('reuseIntent') / N).toFixed(2)),
            bestFeatureCounts: bestCounts,
        };
    }

    return {
        anonymousId: ensureAnonymousId(),
        clientVersion: 'ori-web-v0.3',
        snapshotAt: Date.now(),
        sessionCount: state.sessionCount,
        lexiconHashed,
        timePattern,
        assessments,
        moodDist,
        satisfactionSummary,
    };
}

/** 큐에 추가 + 전송 시도 */
async function contributeData() {
    if (!state.contributionEnabled) return false;

    const payload = await buildContributionPayload();

    // 큐에 저장 (전송 실패 시 다음 기회에 재시도)
    let queue = [];
    try {
        const raw = localStorage.getItem(CONTRIB_KEY);
        queue = raw ? JSON.parse(raw) : [];
    } catch (e) { queue = []; }
    queue.push(payload);
    queue = queue.slice(-5); // 최대 5개만 유지
    localStorage.setItem(CONTRIB_KEY, JSON.stringify(queue));

    // 엔드포인트가 설정되어 있으면 전송 시도
    if (!API_CONTRIBUTE_URL) {
        updateContributionStatus('endpoint-missing');
        return false;
    }

    try {
        const res = await fetch(API_CONTRIBUTE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: queue }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 성공 시 큐 비우고 동기화 시각 기록
        localStorage.removeItem(CONTRIB_KEY);
        state.lastSyncAt = Date.now();
        saveState();
        updateContributionStatus('synced');
        return true;
    } catch (err) {
        updateContributionStatus('error');
        console.warn('[Ori] 기여 전송 실패 — 다음 기회에 재시도:', err);
        return false;
    }
}

/** 서버에 내 기여분 삭제 요청 (옵트아웃 시) */
async function requestServerDeletion() {
    if (!state.anonymousId || !API_FORGET_URL) return;
    try {
        await fetch(API_FORGET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anonymousId: state.anonymousId }),
        });
    } catch (e) { /* ignore */ }
}

/** UI 상태 라벨 */
function updateContributionStatus(state_key) {
    const el = document.getElementById('contribution-status');
    if (!el) return;
    el.classList.remove('active', 'error');
    if (!state.contributionEnabled) {
        el.textContent = '아직 기여하지 않는 중 · 옵트인 필요';
        return;
    }
    if (state_key === 'synced') {
        el.classList.add('active');
        el.textContent = `방금 전 익명 기여 완료 ✓`;
    } else if (state_key === 'endpoint-missing') {
        el.textContent = '기여 옵트인 됨 · 서버 미연결 (큐에 저장 중)';
    } else if (state_key === 'error') {
        el.classList.add('error');
        el.textContent = '연결 실패 · 큐에 저장됨, 다음 기회에 재시도';
    } else {
        el.classList.add('active');
        el.textContent = state.lastSyncAt
            ? `마지막 기여 ${new Date(state.lastSyncAt).toLocaleString('ko-KR')}`
            : '기여 활성화됨';
    }
}

// =====================================================================
// 2) 자가진단 — PCL-5 / IES-R
// =====================================================================
const PCL5 = {
    id: 'pcl5', name: 'PCL-5',
    title: '외상 후 스트레스 자가 점검',
    intro: '지난 한 달 동안 그 일을 떠올렸을 때 다음 일들로 얼마나 힘드셨는지 답해 주세요. 정답은 없어요.',
    cutoff: 33,
    items: [
        '그 일에 대한 반복적이고 고통스러운 기억이 떠올랐다',
        '그 일에 대한 반복적이고 고통스러운 꿈을 꿨다',
        '그 일이 지금 다시 일어나는 것처럼 갑자기 느끼거나 행동했다',
        '그 일을 떠올리게 하는 무언가가 있을 때 매우 속상해졌다',
        '그 일을 떠올리게 할 때 심장이 뛰거나 숨이 가빠지는 등 신체 반응이 있었다',
        '그 일과 관련된 기억·생각·감정을 피하려고 노력했다',
        '그 일을 떠올리게 하는 사람·장소·대화·활동·사물·상황을 피하려 했다',
        '그 일의 중요한 부분을 기억하기 어려웠다',
        '나 자신·다른 사람·세상에 대해 강한 부정적 생각이 들었다',
        '그 일이나 그 이후 일어난 일에 대해 자신이나 누군가를 비난했다',
        '두려움·공포·분노·죄책감·수치심 같은 강한 부정적 감정을 느꼈다',
        '예전에 즐기던 활동에 흥미를 잃었다',
        '다른 사람들과 멀어지거나 단절된 느낌이 들었다',
        '행복·사랑 같은 긍정적 감정을 느끼기 어려웠다',
        '짜증을 내거나 화를 폭발시키거나 공격적으로 행동했다',
        '위험을 무릅쓰거나 자신을 해칠 수 있는 일을 했다',
        '지나치게 경계하거나 망보듯 주변을 살폈다',
        '깜짝깜짝 잘 놀랐다',
        '집중하기 어려웠다',
        '잠들거나 잠을 유지하기 어려웠다',
    ],
    clusters: { B:[0,1,2,3,4], C:[5,6], D:[7,8,9,10,11,12,13], E:[14,15,16,17,18,19] },
};

const IESR = {
    id: 'iesr', name: 'IES-R',
    title: '사건 영향 척도',
    intro: '지난 일주일 동안 그 일에 대해 다음과 같이 느낀 적이 얼마나 자주 있었는지 답해 주세요.',
    cutoff: 33,
    items: [
        '무언가 그 일을 떠올리면 그때 느낌이 다시 살아났다',
        '잠을 깊이 자는 데 어려움이 있었다',
        '다른 일들이 자꾸 그 일을 생각나게 했다',
        '짜증이 나고 화가 났다',
        '그 일이 떠오르거나 생각날 때 마음이 흔들리지 않으려 애썼다',
        '의도하지 않았는데도 그 일이 떠올랐다',
        '그 일이 일어나지 않은 듯, 현실이 아닌 듯 느꼈다',
        '그 일을 떠올리게 하는 것을 멀리했다',
        '그 일의 장면이 머릿속에 갑자기 떠올랐다',
        '깜짝 놀라거나 쉽게 흥분했다',
        '그 일에 대해 생각하지 않으려 노력했다',
        '그 일에 대한 감정이 많이 남아 있다는 걸 알면서도 모른 척했다',
        '그 일에 대한 감정이 무뎌진 것 같았다',
        '마치 그 시간으로 돌아간 듯 행동하거나 느꼈다',
        '잠들기 어려웠다',
        '그 일에 대한 강한 감정이 파도처럼 몰려왔다',
        '그 일을 기억에서 지우려 했다',
        '집중하기 어려웠다',
        '그 일을 떠올리면 땀·숨가쁨·메스꺼움·심장 두근거림 같은 신체 반응이 있었다',
        '그 일에 대한 꿈을 꿨다',
        '경계하고 조심스러웠다',
        '그 일에 대해 이야기하지 않으려 했다',
    ],
};

const SCALE_LABELS = [
    { num: 0, label: '전혀'   },
    { num: 1, label: '약간'   },
    { num: 2, label: '중간'   },
    { num: 3, label: '상당히' },
    { num: 4, label: '극심'   },
];

// =====================================================================
// 3) 위기 감지
// =====================================================================
const CRISIS_PATTERNS = {
    high: [
        /자살/, /죽고\s*싶/, /죽어\s*버리/, /목매/, /투신/, /자해/,
        /살\s*가치\s*없/, /사라지고\s*싶/, /끝내고\s*싶/,
    ],
    medium: [
        /살기\s*싫/, /의미\s*없/, /희망\s*없/, /버틸\s*수\s*없/,
        /너무\s*힘들/, /무너질/, /숨이\s*막/,
    ],
    trauma: [
        /사고/, /재난/, /지진/, /화재/, /폭행/, /성폭/, /학대/,
        /참사/, /이태원/, /세월호/, /산재/, /순직/,
        /악몽/, /플래시\s*백/, /과각성/,
    ],
};
function detectCrisisLevel(text) {
    if (!text) return null;
    if (CRISIS_PATTERNS.high.some(rx => rx.test(text)))   return 'high';
    if (CRISIS_PATTERNS.medium.some(rx => rx.test(text))) return 'medium';
    if (CRISIS_PATTERNS.trauma.some(rx => rx.test(text))) return 'trauma';
    return null;
}

// =====================================================================
// 4) PERSONAL LEXICON — 사용자 어휘 학습
// =====================================================================
const STOPWORDS = new Set([
    '이','가','은','는','을','를','의','에','에서','으로','로','와','과','도','만','부터','까지',
    '이런','그런','저런','이렇게','그렇게','저렇게','이거','그거','저거',
    '있다','없다','하다','되다','이다','아니다','같다','보다',
    '제가','내가','나는','저는','너무','정말','진짜','그냥','약간','조금','계속',
    '오늘','어제','요즘','지금','이번','다음','오랫동안',
    '있어요','없어요','해요','돼요','이에요','예요','이야','거야','거예요',
    '아침','점심','저녁','밤','새벽',
]);

const SENTIMENT_KEYWORDS = {
    sad:      [/슬프/, /울고/, /눈물/, /쓸쓸/, /외로/, /허무/, /상실/, /보고\s*싶/],
    anxious:  [/불안/, /초조/, /두렵/, /무섭/, /걱정/, /떨려/, /공포/, /긴장/],
    angry:    [/화가/, /짜증/, /분노/, /억울/, /미워/, /열받/],
    tired:    [/피곤/, /지쳐/, /무기력/, /기운\s*없/, /잠\s*못/, /힘들/, /버겁/],
    positive: [/좋/, /기쁘/, /감사/, /행복/, /괜찮/, /나아져/, /평온/, /따뜻/],
};

function classifySentiment(text) {
    for (const [cat, patterns] of Object.entries(SENTIMENT_KEYWORDS)) {
        if (patterns.some(rx => rx.test(text))) return cat;
    }
    return 'neutral';
}

/** 한국어 텍스트에서 의미있는 단어 추출 (간이 토크나이저)
 *  - 공백/구두점 분리
 *  - 한국어 어미 일부 제거
 *  - 2자 이상, 불용어 제외 */
function tokenize(text) {
    if (!text) return [];
    const cleaned = text
        .replace(/[.,!?…~"'()[\]{}<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const tokens = cleaned.split(/\s+/);
    const result = [];
    for (let t of tokens) {
        // 흔한 조사·어미 한 번 제거
        t = t.replace(/(이에요|예요|이야|어요|아요|에요|네요|군요|거든요|거예요|구나|더라|었다|였다|에서|으로|에게|한테|에는|에서는|이라고|라고)$/, '');
        t = t.replace(/(은|는|이|가|을|를|의|와|과|도|만|에|로)$/, '');
        if (t.length < 2) continue;
        if (STOPWORDS.has(t)) continue;
        if (/^[0-9]+$/.test(t)) continue;
        result.push(t);
    }
    return result;
}

/** 사용자 메시지에서 어휘 학습 */
function learnFromMessage(text, sentiment) {
    if (!state.learningEnabled) return;

    const tokens = tokenize(text);
    const cat = sentiment || 'neutral';

    tokens.forEach(t => {
        // 카테고리별 lexicon
        state.lexicon[cat][t] = (state.lexicon[cat][t] || 0) + 1;
        // 전체 명사 빈도 (트리거/주제 추적)
        state.nounFrequency[t] = (state.nounFrequency[t] || 0) + 1;
    });

    // 시간대 패턴
    const hour = new Date().getHours();
    const slot = state.timePattern[hour];
    slot.count += 1;
    const moodDelta = ['sad','anxious','angry','tired'].includes(cat) ? -1
                    : (cat === 'positive' ? 1 : 0);
    slot.mood = (slot.mood * (slot.count - 1) + moodDelta) / slot.count;

    // 메모리 추출 — 엔티티·테마
    extractMemorySignals(text, cat);
}

/** 학습된 어휘에서 사용자가 자주 쓰는 단어를 가져와 응답에 자연스럽게 반영 */
function getMirrorWord(category) {
    const words = state.lexicon[category];
    if (!words) return null;
    const entries = Object.entries(words).filter(([w, c]) => c >= 2);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

// =====================================================================
// 4.5) MEMORY EXTRACTION — 엔티티·테마 누적
// ---------------------------------------------------------------------
// 사용자가 반복적으로 언급하는 사람·장소·사건과 주제를 추출해 누적.
// 다음 세션에 봇이 "지난번에 말씀하신 ○○은 어떠세요?" 처럼 호출.
// =====================================================================

/** 의미있는 엔티티 후보 (사람·장소·사건 단어)
 *  한국어는 형태소 분석이 까다로워서, 사전 + 문맥 기반 휴리스틱 사용 */
const ENTITY_DICTIONARY = {
    // 사람 관계
    person: [
        '엄마','어머니','아빠','아버지','부모','부모님',
        '형','오빠','누나','언니','동생',
        '남편','아내','와이프','애인','남자친구','여자친구','연인',
        '친구','동료','상사','선생님','후배','선배',
        '아들','딸','자식','아이',
    ],
    // 장소·환경
    place: [
        '회사','직장','학교','집','병원','교회','센터',
        '방','부엌','거실','화장실',
    ],
    // 사건·시점
    event: [
        '사고','사건','일','그날','그때',
        '면접','시험','발표','수술','장례식','결혼식','이별','이혼',
    ],
    // 신체·증상
    body: [
        '잠','수면','악몽','심장','숨','머리','가슴','목',
    ],
};

/** 테마 패턴 — 키워드 조합으로 더 큰 주제 식별 */
const THEME_PATTERNS = {
    sleep_difficulty:    { match: /(잠.*못|불면|악몽|뒤척|자다.*깨)/, label: '수면 어려움' },
    work_stress:         { match: /(회사.*힘들|상사|직장.*스트레스|업무|야근|퇴근.*못)/, label: '직장 스트레스' },
    family_conflict:     { match: /(부모.*싸|엄마.*싸|아빠.*싸|가족.*문제|집안)/, label: '가족 갈등' },
    relationship_loss:   { match: /(헤어졌|이별|이혼|떠나|연인.*없)/, label: '관계 상실' },
    self_blame:          { match: /(내\s*탓|자책|죄책|후회|내가\s*잘못)/, label: '자책감' },
    isolation:           { match: /(혼자|아무도|외롭|연락\s*안|만날\s*사람)/, label: '고립감' },
    grief:               { match: /(돌아가|죽었|장례|보고\s*싶|그리워)/, label: '상실의 슬픔' },
    physical_anxiety:    { match: /(심장.*뛰|숨이\s*막|어지러|손.*떨)/, label: '신체 불안' },
};

/** 사용자 메시지에서 엔티티와 테마 추출 */
function extractMemorySignals(text, sentiment) {
    if (!text) return;
    const now = Date.now();

    // 1) 엔티티 — 사전 단어가 텍스트에 등장하면 카운트
    for (const [type, words] of Object.entries(ENTITY_DICTIONARY)) {
        for (const w of words) {
            // 단어 경계 — 한국어는 정확 매칭이 안전
            if (text.includes(w)) {
                if (!state.entityMemory[w]) {
                    state.entityMemory[w] = {
                        type,
                        count: 0,
                        firstSeen: now,
                        lastSeen: now,
                        sentiments: { sad:0, anxious:0, angry:0, tired:0, positive:0, neutral:0 },
                    };
                }
                const e = state.entityMemory[w];
                e.count += 1;
                e.lastSeen = now;
                e.sentiments[sentiment] = (e.sentiments[sentiment] || 0) + 1;

                // 세션 버퍼에도 누적
                state.sessionBuffer.entitiesSeen[w] = (state.sessionBuffer.entitiesSeen[w] || 0) + 1;
            }
        }
    }

    // 2) 테마 — 정규식 매칭
    for (const [key, theme] of Object.entries(THEME_PATTERNS)) {
        if (theme.match.test(text)) {
            if (!state.themeMemory[key]) {
                state.themeMemory[key] = {
                    label: theme.label,
                    count: 0,
                    firstSeen: now,
                    lastSeen: now,
                };
            }
            const t = state.themeMemory[key];
            t.count += 1;
            t.lastSeen = now;
            state.sessionBuffer.themesSeen[key] = (state.sessionBuffer.themesSeen[key] || 0) + 1;
        }
    }
}

/** 세션 종료 시 호출 — 이번 세션의 핵심 엔티티·테마를 episodicLog에 한 줄 요약으로 저장 */
function flushSessionToEpisodic() {
    const buf = state.sessionBuffer;
    const hasContent = Object.keys(buf.entitiesSeen).length > 0 || Object.keys(buf.themesSeen).length > 0;
    if (!hasContent) return;

    // 가장 많이 등장한 엔티티 3개, 테마 2개
    const topEntities = Object.entries(buf.entitiesSeen)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    const topThemes = Object.entries(buf.themesSeen)
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);

    state.episodicLog.push({
        ts: Date.now(),
        startedAt: buf.startedAt,
        topEntities,
        topThemes,
    });

    // 세션 버퍼 리셋
    state.sessionBuffer = { entitiesSeen: {}, themesSeen: {}, startedAt: Date.now() };
    saveState();
}

/** 재방문 시 호출할 만한 메모리 후보 찾기
 *  반환: { type: 'entity'|'theme', key, label, lastSeen, daysAgo } | null */
function findMemoryCallback() {
    const now = Date.now();

    // 후보 1: 최근 episodicLog에서 자주 등장한 테마
    if (state.episodicLog.length >= 2) {
        const recentLogs = state.episodicLog.slice(-5);
        const themeFreq = {};
        recentLogs.forEach(log => {
            (log.topThemes || []).forEach(t => {
                themeFreq[t] = (themeFreq[t] || 0) + 1;
            });
        });
        // 2번 이상 등장한 테마
        const recurringThemes = Object.entries(themeFreq).filter(([_, c]) => c >= 2);
        if (recurringThemes.length > 0) {
            recurringThemes.sort((a, b) => b[1] - a[1]);
            const [themeKey] = recurringThemes[0];
            const theme = state.themeMemory[themeKey];
            if (theme) {
                return {
                    type: 'theme',
                    key: themeKey,
                    label: theme.label,
                    daysAgo: Math.floor((now - theme.lastSeen) / (24*60*60*1000)),
                };
            }
        }
    }

    // 후보 2: 자주 등장한 엔티티 (3회 이상, 최근 30일 내)
    const recentEntities = Object.entries(state.entityMemory)
        .filter(([_, e]) => e.count >= 3 && (now - e.lastSeen) < 30*24*60*60*1000)
        .sort((a, b) => b[1].count - a[1].count);

    if (recentEntities.length > 0) {
        const [key, ent] = recentEntities[0];
        return {
            type: 'entity',
            key,
            label: key,
            entityType: ent.type,
            daysAgo: Math.floor((now - ent.lastSeen) / (24*60*60*1000)),
        };
    }

    return null;
}

// =====================================================================
// 5) 어댑티브 공감 응답 — Conversational Response Engine
// ---------------------------------------------------------------------
// 봇이 매 턴마다 4가지 행동(action) 중 하나를 골라 응답:
//   · ack       — 짧은 인정 ("그렇군요.", "네…")
//   · empathize — 공감 응답 (1~2문장)
//   · label     — 감정 라벨링 ("외로우셨던 거네요")
//   · invite    — 질문으로 이어가기
// 길이·타이핑 시간·반복 회피·미러링·턴 기억을 통합 처리.
// =====================================================================

/** 응답 풀 — 행동(action) × 감정(sentiment) 조합 */
const RESPONSE_POOLS = {
    ack: {
        sad:      ['네…', '그러셨군요.', '음…', '그랬구나.'],
        anxious:  ['네…', '그렇군요.', '아…'],
        angry:    ['네.', '음…', '그러셨겠어요.'],
        tired:    ['네…', '아…', '그랬구나.'],
        neutral:  ['네.', '그렇군요.', '음.'],
        positive: ['아, 네!', '그러셨군요.', '음…'],
    },
    empathize: {
        sad: [
            '많이 힘드셨겠어요. 그 마음을 꺼내 주신 것만으로도 큰 용기예요.',
            '지금 그렇게 느끼시는 게 당연해요. 충분히 그럴 만한 이유가 있을 거예요.',
            '혼자 안고 계셨던 무게가 어느 정도였을지 가늠이 돼요.',
            '그 마음, 같이 있어 드릴게요.',
            '말씀하시면서도 마음이 무거우셨을 것 같아요.',
        ],
        anxious: [
            '불안한 마음이 가슴을 누르는 느낌이실 것 같아요.',
            '예측할 수 없는 상황이 계속되면 누구나 그렇게 돼요.',
            '몸이 먼저 긴장하는 게 느껴지셨을 것 같아요.',
            '그 마음, 충분히 이해돼요.',
        ],
        angry: [
            '화가 나는 건 무언가 중요한 게 다쳤다는 신호예요.',
            '그렇게 느끼실 만해요. 그 감정을 부정하지 않으셔도 돼요.',
            '그 일이 정말 부당하게 느껴지셨겠어요.',
        ],
        tired: [
            '지치셨군요. 오늘은 더 이상 애쓰지 않아도 돼요.',
            '계속 버텨오신 것만으로도 충분해요.',
            '잠시 멈추는 것도 회복의 일부예요.',
            '몸이 보내는 신호일 수도 있어요.',
        ],
        neutral: [
            '그러셨군요.',
            '들었어요.',
            '말씀해 주셔서 감사해요.',
        ],
        positive: [
            '그 이야기 듣고 저도 마음이 한결 가벼워져요.',
            '오늘 그런 일이 있으셨다니, 작지만 단단한 빛 같네요.',
            '그 순간을 좀 더 머금고 계셔도 좋겠어요.',
        ],
    },
    /** 감정 라벨링 — 사용자 감정을 한 단어로 짚어주기 (Linehan 스타일) */
    label: {
        sad:      ['많이 슬프셨던 거네요.', '외로우셨던 것 같아요.', '많이 그리우셨던 거죠.'],
        anxious:  ['많이 두려우셨겠어요.', '계속 긴장하셨던 거네요.', '불안하셨던 거죠.'],
        angry:    ['많이 분하셨겠어요.', '억울하셨던 거네요.', '화가 많이 나셨겠어요.'],
        tired:    ['진이 빠지셨던 거네요.', '많이 소진되셨던 것 같아요.', '버겁게 느끼셨겠어요.'],
        neutral:  null,
        positive: ['뿌듯하셨던 거네요.', '안심이 되셨겠어요.'],
    },
    /** 이어가는 질문 — 너무 추궁하지 않게 부드럽게 */
    invite: {
        sad:      ['더 들려주실 수 있어요?', '어떤 순간이 가장 힘드셨어요?', '그때 어떤 생각이 드셨어요?'],
        anxious:  ['언제 가장 그렇게 느끼세요?', '몸은 어떻게 반응하나요?', '뭐가 가장 걱정되세요?'],
        angry:    ['어떤 일이 있었어요?', '그분께 가장 하고 싶은 말이 뭐예요?'],
        tired:    ['요즘 잠은 어떠세요?', '오늘 하루 중 그래도 견딜 만했던 순간이 있었어요?'],
        neutral:  ['조금 더 이야기해 주시겠어요?', '어떤 마음이셨어요?', '천천히 들려주세요.'],
        positive: ['뭐가 그렇게 좋게 만들었어요?', '그 순간 어떤 기분이셨어요?'],
    },
};

/** 학습된 사용자 어휘를 자연스럽게 인용하는 미러링 표현 */
const MIRROR_PHRASES = {
    sad:     (w) => `'${w}'… 그 단어가 마음에 오래 남아 있는 것 같아요.`,
    anxious: (w) => `'${w}' 생각이 자꾸 떠오르세요?`,
    angry:   (w) => `'${w}' 그 부분이 마음에 걸리시는 것 같아요.`,
    tired:   (w) => `'${w}'이라는 말이 무겁게 들려요.`,
    positive:(w) => `'${w}'… 그 느낌이 오래 머물길 바라요.`,
    neutral: (w) => null,
};

/** 사용자 메시지의 핵심 명사 1개 골라내기 (직전 턴 받아치기용) */
function pickEchoWord(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return null;
    // 의미 있는 단어(2자 이상, 빈도 높은 명사) 우선
    const meaningful = tokens.filter(t => t.length >= 2 && state.nounFrequency[t] >= 1);
    if (meaningful.length === 0) return tokens[0];
    return meaningful[Math.floor(Math.random() * meaningful.length)];
}

/** 최근 봇 응답 추적 — 같은 표현 반복 회피 */
const recentResponses = []; // 최근 4개

function pickFromPool(pool, sentiment) {
    const arr = pool[sentiment];
    if (!arr || arr.length === 0) return null;
    // 최근에 안 쓴 것 우선
    const fresh = arr.filter(s => !recentResponses.includes(s));
    const candidates = fresh.length > 0 ? fresh : arr;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function trackResponse(text) {
    if (!text) return;
    recentResponses.push(text);
    if (recentResponses.length > 4) recentResponses.shift();
}

/**
 * 다음 봇 행동 결정 — 가중치 기반 랜덤 선택.
 * 같은 행동 연속 방지, 무거운 감정엔 ack/label 비중↑
 */
function decideAction(sentiment, conversationContext) {
    const { recentActions, userMsgLength, hasMirrorWord } = conversationContext;
    const lastAction = recentActions[recentActions.length - 1];

    // 짧은 사용자 입력엔 짧은 응답 (ack 비중↑)
    if (userMsgLength < 10) {
        return weighted([
            ['ack', 0.45],
            ['empathize', 0.25],
            ['invite', 0.30],
        ], lastAction);
    }

    // 무거운 감정(sad, anxious, tired)엔 label 비중 추가
    if (['sad','anxious','tired'].includes(sentiment)) {
        return weighted([
            ['empathize', 0.40],
            ['label',     0.25],
            ['invite',    0.20],
            ['ack',       0.15],
        ], lastAction);
    }

    // 분노/긍정/중립
    return weighted([
        ['empathize', 0.40],
        ['invite',    0.30],
        ['ack',       0.15],
        ['label',     0.15],
    ], lastAction);
}

/** 가중치 기반 랜덤 + 직전 행동 회피 (같은 행동 연속 시 가중치 절반) */
function weighted(options, avoidAction) {
    const adjusted = options.map(([k, w]) => [k, k === avoidAction ? w * 0.4 : w]);
    const total = adjusted.reduce((s, [_, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of adjusted) {
        r -= w;
        if (r <= 0) return k;
    }
    return adjusted[0][0];
}

const recentActions = []; // 최근 봇 행동 추적
function trackAction(action) {
    recentActions.push(action);
    if (recentActions.length > 5) recentActions.shift();
}

function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

function normalizeLLMUsage() {
    if (!state.llmUsage) state.llmUsage = { date: todayKey(), count: 0 };
    const today = todayKey();
    if (state.llmUsage.date !== today) {
        state.llmUsage = { date: today, count: 0 };
        saveState();
    }
    return state.llmUsage;
}

function isUserLLMLimitExceeded() {
    return normalizeLLMUsage().count >= DAILY_LLM_LIMIT;
}

function incrementLLMUsage() {
    const usage = normalizeLLMUsage();
    usage.count += 1;
    saveState();
}

function classifyUserIntent(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return 'unknown';
    if (/(죽고\s*싶|자살|자해|힘들|불안|우울|무기력|잠\s*못|잠이\s*안|공황|트라우마|외롭|괴로|상담|지쳤|무섭)/.test(t)) return 'mental';
    if (/(레시피|요리|만드는\s*법|만들어|음식|먹었|먹고|짜장면|라면|김치|볶음밥|파스타|찌개|카레|떡볶이|치킨|밥|국수)/.test(t)) return 'food';
    if (/(공부|과제|보고서|시험|정리|설명|요약|논문|발표|숙제|문제|풀이|개념)/.test(t)) return 'study';
    if (/(봤어|했어|그냥|농담|잡담|오늘|어제|재밌|웃겨|좋았|심심)/.test(t)) return 'casual';
    if (/(너\s*뭐야|작동|왜\s*이래|ai|제미나이|gemini|규칙\s*기반|오프라인|한도|제한|모델|api)/i.test(t)) return 'meta';
    return 'unknown';
}

function isShortReaction(text) {
    const t = (text || '').trim();
    return /^[0-9]+$/.test(t) || /^(응|네|예|아니|아뇨|몰라|그냥|음|어|ㅇㅇ|ㄴㄴ|ok|okay)$/i.test(t);
}

function shouldCallLLM(text, sentiment, context = {}) {
    if (state.flow !== 'idle') return false;
    if (context.crisis === 'high') return false;
    if (isShortReaction(text)) return false;
    if ((text || '').trim().length < 8) return false;
    if (isUserLLMLimitExceeded()) return false;
    if (!API_BASE || !API_RESPOND_URL) return false;
    return true;
}

function buildLimitedModeResponse(text, reason = 'quota-limited') {
    const intent = classifyUserIntent(text);
    if (intent === 'mental') {
        const r = buildRuleResponse(text, classifySentiment(text), { forceMental: true });
        return { ...r, source: 'rule' };
    }
    const replies = {
        food: '지금은 AI 응답 한도 때문에 자세한 답변 생성은 어렵지만, 음식 이야기로 이어갈 수는 있어요. 잠시 후 다시 물어봐 주세요.',
        study: '지금은 AI 응답이 제한되어 자세한 정리는 어렵지만, 자료를 주시면 기본 흐름은 이어갈 수 있어요. 잠시 후 다시 시도해 주세요.',
        casual: '그렇군요. 그 이야기로 가볍게 이어가도 괜찮아요.',
        meta: '지금은 AI 응답 한도가 잠시 제한되어 기본 응답으로 작동 중이에요. 그래서 답변이 단순할 수 있어요.',
        unknown: '지금은 AI 응답이 제한되어 자세히 풀어내기 어려워요. 조금 뒤 다시 시도해 주세요.',
    };
    return { text: replies[intent] || replies.unknown, typingMs: 700, source: 'limited', reason };
}

/**
 * 메인 응답 빌더 — 행동을 결정하고 그에 맞는 텍스트를 조합
 * 반환: { text: string, typingMs: number }
 *   typingMs 는 호출자가 봇 타이핑 시간으로 사용
 */
function buildGeneralRuleResponse(text) {
    const intent = classifyUserIntent(text);
    if (intent === 'food') return '지금은 AI 응답 한도 때문에 자세한 답변 생성은 어렵지만, 음식 이야기로 이어갈 수는 있어요. 잠시 후 다시 물어봐 주세요.';
    if (intent === 'study') return '지금은 AI 응답이 제한되어 자세한 정리는 어렵지만, 자료를 주시면 기본 흐름은 이어갈 수 있어요. 잠시 후 다시 시도해 주세요.';
    if (intent === 'casual') return '그렇군요. 그 이야기로 가볍게 이어가도 괜찮아요.';
    if (intent === 'meta') return '지금은 AI 응답 한도가 잠시 제한되어 기본 응답으로 작동 중이에요. 그래서 답변이 단순할 수 있어요.';
    if (intent === 'unknown') return '지금은 AI 응답이 제한되어 자세히 풀어내기 어려워요. 조금 뒤 다시 시도해 주세요.';
    return null;
}

function buildRuleResponse(text, sentiment, options = {}) {
    const intent = classifyUserIntent(text);
    const allowMentalResponse = options.forceMental || intent === 'mental';
    const generalResponse = state.flow === 'idle' && state.mode === 'daily' && !allowMentalResponse
        ? buildGeneralRuleResponse(text)
        : null;
    if (generalResponse) {
        trackResponse(generalResponse);
        return { text: generalResponse, typingMs: 900 };
    }

    if (!allowMentalResponse && isShortReaction(text)) {
        const response = pickFromPool(RESPONSE_POOLS.ack, sentiment) || '네.';
        trackResponse(response);
        return { text: response, typingMs: 500 };
    }

    if (!allowMentalResponse && state.flow === 'idle' && state.mode === 'daily') {
        const limited = buildLimitedModeResponse(text, 'rule-fallback');
        trackResponse(limited.text);
        return { text: limited.text, typingMs: limited.typingMs };
    }

    const userMsgLength = (text || '').length;
    const userMsgCount = state.history.filter(h => h.role === 'user').length;

    const mirrorWord = (state.learningEnabled && userMsgCount > 4)
        ? getMirrorWord(sentiment) : null;
    const hasMirrorWord = !!mirrorWord && !text.includes(mirrorWord);

    const action = decideAction(sentiment, {
        recentActions,
        userMsgLength,
        hasMirrorWord,
    });
    trackAction(action);

    let response = '';
    let typingMs = 700;

    if (action === 'ack') {
        response = pickFromPool(RESPONSE_POOLS.ack, sentiment) || '네.';
        typingMs = 500 + Math.random() * 400;     // 빠르게
    }
    else if (action === 'label' && RESPONSE_POOLS.label[sentiment]) {
        response = pickFromPool(RESPONSE_POOLS.label, sentiment);
        typingMs = 900 + Math.random() * 600;     // 차분하게
    }
    else if (action === 'invite') {
        response = pickFromPool(RESPONSE_POOLS.invite, sentiment);
        typingMs = 800 + Math.random() * 500;
    }
    else {
        // empathize (기본)
        response = pickFromPool(RESPONSE_POOLS.empathize, sentiment);
        typingMs = 1000 + Math.random() * 800;    // 무거운 답엔 더 느리게

        // 미러링 — empathize 일 때만 25% 확률로 앞에 붙임
        if (hasMirrorWord && Math.random() < 0.25) {
            const phraseFn = MIRROR_PHRASES[sentiment];
            const phrase = phraseFn ? phraseFn(mirrorWord) : null;
            if (phrase) {
                response = `${phrase} ${response}`;
                typingMs += 600;
            }
        }

        // 직전 턴 핵심 단어 받아치기 — 5% 확률로
        if (!hasMirrorWord && userMsgLength > 15 && Math.random() < 0.05) {
            const echo = pickEchoWord(text);
            if (echo && echo.length >= 2) {
                response = `'${echo}'… 네, 들었어요. ${response}`;
                typingMs += 400;
            }
        }
    }

    // 무거운 감정에는 typing 시간 +500ms (망설이는 시간)
    if (['sad','anxious','tired'].includes(sentiment) && action !== 'ack') {
        typingMs += 500;
    }

    // 누적 대화량이 많아지면 가끔 연속성 인식 (10% 확률, empathize일 때만)
    if (userMsgCount > 10 && action === 'empathize' && Math.random() < 0.1) {
        const continuity = [
            ' 꾸준히 이야기 나눠주셔서 감사해요.',
            ' 여기까지 함께 와주신 것만으로도 큰 변화예요.',
        ];
        response += continuity[Math.floor(Math.random() * continuity.length)];
    }

    trackResponse(response);
    return { text: response, typingMs: Math.round(typingMs) };
}

// =====================================================================
// 5.4) LLM-우선 응답 빌더 (Gemini 2.5 Flash → 규칙 기반 폴백)
// ---------------------------------------------------------------------
// 1) 백엔드가 설정되어 있으면 Gemini 호출
// 2) 위기 키워드 / 응답 차단 / 네트워크 실패 → 규칙 기반으로 폴백
// 3) 폴백은 사용자에게 보이지 않음 (transparent)
// =====================================================================

/** 백엔드로 보낼 컨텍스트 빌드 — 익명·요약된 형태 */
function buildLLMContext() {
    // 사용자 어휘 top 8 (감정 카테고리 통합)
    const allWords = [];
    Object.entries(state.lexicon).forEach(([cat, words]) => {
        if (cat === 'neutral') return;
        Object.entries(words).forEach(([w, c]) => allWords.push({ w, c, cat }));
    });
    allWords.sort((a, b) => b.c - a.c);
    const topLexicon = allWords.slice(0, 8).map(x => x.w);

    // 반복 주제 top 3
    const themes = Object.entries(state.themeMemory)
        .filter(([_, t]) => t.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3)
        .map(([_, t]) => t.label);

    // 최근 자가점검 — 통합 진단 결과(lastAssessmentResult) 우선, 없으면 옛 history에서 보강
    const lastResult = state.lastAssessmentResult || null;
    const lastA = state.assessmentHistory[state.assessmentHistory.length - 1];

    const lastAssessment = lastResult ? {
        riskLevel: lastResult.riskLevel,         // 'high' | 'mid' | 'low'
        riskLabel: lastResult.riskLabel,          // '고위험' | '중위험' | '저위험'
        pcl5Total: lastResult.pcl5Total,
        iesrTotal: lastResult.iesrTotal,
        dominantCluster: lastResult.dominantCluster,  // 'B' | 'C' | 'D' | 'E' | null
        clusters: lastResult.pcl5Clusters,
        createdAt: lastResult.createdAt,
    } : (lastA ? {
        type: lastA.type,
        total: lastA.total,
        level: lastA.level,
        riskLevel: lastA.riskLevel || null,
        dominantCluster: lastA.dominantCluster || null,
        clusters: lastA.clusters || null,
    } : null);

    return {
        mode: state.mode,
        topLexicon,
        topThemes: themes,
        lastAssessment,
        initialAssessmentCompleted: !!lastAssessment,
    };
}

/** 백엔드 호출 — Gemini 응답 받아오기. 실패 시 null 반환 */
async function callLLMBackend(text, sentiment) {
    if (!API_RESPOND_URL) {
        console.log('[Ori] source=rule');
        state.lastLLMFallbackReason = 'backend-url-missing';
        return null;
    }

    // 최근 5턴 대화 추출
    const recentHistory = state.history.slice(-10).map(h => ({
        role: h.role === 'bot' ? 'assistant' : 'user',
        text: h.text,
    }));

    const payload = {
        userMessage: text,
        sentiment,
        context: buildLLMContext(),
        history: recentHistory,
    };

    // 타임아웃 가드 — 6초 이상 걸리면 폴백
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
        incrementLLMUsage();
        const res = await fetch(API_RESPOND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            console.log('[Ori] source=rule');
            state.lastLLMFallbackReason = `backend-http-${res.status}`;
            return null;
        }
        const data = await res.json();

        // 백엔드가 fallback 신호를 보내도 제한 모드는 상담형 규칙 엔진으로 넘기지 않는다.
        if (data.fallback || !data.text) {
            const reason = data.reason || data.error || 'empty-backend-response';
            state.lastLLMFallbackReason = reason;
            if (data.source === 'limited' || reason === 'quota-limited' || reason === 'quota-exceeded') {
                console.log(`[Ori] source=limited reason=${reason}`);
                return {
                    text: data.text || buildLimitedModeResponse(text, reason).text,
                    source: 'limited',
                    reason,
                };
            }
            console.log('[Ori] source=rule');
            return null;
        }

        // 위기 감지 신호 — 호출자가 위기 흐름으로 라우팅하도록
        if (data.crisisDetected) {
            console.log('[Ori] source=gemini');
            state.lastLLMFallbackReason = null;
            return { text: data.text, source: 'safety-bypass', crisisDetected: true };
        }

        console.log(`[Ori] source=${data.source || 'gemini'}`);
        state.lastLLMFallbackReason = null;
        return { text: data.text, source: data.source || 'gemini' };
    } catch (err) {
        clearTimeout(timeoutId);
        const reason = err.name === 'AbortError' ? 'backend-timeout' : `backend-failed:${err.message}`;
        console.log(`[Ori] LLM fetch failed: ${err.message}`);
        state.lastLLMFallbackReason = reason;
        return null;
    }
}

/**
 * 통합 응답 빌더 — LLM 우선, 실패 시 규칙 기반 폴백.
 * 반환: { text: string, typingMs: number, source: 'llm'|'rule', crisisDetected?: bool }
 */
async function buildResponse(text, sentiment) {
    // 1) LLM 시도
    if (isUserLLMLimitExceeded()) {
        updateChatModelBadge('limited');
        console.log('[Ori] source=limited reason=quota-limited');
        return buildLimitedModeResponse(text, 'quota-limited');
    }

    const crisis = detectCrisisLevel(text);
    const canCallLLM = shouldCallLLM(text, sentiment, { crisis });
    const llm = canCallLLM ? await callLLMBackend(text, sentiment) : null;
    if (llm) {
        updateChatModelBadge(llm.source);
        // LLM 응답에 맞춰 타이핑 시간 — 텍스트 길이 비례
        const baseMs = 600 + llm.text.length * 18;
        const typingMs = ['sad','anxious','tired'].includes(sentiment)
            ? baseMs + 400  // 무거운 감정엔 살짝 더 천천히
            : baseMs;
        trackResponse(llm.text);
        return {
            text: llm.text,
            typingMs: Math.min(Math.round(typingMs), 3000),
            source: llm.source,
            crisisDetected: !!llm.crisisDetected,
        };
    }

    // 2) 폴백 — 규칙 기반
    updateChatModelBadge(state.lastLLMFallbackReason && state.lastLLMFallbackReason.startsWith('backend-') ? 'offline' : 'rule');
    console.log('[Ori] source=rule');
    const r = buildRuleResponse(text, sentiment);
    return { ...r, source: 'rule' };
}

/** 짧은 침묵 — 위기·트라우마 키워드 후 사용. 봇이 "같이 머무르는" 효과 */
async function botSilence(ms = 1800) {
    showTyping();
    await new Promise(r => setTimeout(r, ms));
    hideTyping();
}

// =====================================================================
// 5.5) PCL-5 군집 레이더 차트 (DSM-5 B/C/D/E 시각화)
// ---------------------------------------------------------------------
// PCL-5의 4개 증상 군집(재경험/회피/부정적 인지·감정/각성)을 시각화.
// 각 군집의 점수를 최대치 대비 백분율로 변환해 0~100% 스케일.
// 의료진 공유 시 임상적 의미를 그대로 전달.
// =====================================================================

const PCL5_CLUSTER_META = {
    B: { label: '재경험',           sublabel: '침습·악몽·플래시백', maxScore: 5 * 4 },   // 5문항
    C: { label: '회피',             sublabel: '기억·장소·대화 회피', maxScore: 2 * 4 },   // 2문항
    D: { label: '부정적 인지·감정',  sublabel: '자책·단절·흥미상실',  maxScore: 7 * 4 },   // 7문항
    E: { label: '각성·반응성',       sublabel: '짜증·경계·불면',      maxScore: 6 * 4 },   // 6문항
};

/** 군집 점수에서 레이더 SVG 생성 */
function buildClusterRadar(clusterData) {
    if (!clusterData) return '';

    const W = 280, H = 240;
    const cx = W / 2, cy = H / 2 + 8;
    const radius = 76;
    const labels = ['B', 'C', 'D', 'E'];
    const angleStep = (Math.PI * 2) / labels.length;
    const startAngle = -Math.PI / 2; // 12시 방향에서 시작

    // 각 꼭짓점 좌표 계산 (외곽 = 100%)
    const axisPoints = labels.map((k, i) => {
        const angle = startAngle + i * angleStep;
        return {
            x: cx + radius * Math.cos(angle),
            y: cy + radius * Math.sin(angle),
            angle,
            key: k,
        };
    });

    // 데이터 폴리곤 좌표
    const dataPoints = labels.map((k, i) => {
        const meta = PCL5_CLUSTER_META[k];
        const score = clusterData[k] || 0;
        const ratio = Math.min(1, score / meta.maxScore);
        const angle = startAngle + i * angleStep;
        return {
            x: cx + radius * ratio * Math.cos(angle),
            y: cy + radius * ratio * Math.sin(angle),
            score,
            ratio,
            label: meta.label,
            sublabel: meta.sublabel,
            max: meta.maxScore,
            key: k,
        };
    });

    // 격자 (25/50/75/100%)
    const gridLevels = [0.25, 0.5, 0.75, 1.0];
    const gridPolys = gridLevels.map(level => {
        const pts = labels.map((_, i) => {
            const angle = startAngle + i * angleStep;
            return `${cx + radius * level * Math.cos(angle)},${cy + radius * level * Math.sin(angle)}`;
        });
        return `<polygon points="${pts.join(' ')}" fill="none" stroke="rgba(45,37,31,0.08)" stroke-width="0.8"/>`;
    });

    // 축선
    const axisLines = axisPoints.map(p =>
        `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="rgba(45,37,31,0.08)" stroke-width="0.8"/>`
    );

    // 데이터 영역
    const dataPolyPoints = dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // 라벨 배치 — 축 끝에서 약간 떨어진 곳
    const labelTexts = dataPoints.map(p => {
        const angle = p.angle ?? (startAngle + dataPoints.indexOf(p) * angleStep);
        const labelR = radius + 22;
        const lx = cx + labelR * Math.cos(angle);
        const ly = cy + labelR * Math.sin(angle);
        // 정렬
        const isTop    = Math.abs(angle - (-Math.PI/2)) < 0.1;
        const isBottom = Math.abs(angle - (Math.PI/2)) < 0.1;
        const anchor = isTop || isBottom ? 'middle' : (Math.cos(angle) > 0 ? 'start' : 'end');
        return `
            <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}"
                  dominant-baseline="middle"
                  font-family="Pretendard, sans-serif" font-size="11" font-weight="600" fill="#2d251f">
                ${p.label}
            </text>
            <text x="${lx.toFixed(1)}" y="${(ly + 12).toFixed(1)}" text-anchor="${anchor}"
                  dominant-baseline="middle"
                  font-family="Pretendard, sans-serif" font-size="9.5" fill="#8a7a6d">
                ${p.score}/${p.max}
            </text>
        `;
    });

    // 데이터 점
    const dataDots = dataPoints.map(p =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#c97558"/>`
    );

    // 가장 높은 군집 강조 텍스트
    const topCluster = [...dataPoints].sort((a, b) => b.ratio - a.ratio)[0];
    const topNote = topCluster.ratio > 0.4
        ? `<p style="margin-top:10px; font-size:12px; color:var(--ink-2);">
             가장 높은 신호는 <strong style="color:var(--coral-deep)">${topCluster.label}</strong> 영역이에요.
             <span style="color:var(--ink-3); font-size:11px;">(${topCluster.sublabel})</span>
           </p>`
        : '';

    return `
        <div style="margin-top:14px; padding:14px; background:rgba(255,252,245,0.4); border-radius:10px;">
            <p style="font-size:11.5px; color:var(--ink-3); letter-spacing:0.04em; margin-bottom:6px;">
                PCL-5 4군집 — 영역별 분포
            </p>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:280px; display:block; margin:0 auto;"
                 role="img" aria-label="PCL-5 4군집 레이더 차트">
                ${gridPolys.join('')}
                ${axisLines.join('')}
                <polygon points="${dataPolyPoints}"
                         fill="rgba(232, 156, 122, 0.25)"
                         stroke="#c97558" stroke-width="1.5" stroke-linejoin="round"/>
                ${dataDots.join('')}
                ${labelTexts.join('')}
            </svg>
            ${topNote}
        </div>
    `;
}

// =====================================================================
// 6) INSIGHTS ENGINE — 패턴 분석
// =====================================================================
function generateInsights() {
    const insights = [];

    // 1) 가장 많이 쓰인 감정 카테고리
    const catCounts = {};
    Object.entries(state.lexicon).forEach(([cat, words]) => {
        catCounts[cat] = Object.values(words).reduce((s, c) => s + c, 0);
    });
    const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
    if (topCat && topCat[1] >= 5 && topCat[0] !== 'neutral') {
        const labels = { sad:'슬픔', anxious:'불안', angry:'분노', tired:'피로', positive:'안정' };
        insights.push(`최근 가장 자주 표현하신 감정은 '${labels[topCat[0]] || topCat[0]}' 계열이에요 (${topCat[1]}회).`);
    }

    // 2) 시간대 패턴 — 부정 감정이 몰리는 시간
    const slots = state.timePattern
        .map((s, h) => ({ h, ...s }))
        .filter(s => s.count >= 2);
    if (slots.length >= 4) {
        const negative = slots.filter(s => s.mood < -0.3).sort((a, b) => a.mood - b.mood);
        if (negative.length > 0) {
            const top = negative[0];
            const range = `${top.h}시~${(top.h + 1) % 24}시`;
            insights.push(`${range} 사이에 어려움을 자주 표현하시네요. 그 시간을 위한 안정 루틴을 만들어보면 좋겠어요.`);
        }
    }

    // 3) 자가 점검 추이
    if (state.assessmentHistory.length >= 2) {
        const recent = state.assessmentHistory.slice(-2);
        const [prev, curr] = recent;
        if (prev.type === curr.type) {
            const diff = curr.total - prev.total;
            if (diff <= -3) {
                insights.push(`${curr.type === 'pcl5' ? 'PCL-5' : 'IES-R'} 점수가 ${prev.total}에서 ${curr.total}로 낮아졌어요. 부드러운 회복의 흐름이 보여요.`);
            } else if (diff >= 5) {
                insights.push(`${curr.type === 'pcl5' ? 'PCL-5' : 'IES-R'} 점수가 ${prev.total}에서 ${curr.total}로 올라갔어요. 요즘 더 힘들어지신 건 아닌지 살펴보면 좋겠어요.`);
            }
        }
    }

    // 4) 재점검 권유 (마지막 점검 14일 경과)
    const last = state.assessmentHistory[state.assessmentHistory.length - 1];
    if (last && Date.now() - last.ts > 14 * 24 * 60 * 60 * 1000) {
        insights.push(`마지막 자가 점검 후 2주가 지났어요. 한 번 더 살펴보시면 변화 흐름을 알 수 있어요.`);
    }

    // 5) 기분 기록 트렌드
    if (state.moodLog.length >= 5) {
        const recent5 = state.moodLog.slice(-5).map(m => m.score);
        const earlier = state.moodLog.slice(-10, -5).map(m => m.score);
        if (earlier.length >= 3) {
            const avgRecent  = recent5.reduce((s,v)=>s+v,0) / recent5.length;
            const avgEarlier = earlier.reduce((s,v)=>s+v,0) / earlier.length;
            if (avgRecent - avgEarlier >= 1.5) {
                insights.push(`최근 기분이 이전보다 한층 나아진 흐름이에요. 무엇이 도움이 됐는지 적어두면 좋아요.`);
            } else if (avgEarlier - avgRecent >= 1.5) {
                insights.push(`최근 며칠 기분이 평소보다 가라앉아 있어요. 무리하지 마시고 천천히 돌봐주세요.`);
            }
        }
    }

    return insights;
}

// =====================================================================
// 7) DOM 헬퍼
// =====================================================================
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

const chatWindow    = $('#chat-window');
const userInput     = $('#user-input');
const sendBtn       = $('#send-btn');
const quickReplies  = $('#quick-replies');
const modeBadge     = $('#mode-badge');
const modeDesc      = $('#mode-description');
const progressBlock = $('#assessment-progress');
const progressFill  = $('#progress-fill');
const progressText  = $('#progress-text');
const progressCount = $('#progress-count');

function scrollToBottom() {
    requestAnimationFrame(() => { chatWindow.scrollTop = chatWindow.scrollHeight; });
}

function addMessage(text, sender = 'bot', opts = {}) {
    const div = document.createElement('div');
    div.className = `message ${sender}-message`;
    if (opts.html) div.innerHTML = text; else div.textContent = text;
    chatWindow.appendChild(div);
    scrollToBottom();
    state.history.push({ role: sender, text, ts: Date.now() });
    saveState();
}

function addCard(titleHTML, bodyHTML) {
    const card = document.createElement('div');
    card.className = 'message message-card';
    card.innerHTML = `<div class="message-card-title">${titleHTML}</div>${bodyHTML}`;
    chatWindow.appendChild(card);
    scrollToBottom();
}

function addSystem(text) {
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.textContent = text;
    chatWindow.appendChild(div);
    scrollToBottom();
}

function showTyping() {
    hideTyping();
    const t = document.createElement('div');
    t.className = 'typing-indicator';
    t.id = 'typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    chatWindow.appendChild(t);
    scrollToBottom();
}
function hideTyping() {
    const t = document.getElementById('typing');
    if (t) t.remove();
}

function botSay(text, delay = 700) {
    showTyping();
    return new Promise(resolve => {
        setTimeout(() => { hideTyping(); addMessage(text, 'bot'); resolve(); }, delay);
    });
}

function updateChatModelBadge(source) {
    const badge = document.getElementById('chat-model-badge');
    if (!badge) return;

    badge.classList.remove('llm');
    if (source === 'gemini' || source === 'safety-bypass') {
        badge.textContent = 'AI · Gemini';
        badge.classList.add('llm');
    } else if (source === 'limited') {
        badge.textContent = 'AI 제한 중';
    } else if (source === 'offline') {
        badge.textContent = '오프라인';
    } else {
        badge.textContent = '기본 응답';
    }
}

function clearQuickReplies() {
    quickReplies.classList.add('hidden');
    quickReplies.innerHTML = '';
}

function showQuickReplies(options) {
    quickReplies.innerHTML = '';
    quickReplies.className = 'quick-replies';
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'quick-reply';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
            clearQuickReplies();
            addMessage(opt.label, 'user');
            opt.onSelect();
        });
        quickReplies.appendChild(btn);
    });
}

function showScaleButtons(onPick) {
    quickReplies.innerHTML = '';
    quickReplies.className = 'scale-row';
    SCALE_LABELS.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'scale-btn';
        btn.innerHTML = `<span class="scale-btn-num">${s.num}</span><span class="scale-btn-label">${s.label}</span>`;
        btn.addEventListener('click', () => {
            clearQuickReplies();
            addMessage(`${s.num} · ${s.label}`, 'user');
            onPick(s.num);
        });
        quickReplies.appendChild(btn);
    });
}

function setMode(mode) {
    state.mode = mode;
    modeBadge.classList.remove('mode-daily', 'mode-special', 'mode-crisis');
    if (mode === 'daily') {
        modeBadge.classList.add('mode-daily');
        modeBadge.textContent = '일상 모드';
        modeDesc.textContent = '가벼운 우울감과 무기력을 함께 들여다보는 정서 공감 대화 모드입니다.';
    } else if (mode === 'special') {
        modeBadge.classList.add('mode-special');
        modeBadge.textContent = '특수 모드';
        modeDesc.textContent = '외상 후 스트레스 반응을 부드럽게 살피며, 안정과 자원 연계에 집중하는 모드입니다.';
    } else if (mode === 'crisis') {
        modeBadge.classList.add('mode-crisis');
        modeBadge.textContent = '긴급 케어';
        modeDesc.textContent = '지금 매우 힘드신 상태로 보여요. 전문 상담사 연결을 권해 드립니다.';
    }
    saveState();
}

function setProgress(current, total, label) {
    progressBlock.classList.remove('hidden');
    progressFill.style.width = `${(current / total) * 100}%`;
    progressCount.textContent = `${current} / ${total}`;
    progressText.textContent = label || '진행 중';
}
function hideProgress() {
    progressBlock.classList.add('hidden');
    progressFill.style.width = '0%';
}

function openModal(id) {
    const m = $(`#${id}`);
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
    const m = $(`#${id}`);
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
    if (id === 'breathing-modal') stopBreathing();
}

// =====================================================================
// 8) 사이드 패널 탭 라우팅 + 뷰 렌더링
// =====================================================================
function switchPanel(name) {
    $$('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    $$('.panel-view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'insights') renderInsights();
    if (name === 'journal')  renderJournal();
}

function renderInsights() {
    renderMoodSpark();
    renderLexicon();
    renderPatterns();
    renderAssessmentHistory();
    renderMemory();
}

function renderMemory() {
    const wrap = $('#memory-display');
    if (!wrap) return;

    const entities = Object.entries(state.entityMemory)
        .filter(([_, e]) => e.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8);
    const themes = Object.entries(state.themeMemory)
        .filter(([_, t]) => t.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

    if (entities.length === 0 && themes.length === 0) {
        wrap.innerHTML = `<p class="empty-hint">대화가 쌓이면 자주 언급하시는 사람·주제를 기억해 두고, 다음에 자연스럽게 여쭤볼게요.</p>`;
        return;
    }

    let html = '';

    if (themes.length > 0) {
        html += `
            <div class="memory-section">
                <span class="memory-section-label">자주 들어온 주제</span>
                <div class="memory-tags">
                    ${themes.map(([_, t]) =>
                        `<span class="memory-tag memory-tag-theme" title="${t.count}회">${t.label}</span>`
                    ).join('')}
                </div>
            </div>
        `;
    }

    if (entities.length > 0) {
        html += `
            <div class="memory-section">
                <span class="memory-section-label">기억해 두는 단어</span>
                <div class="memory-tags">
                    ${entities.map(([k, e]) =>
                        `<span class="memory-tag" title="${e.count}회">${k}</span>`
                    ).join('')}
                </div>
            </div>
        `;
    }

    html += `<p class="memory-forget-note">학습 모드를 끄거나 데이터를 삭제하시면 모두 잊혀져요.</p>`;
    wrap.innerHTML = html;
}

function renderMoodSpark() {
    const wrap = $('#mood-spark');
    const summary = $('#mood-summary');

    const now = Date.now();
    const week = state.moodLog.filter(m => now - m.ts < 7 * 24 * 60 * 60 * 1000);

    if (week.length < 2) {
        wrap.innerHTML = '';
        summary.textContent = '아직 충분한 기록이 없어요. 오늘의 마음을 적어볼까요?';
        return;
    }

    // 시간순 정렬, 정규화
    const sorted = [...week].sort((a, b) => a.ts - b.ts);
    const W = 280, H = 70, pad = 4;
    const xStep = (W - pad * 2) / Math.max(1, sorted.length - 1);
    const points = sorted.map((m, i) => {
        const x = pad + i * xStep;
        const y = H - pad - ((m.score - 1) / 9) * (H - pad * 2);
        return [x, y];
    });

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const fillD = pathD + ` L ${points[points.length-1][0].toFixed(1)} ${H} L ${points[0][0].toFixed(1)} ${H} Z`;

    wrap.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="spark-grad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%"  stop-color="#c97558"/>
                    <stop offset="100%" stop-color="#e89c7a"/>
                </linearGradient>
                <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#e89c7a" stop-opacity="0.4"/>
                    <stop offset="100%" stop-color="#e89c7a" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path class="mood-spark-fill" d="${fillD}"/>
            <path class="mood-spark-line" d="${pathD}"/>
            ${points.map(p => `<circle class="mood-spark-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5"/>`).join('')}
        </svg>
    `;

    const avg = (sorted.reduce((s, m) => s + m.score, 0) / sorted.length).toFixed(1);
    const lastScore = sorted[sorted.length - 1].score;
    summary.textContent = `최근 7일 평균 ${avg}점 · 가장 최근 ${lastScore}점 · 총 ${sorted.length}회 기록`;
}

function renderLexicon() {
    const cloud = $('#lexicon-cloud');

    // 모든 카테고리 통합 후 빈도순
    const all = [];
    Object.entries(state.lexicon).forEach(([cat, words]) => {
        if (cat === 'neutral') return;
        Object.entries(words).forEach(([w, c]) => {
            all.push({ word: w, count: c, cat });
        });
    });

    if (all.length === 0) {
        cloud.innerHTML = `<p class="empty-hint">대화가 쌓이면 자주 쓰시는 단어가 여기에 모여요.</p>`;
        return;
    }

    all.sort((a, b) => b.count - a.count);
    const top = all.slice(0, 12);
    const max = top[0].count;

    cloud.innerHTML = top.map(t => {
        const isLarge = t.count >= max * 0.6;
        return `<span class="lexicon-tag ${isLarge ? 'lexicon-tag-large' : ''}" title="${t.cat} · ${t.count}회">${t.word}</span>`;
    }).join('');
}

function renderPatterns() {
    const list = $('#pattern-list');
    const insights = generateInsights();

    if (insights.length === 0) {
        list.innerHTML = `<li class="empty-hint">아직 관찰된 패턴이 없어요. 대화와 기록이 쌓이면 자동으로 보여드릴게요.</li>`;
        return;
    }
    list.innerHTML = insights.map(i => `<li>${i}</li>`).join('');
}

function renderAssessmentHistory() {
    const wrap = $('#assessment-history');
    if (state.assessmentHistory.length === 0) {
        wrap.innerHTML = `<p class="empty-hint">자가 점검을 진행하면 점수 변화를 볼 수 있어요.</p>`;
        return;
    }

    const items = [...state.assessmentHistory].reverse().slice(0, 5);
    const labels = { pcl5: 'PCL-5', iesr: 'IES-R' };

    wrap.innerHTML = items.map((a) => {
        const date = new Date(a.ts).toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' });
        let trend = '';
        const prev = state.assessmentHistory.filter(p => p.type === a.type && p.ts < a.ts).pop();
        if (prev) {
            const d = a.total - prev.total;
            if (d <= -3)      trend = `<span class="assessment-trend down">↓ ${Math.abs(d)}</span>`;
            else if (d >= 3)  trend = `<span class="assessment-trend up">↑ ${d}</span>`;
            else              trend = `<span class="assessment-trend">≈</span>`;
        }

        // PCL-5에 군집 데이터 있으면 펼침형 (details/summary)
        const hasClusters = a.type === 'pcl5' && a.clusters
            && Object.values(a.clusters).some(v => v > 0);

        if (hasClusters) {
            return `
                <details class="assessment-row-details">
                    <summary class="assessment-row">
                        <div class="assessment-row-label">
                            <span class="assessment-row-name">${labels[a.type]}</span>
                            <span class="assessment-row-date">${date}</span>
                        </div>
                        <div>
                            <span class="assessment-row-score">${a.total}</span>
                            ${trend}
                        </div>
                    </summary>
                    ${buildClusterRadar(a.clusters)}
                </details>
            `;
        }

        return `
            <div class="assessment-row">
                <div class="assessment-row-label">
                    <span class="assessment-row-name">${labels[a.type]}</span>
                    <span class="assessment-row-date">${date}</span>
                </div>
                <div>
                    <span class="assessment-row-score">${a.total}</span>
                    ${trend}
                </div>
            </div>
        `;
    }).join('');
}

function renderJournal() {
    const list = $('#mood-log-list');
    if (state.moodLog.length === 0) {
        list.innerHTML = `<p class="empty-hint">아직 기록이 없어요. 오른쪽 위 ‘기록’ 버튼으로 시작해 보세요.</p>`;
        return;
    }
    const sorted = [...state.moodLog].reverse();
    list.innerHTML = sorted.slice(0, 30).map(m => {
        const d = new Date(m.ts);
        const date = d.toLocaleDateString('ko-KR', { month:'short', day:'numeric' });
        const time = d.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
        return `
            <div class="mood-entry">
                <div class="mood-entry-score">${m.score}</div>
                <div class="mood-entry-body">
                    <div class="mood-entry-time">${date} · ${time}</div>
                    <div class="mood-entry-note">${m.note ? escapeHTML(m.note) : '<em style="opacity:0.5;">기록만 저장됨</em>'}</div>
                </div>
            </div>
        `;
    }).join('');
}

function escapeHTML(s) {
    return s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

// =====================================================================
// 9) 대화 엔진
// =====================================================================
async function startOnboarding() {
    state.flow = 'onboarding';

    const wasHere = state.sessionCount > 0;

    // ─── 첫 방문자: 진단 우선 ────────────────────────────────────────
    if (!wasHere) {
        await botSay('안녕하세요. 저는 마음의 회복을 함께하는 오리예요.', 400);
        await botSay('편하게 부르셔도 좋고, 이야기를 들어줄 곳이 필요하셨다면 그것도 좋아요.', 900);
        await botSay('자유롭게 대화하기 전에, 현재 마음 상태를 몇 가지 질문으로 먼저 살펴볼게요.', 1000);
        await botSay('진단이나 치료가 아니라, 이후 대화를 더 안전하게 맞추기 위한 초기 점검이에요.', 1100);

        state.sessionCount += 1;
        state.lastSession = Date.now();
        saveState();

        // 위기 상황일 수 있는 첫 방문자를 위한 우회로 한 줄 보존
        showQuickReplies([
            { label: '네, 같이 점검해 볼게요',  onSelect: () => startConversationalAssessment() },
            { label: '지금 너무 힘들어요',        onSelect: () => enterCrisisFlow() },
        ]);
        return;
    }

    // ─── 재방문자: 인사 + 메모리 콜백 (기존 로직 유지) ─────────────────
    const days = state.lastSession ? Math.floor((Date.now() - state.lastSession) / (24*60*60*1000)) : 0;
    const greeting = days <= 1 ? '오늘도 오셨네요. 다시 만나서 반가워요.'
                   : days <= 7 ? `${days}일 만이에요. 그동안 잘 지내셨어요?`
                               : '오랜만에 오셨네요. 다시 와주셔서 반가워요.';
    await botSay(greeting, 400);

    // 메모리 콜백 — 지난 세션의 주제·사람을 자연스럽게 호출
    const memory = findMemoryCallback();
    if (memory && days >= 1) {
        let line = '';
        if (memory.type === 'theme') {
            line = `지난번에 같이 이야기했던 '${memory.label}' 이야기는 좀 어떠세요? 그동안 변화가 있었나요?`;
        } else if (memory.type === 'entity') {
            const subject = memory.entityType === 'person' ? `${memory.label}랑은`
                          : memory.entityType === 'place' ? `${memory.label} 일은`
                          : memory.entityType === 'event' ? `${memory.label} 이후`
                          : `${memory.label}은`;
            line = `${subject} 좀 어떠세요? 지난번에 자주 말씀하셔서 마음에 남아 있어요.`;
        }
        if (line) {
            await botSay(line, 1100);
            state.flow = 'idle';
            state.awaitingInput = true;
            state.sessionCount += 1;
            state.lastSession = Date.now();
            saveState();
            return;
        }
    }

    state.sessionCount += 1;
    state.lastSession = Date.now();
    saveState();

    // 재방문자: 점검 여부 선택 (기존 4개 선택지보다 단순화)
    await botSay('다시 만나서 반가워요. 오늘도 먼저 상태를 가볍게 점검해볼까요?', 800);
    showQuickReplies([
        { label: '네, 먼저 점검할게요',  onSelect: () => startConversationalAssessment() },
        { label: '바로 이야기할래요',    onSelect: () => enterDailyMode() },
        { label: '지금 너무 힘들어요',   onSelect: () => enterCrisisFlow() },
    ]);
}

async function enterDailyMode() {
    setMode('daily');
    state.flow = 'idle';
    state.assessment = { type: null, index: 0, answers: [], startedAt: null };
    state.dailyModeStartedAt = Date.now();
    state.dailyUserTurns = 0;
    state.autoAssessmentSuppressed = true;
    state.awaitingInput = true;
    clearQuickReplies();
    hideProgress();
    saveState();
    await botSay('네, 그렇게 할게요. 오늘 하루는 어떻게 보내셨어요? 아주 작은 것부터 들려주셔도 돼요.', 700);
}

async function askGateway(traumaSuggested = false) {
    state.flow = 'gateway';
    if (traumaSuggested) await botSay('그러셨군요. 천천히 들려주셔도 괜찮아요.', 600);
    await botSay('혹시 지난 한 달 안에, 충격적이거나 무서웠던 사건을 직접 겪거나 가까이서 보신 적이 있으신가요?', 900);
    await botSay('예를 들어 사고·재난·폭력·가까운 사람의 갑작스러운 죽음 같은 일이요.', 1100);
    showQuickReplies([
        { label: '네, 있어요',         onSelect: () => proposeAssessment('iesr') },
        { label: '오래 전부터 그래요',  onSelect: () => proposeAssessment('pcl5') },
        { label: '아니요',             onSelect: () => proposeMoodCheck() },
        { label: '잘 모르겠어요',       onSelect: () => proposeMoodCheck() },
    ]);
}

// =====================================================================
// 10) 자가진단 엔진 — 대화형 (Conversational Assessment)
// ---------------------------------------------------------------------
// PCL-5 20문항 + IES-R 22문항을 6개 토픽으로 묶어 자연스러운 대화로 진행.
// 사용자 자유 답변에서 정도부사·키워드·시제를 추출해 토픽 내 여러 문항을 한 번에 채점.
// 모호하면 짧은 후속 질문으로 보강. 결과는 마지막에 부드럽게 카드로 제시.
// =====================================================================

/* ─────────────────────────────────────────────────────────────────────
 * 정도부사 → 0~4 점수 매핑
 * (PCL-5/IES-R 표준 5점 척도: 전혀/약간/중간/상당히/극심)
 * ─────────────────────────────────────────────────────────────────── */
const FREQUENCY_WORDS = {
    0: [/전혀/, /\b없/, /아예\s*안/, /한\s*번도/, /괜찮/, /\b없어/, /\b없습/],
    1: [/가끔/, /\b조금/, /살짝/, /약간/, /별로/, /드물/, /한두\s*번/],
    2: [/때때로/, /종종/, /어느\s*정도/, /보통/, /중간/, /며칠/, /몇\s*번/],
    3: [/자주/, /많이/, /꽤/, /상당히/, /거의\s*매일/, /일주일\s*[3-5]/, /계속/],
    4: [/항상/, /늘/, /매일/, /너무/, /극심/, /엄청/, /도저히/, /참을\s*수\s*없/, /숨이\s*막/, /아무것도\s*못/],
};

/** 자유 텍스트에서 빈도/강도 점수 추출. 못 찾으면 null 반환 (후속 질문 필요) */
function extractIntensity(text) {
    if (!text) return null;
    // 높은 점수부터 검사 (극심 표현이 우선)
    for (const score of [4, 3, 2, 1, 0]) {
        if (FREQUENCY_WORDS[score].some(rx => rx.test(text))) return score;
    }
    // 부정 표현 ("그렇지 않아요", "아니에요") → 0점
    if (/(아니|그렇진\s*않|그러진\s*않|않아요|아닙니다)/.test(text)) return 0;
    // 긍정만 ("네", "맞아요")인데 정도가 없으면 중간으로 추정
    if (/^(네|예|맞|그래요|그렇)/.test(text.trim())) return 2;
    return null;
}

/** 토픽별 키워드 매칭 — 답변에 해당 증상 키워드가 있으면 해당 문항만 채점 */
const SYMPTOM_KEYWORDS = {
    nightmare:  [/악몽/, /무서운\s*꿈/, /나쁜\s*꿈/, /가위/],
    insomnia:   [/잠.*못/, /잠.*안\s*와/, /불면/, /깨/, /뒤척/, /자다.*깨/],
    flashback:  [/플래시\s*백/, /다시\s*떠올/, /눈앞에/, /생생/, /그\s*때.*돌아/],
    intrusive:  [/자꾸\s*떠올/, /자꾸\s*생각/, /계속\s*생각/, /머릿속/, /떠나지\s*않/],
    avoid:      [/피하/, /못\s*가/, /안\s*가/, /외면/, /보지\s*않/, /이야기\s*안/, /꺼내지/],
    numb:       [/무뎌/, /감정.*없/, /아무\s*느낌/, /멍/, /공허/, /텅\s*빈/],
    detached:   [/혼자/, /외롭/, /거리/, /벽/, /끊고/, /연락\s*안/, /아무도/],
    hyperarous: [/예민/, /놀라/, /경계/, /깜짝/, /긴장/, /두근/, /조마조마/],
    irritable:  [/짜증/, /화가/, /폭발/, /참기\s*힘들/, /울컥/],
    bodily:     [/심장/, /두근/, /숨\s*막/, /땀/, /떨려/, /메스꺼/, /어지러/],
    guilt:      [/내\s*탓/, /죄책/, /자책/, /후회/, /부끄/, /수치/],
    concentrate:[/집중.*못/, /산만/, /건망/, /흐릿/, /멍해/],
    interest:   [/재미\s*없/, /흥미\s*없/, /의욕/, /하기\s*싫/, /즐겁지/],
};

/** 키워드 카테고리 검출 */
function detectSymptoms(text) {
    const found = [];
    for (const [key, patterns] of Object.entries(SYMPTOM_KEYWORDS)) {
        if (patterns.some(rx => rx.test(text))) found.push(key);
    }
    return found;
}

/* ─────────────────────────────────────────────────────────────────────
 * 6개 대화 토픽 정의
 * 각 토픽은:
 *   - opener: 봇이 던지는 자연스러운 첫 질문
 *   - followups: 답변이 모호할 때 보강 질문
 *   - items: { questionId: 'iesr-15' | 'pcl5-20', symptoms: [...], baseline: 기본점수 }
 *     symptoms 키워드가 답변에 있으면 → intensity 점수 적용
 *     없으면 → baseline (보통 0~1)
 * ─────────────────────────────────────────────────────────────────── */
const TOPICS = [
    {
        id: 'sleep',
        opener: '먼저 잠 이야기부터 들어볼게요. 요즘 잠은 어떠세요? 들기 어렵거나, 자다가 깨거나, 꿈 같은 거요.',
        followups: [
            '평소보다 자주 그러시는 편이에요?',
            '일주일에 며칠 정도 그러세요?',
        ],
        items: [
            // 둘 다 진행 시 양쪽에 점수 분배
            { id: 'pcl5-19', symptoms: ['insomnia'], baseline: 0 },        // PCL-5 #20: 잠들거나 유지 어려움 (0-indexed 19)
            { id: 'iesr-1',  symptoms: ['insomnia'], baseline: 0 },        // IES-R #2: 잠 어려움
            { id: 'iesr-14', symptoms: ['insomnia'], baseline: 0 },        // IES-R #15: 잠들기 어려움
            { id: 'pcl5-1',  symptoms: ['nightmare'], baseline: 0 },       // PCL-5 #2: 악몽
            { id: 'iesr-19', symptoms: ['nightmare'], baseline: 0 },       // IES-R #20: 그 일에 대한 꿈
        ],
    },
    {
        id: 'intrusion',
        opener: '그 일이 떠오르는 순간이 있나요? 의도하지 않았는데 머릿속에 갑자기 들어오거나 하는.',
        followups: [
            '떠오르면 그게 얼마나 생생하세요?',
            '몸에서도 반응이 와요? 심장이 뛴다거나, 숨이 가빠진다거나.',
        ],
        items: [
            { id: 'pcl5-0',  symptoms: ['intrusive'],   baseline: 0 },     // PCL-5 #1: 반복적 기억
            { id: 'pcl5-2',  symptoms: ['flashback'],   baseline: 0 },     // PCL-5 #3: 다시 일어나는 듯
            { id: 'pcl5-3',  symptoms: ['intrusive', 'flashback'], baseline: 0 }, // PCL-5 #4: 떠올리면 속상
            { id: 'pcl5-4',  symptoms: ['bodily'],      baseline: 0 },     // PCL-5 #5: 신체 반응
            { id: 'iesr-0',  symptoms: ['flashback', 'intrusive'], baseline: 0 }, // IES-R #1
            { id: 'iesr-2',  symptoms: ['intrusive'],   baseline: 0 },     // IES-R #3: 다른 일이 생각나게
            { id: 'iesr-5',  symptoms: ['intrusive'],   baseline: 0 },     // IES-R #6: 의도하지 않게
            { id: 'iesr-8',  symptoms: ['flashback'],   baseline: 0 },     // IES-R #9: 장면이 떠오름
            { id: 'iesr-13', symptoms: ['flashback'],   baseline: 0 },     // IES-R #14: 그 시간으로 돌아간 듯
            { id: 'iesr-15', symptoms: ['intrusive'],   baseline: 0 },     // IES-R #16: 파도처럼
            { id: 'iesr-18', symptoms: ['bodily'],      baseline: 0 },     // IES-R #19: 신체 반응
        ],
    },
    {
        id: 'avoidance',
        opener: '그 일을 떠올리게 하는 장소나 사람·이야기가 있을 텐데, 그런 걸 일부러 피하시는 편이에요?',
        followups: [
            '얼마나 자주 그러세요?',
            '안 떠올리려고 애쓰는 편이세요?',
        ],
        items: [
            { id: 'pcl5-5',  symptoms: ['avoid'],   baseline: 0 },         // PCL-5 #6: 기억·생각 회피
            { id: 'pcl5-6',  symptoms: ['avoid'],   baseline: 0 },         // PCL-5 #7: 사람·장소 회피
            { id: 'iesr-4',  symptoms: ['avoid'],   baseline: 0 },         // IES-R #5: 흔들리지 않으려
            { id: 'iesr-7',  symptoms: ['avoid'],   baseline: 0 },         // IES-R #8: 멀리하기
            { id: 'iesr-10', symptoms: ['avoid'],   baseline: 0 },         // IES-R #11: 생각하지 않으려
            { id: 'iesr-16', symptoms: ['avoid'],   baseline: 0 },         // IES-R #17: 기억 지우려
            { id: 'iesr-21', symptoms: ['avoid'],   baseline: 0 },         // IES-R #22: 이야기 안 함
        ],
    },
    {
        id: 'numbness',
        opener: '요즘 감정이 평소랑 다른 것 같으세요? 무뎌졌거나, 즐거운 일이 즐겁지 않거나, 사람들과 거리가 느껴진다거나.',
        followups: [
            '예전에 좋아하시던 것들은 어떠세요?',
            '주변 사람들이랑은 어떠세요?',
        ],
        items: [
            { id: 'pcl5-7',  symptoms: ['concentrate'], baseline: 0 },     // PCL-5 #8: 기억 어려움
            { id: 'pcl5-8',  symptoms: ['guilt', 'numb'], baseline: 0 },   // PCL-5 #9: 부정적 생각
            { id: 'pcl5-9',  symptoms: ['guilt'],   baseline: 0 },         // PCL-5 #10: 자책
            { id: 'pcl5-11', symptoms: ['interest'],baseline: 0 },         // PCL-5 #12: 흥미 잃음
            { id: 'pcl5-12', symptoms: ['detached', 'numb'], baseline: 0 },// PCL-5 #13: 단절감
            { id: 'pcl5-13', symptoms: ['numb'],    baseline: 0 },         // PCL-5 #14: 긍정 감정 어려움
            { id: 'iesr-6',  symptoms: ['numb'],    baseline: 0 },         // IES-R #7: 현실 아닌 듯
            { id: 'iesr-11', symptoms: ['numb'],    baseline: 0 },         // IES-R #12: 모른 척
            { id: 'iesr-12', symptoms: ['numb'],    baseline: 0 },         // IES-R #13: 감정 무뎌짐
        ],
    },
    {
        id: 'arousal',
        opener: '몸이 평소보다 긴장되어 있거나 예민해진 느낌이세요? 작은 소리에도 잘 놀라거나, 주변을 자꾸 살피거나.',
        followups: [
            '집중은 잘 되세요?',
            '짜증이 평소보다 자주 올라오나요?',
        ],
        items: [
            { id: 'pcl5-10', symptoms: ['guilt', 'irritable', 'numb'], baseline: 0 }, // PCL-5 #11: 강한 부정 감정
            { id: 'pcl5-14', symptoms: ['irritable'],   baseline: 0 },     // PCL-5 #15: 짜증/화
            { id: 'pcl5-16', symptoms: ['hyperarous'],  baseline: 0 },     // PCL-5 #17: 경계
            { id: 'pcl5-17', symptoms: ['hyperarous'],  baseline: 0 },     // PCL-5 #18: 깜짝 놀람
            { id: 'pcl5-18', symptoms: ['concentrate'], baseline: 0 },     // PCL-5 #19: 집중 어려움
            { id: 'iesr-3',  symptoms: ['irritable'],   baseline: 0 },     // IES-R #4: 짜증/화
            { id: 'iesr-9',  symptoms: ['hyperarous'],  baseline: 0 },     // IES-R #10: 깜짝 놀람
            { id: 'iesr-17', symptoms: ['concentrate'], baseline: 0 },     // IES-R #18: 집중 어려움
            { id: 'iesr-20', symptoms: ['hyperarous'],  baseline: 0 },     // IES-R #21: 경계
        ],
    },
    {
        id: 'risk',
        opener: '마지막으로 한 가지만 더 여쭐게요. 요즘 자신을 돌보기가 평소보다 어렵게 느껴지진 않으세요? 무리하시거나, 자신에게 거친 행동을 하시는 거요.',
        followups: ['혹시 위험한 행동을 하시거나 그런 충동이 있으세요?'],
        items: [
            { id: 'pcl5-15', symptoms: ['irritable'], baseline: 0 },       // PCL-5 #16: 위험 행동/자해
        ],
        crisisCheck: true, // 이 토픽에서는 위기 키워드 별도 검사
    },
];

/** 토픽 응답을 받아 해당 토픽의 모든 문항에 점수 매기기 */
function scoreTopic(topic, userText, intensity) {
    const symptoms = detectSymptoms(userText);
    const intensityVal = intensity ?? 2; // 모호하면 중간

    const scores = {};
    topic.items.forEach(item => {
        const matched = item.symptoms.some(s => symptoms.includes(s));
        if (matched) {
            // 키워드 매칭 → intensity 그대로 적용
            scores[item.id] = intensityVal;
        } else {
            // 매칭 없음 → baseline (대부분 0)
            // 단, 사용자가 전반적으로 강한 정도부사를 썼으면 살짝 가산
            scores[item.id] = intensityVal >= 3 ? Math.max(item.baseline, 1) : item.baseline;
        }
    });
    return scores;
}

/* ─────────────────────────────────────────────────────────────────────
 * 대화형 자가진단 흐름
 * ─────────────────────────────────────────────────────────────────── */
async function proposeAssessment(type) {
    // type 인자는 호환성 유지용 — 실제로는 통합 대화형으로 진행
    await botSay('말씀해 주셔서 감사해요. 그 일이 지금 어떻게 남아 있는지, 몇 가지만 같이 들여다볼 수 있을까요?', 800);
    await botSay('진단 검사처럼 답하지 않으셔도 돼요. 떠오르는 대로 편하게 들려주시면, 제가 흐름을 따라가 볼게요.', 1300);
    showQuickReplies([
        { label: '네, 이야기해 볼게요',  onSelect: () => startConversationalAssessment() },
        { label: '나중에 할게요',        onSelect: () => enterDailyMode() },
        { label: '먼저 호흡부터',         onSelect: () => { clearQuickReplies(); openModal('breathing-modal'); } },
    ]);
}

async function proposeMoodCheck() {
    await botSay('알겠어요. 굳이 큰 일이 아니더라도, 마음이 무거워지는 날은 누구에게나 있죠.', 700);
    await botSay('지금 마음 상태를 한 단어로 표현한다면 어떤 단어가 떠오르세요? 자유롭게 적어주셔도 좋고, 아래에서 골라주셔도 좋아요.', 1100);
    state.flow = 'idle';
    state.awaitingInput = true;
    setMode('daily');
    showQuickReplies([
        { label: '무기력해요',  onSelect: () => respondToMood('tired') },
        { label: '불안해요',    onSelect: () => respondToMood('anxious') },
        { label: '슬퍼요',      onSelect: () => respondToMood('sad') },
        { label: '화가 나요',   onSelect: () => respondToMood('angry') },
        { label: '괜찮아요',    onSelect: () => respondToMood('positive') },
    ]);
}

async function respondToMood(category) {
    state.awaitingInput = true;
    learnFromMessage(category, category);
    const r = await buildResponse('', category);
    await botSay(r.text, r.typingMs);
    await botSay('어떤 일이 있었는지, 떠오르는 만큼만 들려주세요.', 900);
}

// 호환성: 옛 startAssessment 호출이 들어와도 새 흐름으로
async function startAssessment(type) {
    return startConversationalAssessment();
}

/** 대화형 자가진단 시작 */
async function startConversationalAssessment() {
    state.flow = 'assessment';
    state.assessment = {
        topicIndex: 0,
        scores: {},                // { 'pcl5-0': 3, 'iesr-1': 2, ... }
        topicAnswers: [],          // 각 토픽의 사용자 원문 저장 (결과 카드에 인용용)
        awaitingFollowup: false,
        currentTopic: null,
        startedAt: Date.now(),
    };
    setMode('special');
    setProgress(0, TOPICS.length, '함께 둘러보는 중');
    await botSay('편한 자세 잡으시고요, 천천히 가도 돼요.', 700);
    askNextTopic();
}

async function askNextTopic() {
    const a = state.assessment;
    if (a.topicIndex >= TOPICS.length) return finishConversationalAssessment();

    const topic = TOPICS[a.topicIndex];
    a.currentTopic = topic;
    a.awaitingFollowup = false;

    setProgress(a.topicIndex, TOPICS.length, '함께 둘러보는 중');
    await botSay(topic.opener, 800);
    state.awaitingInput = true;
}

/** 사용자가 토픽에 답했을 때 호출 */
async function processTopicAnswer(text) {
    const a = state.assessment;
    const topic = a.currentTopic;
    if (!topic) return;

    state.awaitingInput = false;

    // 위기 토픽에서 위기 키워드 감지 시 즉시 위기 흐름으로
    if (topic.crisisCheck) {
        const crisis = detectCrisisLevel(text);
        if (crisis === 'high') {
            await enterCrisisFlow();
            return;
        }
    }

    // 정도 추출
    const intensity = extractIntensity(text);

    // 너무 짧거나 모호하면 후속 질문 (단, 한 토픽당 최대 1회)
    if (!a.awaitingFollowup && (text.trim().length < 6 || intensity === null) && topic.followups.length > 0) {
        a.awaitingFollowup = true;
        a.topicAnswers.push({ topicId: topic.id, text });
        const followup = topic.followups[Math.floor(Math.random() * topic.followups.length)];
        await botSay(followup, 900);
        state.awaitingInput = true;
        return;
    }

    // 채점
    const topicScores = scoreTopic(topic, text, intensity);
    Object.assign(a.scores, topicScores);
    a.topicAnswers.push({ topicId: topic.id, text, intensity });

    // 부드러운 공감 응답 (다음 토픽 넘어가기 전)
    const ack = buildTopicAcknowledgement(topic, text, intensity);
    if (ack) await botSay(ack, 900);

    // 다음 토픽
    a.topicIndex += 1;
    a.currentTopic = null;

    // 토픽 사이 짧은 호흡
    if (a.topicIndex < TOPICS.length) {
        await new Promise(r => setTimeout(r, 600));
    }
    askNextTopic();
}

/** 토픽별 자연스러운 받아주기 멘트 */
function buildTopicAcknowledgement(topic, text, intensity) {
    const high = intensity !== null && intensity >= 3;
    const low  = intensity !== null && intensity <= 1;

    const map = {
        sleep: high
            ? '잠을 제대로 못 자는 게 정말 힘드셨겠어요. 몸이 회복할 시간이 없는 거잖아요.'
            : low
            ? '잠은 그래도 어느 정도 지키고 계시는군요. 다행이에요.'
            : '그러시군요. 잠은 마음 상태를 가장 먼저 보여주는 자리라서 들여다본 거예요.',
        intrusion: high
            ? '그 장면이 통제 없이 들어오는 게 가장 지치는 부분이에요. 잘 견뎌오셨어요.'
            : low
            ? '많이 들어오진 않으시는군요. 그건 다행이에요.'
            : '말씀해 주셔서 감사해요.',
        avoidance: high
            ? '피하는 건 자신을 지키려는 마음이에요. 잘못이 아니에요.'
            : '네, 이해했어요.',
        numbness: high
            ? '감정이 무뎌지는 건 너무 많은 걸 견디다 보면 일어나는 자연스러운 보호 반응이에요.'
            : low
            ? '감정은 그래도 살아 있으시군요.'
            : '그렇군요.',
        arousal: high
            ? '몸이 계속 경계 상태에 있으면 정말 진이 빠지죠.'
            : '들었어요.',
        risk: high
            ? '그 마음을 솔직하게 꺼내 주셔서 정말 감사해요. 혼자 두지 않을게요.'
            : null, // 위험이 낮으면 굳이 코멘트 안 함
    };
    return map[topic.id];
}

/** 결과 산출 + 카드 출력 */
async function finishConversationalAssessment() {
    hideProgress();
    const a = state.assessment;
    state.flow = 'idle';

    // PCL-5 / IES-R 점수 분리 합산
    let pcl5Total = 0, iesrTotal = 0;
    const pcl5Answers = new Array(20).fill(0);
    const iesrAnswers = new Array(22).fill(0);

    Object.entries(a.scores).forEach(([key, score]) => {
        const [tool, idx] = key.split('-');
        const i = parseInt(idx, 10);
        if (tool === 'pcl5' && i < 20) {
            pcl5Answers[i] = score;
            pcl5Total += score;
        } else if (tool === 'iesr' && i < 22) {
            iesrAnswers[i] = score;
            iesrTotal += score;
        }
    });

    // PCL-5 군집 계산
    const clusterData = {};
    Object.entries(PCL5.clusters).forEach(([k, idxs]) => {
        clusterData[k] = idxs.reduce((s, i) => s + pcl5Answers[i], 0);
    });

    // 종합 레벨 — 둘 중 더 높은 신호 우선
    const pcl5Level = pcl5Total >= 33 ? 'high' : pcl5Total >= 20 ? 'mid' : 'low';
    const iesrLevel = iesrTotal >= 33 ? 'high' : iesrTotal >= 24 ? 'mid' : 'low';
    const combined = (pcl5Level === 'high' || iesrLevel === 'high') ? 'high'
                   : (pcl5Level === 'mid'  || iesrLevel === 'mid')  ? 'mid'
                   : 'low';

    let level, message, suggestions;
    if (combined === 'high') {
        level = '주의 필요';
        message = '오늘 들려주신 이야기에서, 외상 후 스트레스 반응이 또렷하게 보여요. 혼자 견디기엔 무거운 정도예요.';
        suggestions = [
            '가까운 정신건강복지센터 또는 트라우마센터에서 전문 상담을 받아보세요.',
            '국가트라우마센터 ☎ 02-2204-0001 (평일)',
            '24시간 정신건강위기상담: 1577-0195',
        ];
    } else if (combined === 'mid') {
        level = '관찰 필요';
        message = '몇몇 영역에서 부담이 느껴지는 신호가 있어요. 충분히 그럴 만한 시간을 보내고 계실 거예요.';
        suggestions = [
            '며칠 이내에 다시 한번 같이 점검해 봐요.',
            '오늘 있었던 호흡 가이드 · 5-4-3-2-1 그라운딩을 자주 활용해 보세요.',
        ];
    } else {
        level = '안정';
        message = '오늘 들려주신 이야기에서는, 외상 반응이 두드러지진 않아요. 그래도 마음을 살피는 건 늘 좋은 습관이에요.';
        suggestions = ['오늘은 자신에게 친절한 한 마디를 건네 보세요.'];
    }

    // 이력 저장 — 두 도구 모두 (riskLevel·dominantCluster 포함)
    const ts = Date.now();
    const dominantClusterKey = Object.entries(clusterData)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    if (pcl5Total > 0) {
        state.assessmentHistory.push({
            type: 'pcl5', total: pcl5Total, ts,
            clusters: clusterData,
            level: pcl5Level === 'high' ? '주의 필요' : pcl5Level === 'mid' ? '경계' : '낮음',
            riskLevel: pcl5Level,                // 'high' | 'mid' | 'low'
            dominantCluster: dominantClusterKey, // 'B' | 'C' | 'D' | 'E' | null
            mode: 'conversational',
        });
    }
    if (iesrTotal > 0) {
        state.assessmentHistory.push({
            type: 'iesr', total: iesrTotal, ts,
            level: iesrLevel === 'high' ? '주의 필요' : iesrLevel === 'mid' ? '경계' : '낮음',
            riskLevel: iesrLevel,                // 'high' | 'mid' | 'low'
            mode: 'conversational',
        });
    }

    // 통합 진단 결과 객체 — 자유 대화 시 Gemini 컨텍스트에 전달됨
    const assessmentResult = {
        riskLevel: combined,                     // 'high' | 'mid' | 'low' — 머신가독
        riskLabel: combined === 'high' ? '고위험'
                 : combined === 'mid'  ? '중위험'
                 :                       '저위험',
        displayLabel: level,                     // '주의 필요' | '관찰 필요' | '안정' — UX용
        pcl5Total,
        iesrTotal,
        pcl5Clusters: clusterData,
        dominantCluster: dominantClusterKey,
        suggestions,
        createdAt: ts,
    };
    state.lastAssessmentResult = assessmentResult;
    saveState();

    await botSay('이야기 들려주셔서 감사해요. 제가 들으면서 본 흐름을 정리해 볼게요.', 1000);

    addCard(`오늘의 흐름 — ${level}`, `
        <p>${message}</p>
        <p style="margin-top:10px; font-weight:600;">제안</p>
        <ul>${suggestions.map(s => `<li>${s}</li>`).join('')}</ul>
        ${pcl5Total > 0 ? buildClusterRadar(clusterData) : ''}
        <details style="margin-top:14px; font-size:12.5px;">
            <summary style="cursor:pointer; color:var(--coral-deep); font-weight:500;">참고용 표준 점수 보기</summary>
            <div style="margin-top:8px; padding:10px; background:rgba(255,252,245,0.4); border-radius:8px;">
                <p>· PCL-5 환산: <strong>${pcl5Total}</strong> / 80 ${pcl5Total >= 33 ? '(임상 기준선 33점 이상)' : ''}</p>
                <p>· IES-R 환산: <strong>${iesrTotal}</strong> / 88 ${iesrTotal >= 33 ? '(임상 기준선 33점 이상)' : ''}</p>
                <p style="font-size:11px; opacity:0.7; margin-top:6px;">대화 답변에서 추정한 환산 점수입니다. 의료진과 공유하실 수 있어요.</p>
            </div>
        </details>
        <p style="margin-top:10px; font-size:11.5px; opacity:0.7;">※ 이 결과는 의학적 진단이 아닙니다. 참고용 자가 점검입니다.</p>
    `);

    // 위험도별 안내 + 자유 대화 진입 — Gemini/규칙 기반 응답이 이 결과를 참고함
    await afterInitialAssessment(assessmentResult);

    if (state.contributionEnabled) contributeData();
}

/* ─────────────────────────────────────────────────────────────────────
 * 초기 진단 완료 후 — 위험도별 안내를 출력하고 자유 대화로 전환
 * (교수님 피드백: 점수 진단 → 위험 평가 → 채팅 진단에 데이터 전달 → 상담 출력)
 * ─────────────────────────────────────────────────────────────────── */
async function afterInitialAssessment(result) {
    state.flow = 'idle';
    state.awaitingInput = true;

    if (result.riskLevel === 'high') {
        setMode('special');
        await botSay('지금은 혼자 버티기보다, 도움을 받을 수 있는 통로를 가까이 두는 게 좋아 보여요.', 900);
        await botSay('1393(자살예방) · 1577-0195(정신건강위기) · 112/119(응급) — 언제든 닿을 수 있는 곳들이에요.', 1300);
        await botSay('이제부터는 편하게 말씀해 주세요. 제가 그 흐름을 따라가면서, 필요할 때마다 안전한 도움도 함께 안내해 드릴게요.', 1300);
        showQuickReplies([
            { label: '안전 계획 세우기',  onSelect: () => { clearQuickReplies(); openModal('safety-modal'); } },
            { label: '호흡 가이드 시작',  onSelect: () => { clearQuickReplies(); openModal('breathing-modal'); } },
            { label: '먼저 이야기할래요', onSelect: () => { clearQuickReplies(); state.awaitingInput = true; } },
        ]);
    } else if (result.riskLevel === 'mid') {
        setMode('special');
        await botSay('몇몇 영역에서 부담이 느껴지는 신호가 있어요. 앞으로의 대화에서는 그 부분을 조금 더 조심스럽게 살펴볼게요.', 900);
        await botSay('이제 편하게 이야기해 주세요. 호흡이나 그라운딩 같은 도구도 필요할 때 같이 안내해 드릴게요.', 1100);
        showQuickReplies([
            { label: '호흡 가이드',         onSelect: () => { clearQuickReplies(); openModal('breathing-modal'); } },
            { label: '그라운딩 5-4-3-2-1',  onSelect: () => doGrounding() },
            { label: '이야기 먼저 할래요',   onSelect: () => { clearQuickReplies(); state.awaitingInput = true; } },
        ]);
    } else {
        setMode('daily');
        await botSay('지금은 두드러진 고위험 신호는 낮게 보여요. 그래도 마음을 살피는 건 늘 좋은 습관이에요.', 900);
        await botSay('이제부터는 편하게 말씀해 주세요. 오늘 가장 먼저 꺼내고 싶은 이야기는 무엇인가요?', 1100);
    }
}

// =====================================================================
// 11) 위기 흐름
// =====================================================================
async function enterCrisisFlow() {
    setMode('crisis');
    state.flow = 'idle';
    state.awaitingInput = true;
    await botSay('지금 그 마음을 꺼내 주셔서 정말 감사해요. 혼자 견디지 마시고, 지금 바로 도움을 받을 수 있어요.', 700);
    addCard('지금 바로 연결할 수 있는 곳', `
        <ul>
            <li><strong>1393</strong> · 자살예방상담 (24시간, 무료)</li>
            <li><strong>1577-0195</strong> · 정신건강위기상담 (24시간)</li>
            <li><strong>129</strong> · 보건복지상담</li>
            <li>응급한 상황이라면 <strong>112 / 119</strong></li>
        </ul>
        <p style="margin-top:10px;">전화가 어렵다면, 카카오톡 채널 <strong>'자살예방상담전화'</strong>에서도 24시간 상담이 가능해요.</p>
    `);
    await botSay('전화하시는 동안, 저도 옆에 있을게요. 호흡을 함께 가다듬어 볼까요?', 1200);
    showQuickReplies([
        { label: '호흡을 같이 해주세요',  onSelect: () => { clearQuickReplies(); openModal('breathing-modal'); } },
        { label: '안전 계획 보기',       onSelect: () => { clearQuickReplies(); openModal('safety-modal'); } },
        { label: '지금 기분을 적을게요', onSelect: () => { clearQuickReplies(); state.awaitingInput = true; } },
    ]);
}

// =====================================================================
// 12) 일반 메시지 처리
// =====================================================================
// =====================================================================
// 12.5) CONTEXTUAL TOOL SUGGESTIONS — 맥락 기반 도구 자동 제안
// ---------------------------------------------------------------------
// 좌측 버튼을 줄이는 대신, 봇이 대화 흐름에서 적절한 도구를 제안.
// 같은 도구를 같은 세션에 반복 제안하지 않도록 쿨다운 관리.
// =====================================================================
const SUGGESTION_COOLDOWN_MS = 8 * 60 * 1000; // 같은 도구 8분 내 재제안 금지
const lastSuggestedAt = {}; // { breathing: ts, grounding: ts, ... }

/** 사용자 메시지를 받아 가장 적절한 도구 한 개 제안 (없으면 null) */
function decideContextualSuggestion(text, crisis, sentiment) {
    const now = Date.now();
    const cooldownOK = (key) => !lastSuggestedAt[key] || (now - lastSuggestedAt[key]) > SUGGESTION_COOLDOWN_MS;

    // 우선순위 1: 위기 medium → 호흡 또는 안전계획
    if (crisis === 'medium' && cooldownOK('breathing')) {
        return {
            tool: 'breathing',
            line: '잠시 숨 한 번 같이 가다듬어 볼까요? 4-7-8 호흡이 도움이 될 거예요.',
            replies: [
                { label: '네, 같이 해요',  action: () => openModal('breathing-modal') },
                { label: '계속 이야기할래요', action: () => {} },
            ],
        };
    }

    // 우선순위 2: 신체적 패닉/과각성 키워드 → 그라운딩
    if (/(심장.*뛰|숨이\s*막|어지러|손이\s*떨|패닉|공황)/.test(text) && cooldownOK('grounding')) {
        return {
            tool: 'grounding',
            line: '몸이 많이 긴장해 있는 것 같아요. 5-4-3-2-1 그라운딩으로 지금 여기로 돌아와볼까요?',
            replies: [
                { label: '네, 해볼게요',     action: () => doGrounding() },
                { label: '나중에 할래요',    action: () => {} },
            ],
        };
    }

    // 우선순위 3: 트라우마 키워드 + 자가점검 안 했으면 → 자가점검 제안
    const lastAssessment = state.assessmentHistory[state.assessmentHistory.length - 1];
    const noRecentAssessment = !lastAssessment || (now - lastAssessment.ts) > 14 * 24 * 60 * 60 * 1000;
    if (!state.autoAssessmentSuppressed && crisis === 'trauma' && noRecentAssessment && state.mode === 'daily' && cooldownOK('checkup')) {
        return {
            tool: 'checkup',
            line: '들려주신 이야기가 마음에 걸려요. 그 일이 지금 어떻게 남아 있는지 같이 둘러볼까요?',
            replies: [
                { label: '네, 같이 들여다볼래요', action: () => proposeAssessment('iesr') },
                { label: '지금은 그냥 이야기만',  action: () => {} },
            ],
        };
    }

    // 우선순위 4: 절망/소진 표현이 누적되면 → 안전 계획 제안
    const recentNegative = state.history.slice(-6).filter(h => h.role === 'user').length;
    const hopelessness = /(희망\s*없|의미\s*없|지친|버틸\s*수\s*없|혼자|아무도)/.test(text);
    if (hopelessness && recentNegative >= 3 && cooldownOK('safety')) {
        return {
            tool: 'safety',
            line: '많이 지쳐 계신 것 같아요. 위기 순간을 위한 안전 계획을 미리 적어두면, 정말 힘들 때 길잡이가 돼요.',
            replies: [
                { label: '같이 적어볼게요',  action: () => openModal('safety-modal') },
                { label: '나중에 할래요',    action: () => {} },
            ],
        };
    }

    // 우선순위 5: 마지막 자가점검 14일 경과 + 부정 감정 → 재점검 제안
    if (!state.autoAssessmentSuppressed && lastAssessment && (now - lastAssessment.ts) > 14 * 24 * 60 * 60 * 1000
        && ['sad','anxious','tired'].includes(sentiment) && cooldownOK('recheck')) {
        return {
            tool: 'recheck',
            line: `마지막으로 같이 살펴본 지 ${Math.floor((now - lastAssessment.ts) / (24*60*60*1000))}일 됐어요. 변화가 있는지 한 번 더 들여다볼까요?`,
            replies: [
                { label: '네, 한 번 더 해요',  action: () => proposeAssessment(lastAssessment.type) },
                { label: '다음에 할래요',     action: () => {} },
            ],
        };
    }

    // 우선순위 6: 기분 기록이 며칠째 없으면 → 기록 제안 (가벼운 권유)
    const lastMood = state.moodLog[state.moodLog.length - 1];
    const noMoodInDays = !lastMood || (now - lastMood.ts) > 3 * 24 * 60 * 60 * 1000;
    if (sentiment !== 'neutral' && noMoodInDays && state.history.length > 8 && cooldownOK('mood')
        && Math.random() < 0.3) {  // 30% 확률로만 — 너무 자주 권유하면 부담
        return {
            tool: 'mood',
            line: '오늘 마음을 한 줄로 남겨두면, 나중에 흐름을 보는 데 도움이 돼요.',
            replies: [
                { label: '네, 기록해 둘게요',  action: () => openModal('mood-modal') },
                { label: '지금은 됐어요',     action: () => {} },
            ],
        };
    }

    return null;
}

/** 제안 실행: 봇 멘트 + 빠른답장 */
async function offerSuggestion(suggestion) {
    if (!suggestion) return false;
    lastSuggestedAt[suggestion.tool] = Date.now();
    await botSay(suggestion.line, 900);
    showQuickReplies(suggestion.replies.map(r => ({
        label: r.label,
        onSelect: () => { clearQuickReplies(); r.action(); },
    })));
    return true;
}

async function handleUserMessage(text) {
    if (!text.trim()) return;
    addMessage(text, 'user');
    userInput.value = '';

    // 1) 위기 감지 우선
    const crisis = detectCrisisLevel(text);
    if (crisis === 'high') {
        await enterCrisisFlow();
        return;
    }

    // 2) 대화형 자가진단 중이면 토픽 답변으로 라우팅
    if (state.flow === 'assessment') {
        const sentiment = classifySentiment(text);
        learnFromMessage(text, sentiment);
        await processTopicAnswer(text);
        return;
    }

    // 3) 온보딩/게이트웨이 중에는 텍스트 차단 (안내)
    if (['gateway', 'onboarding'].includes(state.flow)) {
        await botSay('지금은 위 버튼 중 하나를 눌러주시면 흐름을 이어갈 수 있어요. 다시 말씀하고 싶으시면 좌측 상단 새로 시작 버튼을 눌러 주세요.', 600);
        return;
    }

    // 4) 정상 흐름 — 학습 + 공감 응답
    const sentiment = classifySentiment(text);
    learnFromMessage(text, sentiment);
    if (state.flow === 'idle' && state.mode === 'daily') {
        if (!state.dailyModeStartedAt) state.dailyModeStartedAt = Date.now();
        state.dailyUserTurns += 1;
        saveState();
    }

    // 무거운 감정 표현엔 짧은 침묵 — "받아들이는 시간" 효과
    if (['sad','anxious','tired'].includes(sentiment) && text.length > 25 && Math.random() < 0.4) {
        await botSilence(1400 + Math.random() * 600);
    }

    const r = await buildResponse(text, sentiment);
    await botSay(r.text, r.typingMs);

    // LLM이 위기 신호를 감지했으면 위기 흐름으로
    if (r.crisisDetected) {
        await enterCrisisFlow();
        return;
    }

    // 5) 맥락 기반 도구 제안 (위기·트라우마·과각성·소진·재점검·기록 모두 통합)
    const suggestion = decideContextualSuggestion(text, crisis, sentiment);
    if (suggestion) {
        await offerSuggestion(suggestion);
        return;
    }

    // 6) 일정 턴 이상 대화가 진행됐고 위기 모드가 아니면 만족도 평가 1회 부드럽게 안내
    await maybeOfferSatisfactionPrompt(text);
}

// =====================================================================
// 13) 도구 — 호흡 / 그라운딩
// =====================================================================
let breathingTimer = null;
function runBreathingCycle() {
    const circle = document.querySelector('.breathing-circle');
    const phase  = $('#breathing-phase');
    const counter = $('#breathing-counter');

    let cycleCount = 0;
    const maxCycles = 4;

    function inhale() {
        if (cycleCount >= maxCycles) return endBreathing();
        circle.classList.remove('exhale', 'hold');
        circle.classList.add('inhale');
        phase.textContent = '들이쉬기';
        countdown(4, hold);
    }
    function hold() {
        circle.classList.remove('inhale', 'exhale');
        circle.classList.add('hold');
        phase.textContent = '멈추기';
        countdown(7, exhale);
    }
    function exhale() {
        circle.classList.remove('inhale', 'hold');
        circle.classList.add('exhale');
        phase.textContent = '내쉬기';
        countdown(8, () => { cycleCount++; inhale(); });
    }
    function countdown(secs, next) {
        let s = secs;
        counter.textContent = `${s}`;
        breathingTimer = setInterval(() => {
            s--;
            if (s <= 0) { clearInterval(breathingTimer); next(); }
            else counter.textContent = `${s}`;
        }, 1000);
    }
    function endBreathing() {
        circle.classList.remove('inhale', 'hold', 'exhale');
        phase.textContent = '편안하게';
        counter.textContent = '잘하셨어요. 천천히 일상으로 돌아오셔도 좋아요.';
        $('#breathing-start').textContent = '한 번 더';
        $('#breathing-start').disabled = false;
    }

    inhale();
}
function stopBreathing() {
    if (breathingTimer) clearInterval(breathingTimer);
    const circle = document.querySelector('.breathing-circle');
    if (circle) circle.classList.remove('inhale', 'hold', 'exhale');
    const startBtn = $('#breathing-start');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = '시작';
    }
}

async function doGrounding() {
    clearQuickReplies();
    addCard('5-4-3-2-1 그라운딩', `
        <p>지금 이 공간에서 천천히 찾아보세요.</p>
        <ul>
            <li><strong>5가지</strong> · 눈에 보이는 것</li>
            <li><strong>4가지</strong> · 몸에 닿는 감촉</li>
            <li><strong>3가지</strong> · 들리는 소리</li>
            <li><strong>2가지</strong> · 맡을 수 있는 냄새</li>
            <li><strong>1가지</strong> · 맛볼 수 있는 것</li>
        </ul>
        <p style="margin-top:8px;">서두르지 않아도 돼요. 한 번에 하나씩, 마음이 지금 여기에 닿을 때까지.</p>
    `);
    await botSay('끝나시면 어떤 게 떠올랐는지 들려주셔도 좋아요.', 900);
    state.awaitingInput = true;
}

// =====================================================================
// 14) 안전 계획
// =====================================================================
function loadSafetyPlan() {
    try {
        const raw = localStorage.getItem(SAFETY_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        Object.entries(data).forEach(([key, val]) => {
            const el = document.querySelector(`[data-safety="${key}"]`);
            if (el) el.value = val;
        });
    } catch (e) { /* ignore */ }
}
function saveSafetyPlan() {
    const data = {};
    document.querySelectorAll('[data-safety]').forEach(el => {
        data[el.dataset.safety] = el.value;
    });
    localStorage.setItem(SAFETY_KEY, JSON.stringify(data));

    const btn = $('#safety-save');
    btn.textContent = '저장됨 ✓';
    setTimeout(() => { btn.textContent = '저장'; }, 1500);
}

// =====================================================================
// 15) 기분 기록
// =====================================================================
const MOOD_EMOJIS = ['😢','😞','😔','😕','😐','🙂','😊','😄','✨','🌟'];

function setupMoodModal() {
    const slider = $('#mood-slider');
    const value = $('#mood-value');
    const emoji = $('#mood-emoji');
    const update = () => {
        const v = parseInt(slider.value, 10);
        value.textContent = v;
        emoji.textContent = MOOD_EMOJIS[v - 1] || '😐';
    };
    slider.addEventListener('input', update);
    update();
}

function saveMoodEntry() {
    const score = parseInt($('#mood-slider').value, 10);
    const note  = $('#mood-note').value.trim();

    state.moodLog.push({
        score, note, ts: Date.now(),
        source: 'manual',
    });

    // 노트가 있으면 학습에도 사용
    if (note) {
        const sentiment = score <= 4 ? classifySentiment(note) || 'sad'
                        : score >= 7 ? 'positive' : 'neutral';
        learnFromMessage(note, sentiment);
    }

    saveState();

    // 초기화
    $('#mood-note').value = '';
    $('#mood-slider').value = 5;
    setupMoodModal();

    closeModal('mood-modal');

    // 채팅에 안내
    addSystem(`기분 기록 저장 · ${score}점`);

    // 통찰 갱신
    if (document.querySelector('[data-view="insights"]').classList.contains('active')) renderInsights();
    if (document.querySelector('[data-view="journal"]').classList.contains('active'))  renderJournal();
}

// =====================================================================
// 16) 개인정보 / 데이터 모달
// =====================================================================
function refreshPrivacyStats() {
    $('#stat-messages').textContent = state.history.length;
    $('#stat-mood').textContent = state.moodLog.length;
    const wordCount = Object.values(state.lexicon).reduce((s, cat) => s + Object.keys(cat).length, 0);
    $('#stat-words').textContent = wordCount;
    $('#stat-assessments').textContent = state.assessmentHistory.length;
    $('#learning-toggle').checked = state.learningEnabled;
    $('#contribution-toggle').checked = state.contributionEnabled;
    updateContributionStatus(state.contributionEnabled ? 'idle' : null);
}

function exportData() {
    const data = {
        exportedAt: new Date().toISOString(),
        ori: state,
        safetyPlan: localStorage.getItem(SAFETY_KEY)
            ? JSON.parse(localStorage.getItem(SAFETY_KEY)) : null,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ori-data-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// =====================================================================
// 16.5) 만족도 조사 (Satisfaction Survey)
// ---------------------------------------------------------------------
// 사용자 평가를 익명으로 수집해 오리 개선에 반영.
// - 자유 대화 N턴 이상 진행 후 1회 부드럽게 안내 (스팸 방지)
// - 사이드 패널 '만족도 평가' 버튼으로 언제든 다시 열기 가능
// - 평균값만 익명 기여에 포함, 개별 코멘트 원문은 로컬에만 보관
// =====================================================================
const SATISFACTION_TRIGGER_TURNS = 8;       // 사용자 메시지 N개 이상이면 안내
const SATISFACTION_MIN_GAP_DAYS  = 3;       // 같은 사람에게 N일 내 재안내 금지
const SATISFACTION_MIN_IDLE_MS    = 3 * 60 * 1000;

// 모달 안의 임시 선택 상태
const satisfactionDraft = {
    helpfulness: 0,
    ease: 0,
    reuseIntent: 0,
    bestFeature: null,
};

function resetSatisfactionDraft() {
    satisfactionDraft.helpfulness = 0;
    satisfactionDraft.ease = 0;
    satisfactionDraft.reuseIntent = 0;
    satisfactionDraft.bestFeature = null;
}

function paintSatisfactionStars() {
    document.querySelectorAll('#satisfaction-modal .star-row').forEach(row => {
        const field = row.dataset.field;
        const value = satisfactionDraft[field] || 0;
        row.querySelectorAll('.star-btn').forEach(btn => {
            const v = parseInt(btn.dataset.value, 10);
            btn.classList.toggle('active', v <= value);
        });
    });
    document.querySelectorAll('#satisfaction-modal .feature-chip').forEach(chip => {
        chip.classList.toggle('selected', chip.dataset.value === satisfactionDraft.bestFeature);
    });
}

function setupSatisfactionModal() {
    // 별점 클릭
    document.querySelectorAll('#satisfaction-modal .star-row').forEach(row => {
        const field = row.dataset.field;
        row.querySelectorAll('.star-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                satisfactionDraft[field] = parseInt(btn.dataset.value, 10);
                paintSatisfactionStars();
            });
        });
    });

    // 가장 도움된 기능 (단일 선택, 다시 누르면 해제)
    document.querySelectorAll('#satisfaction-modal .feature-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const v = chip.dataset.value;
            satisfactionDraft.bestFeature = (satisfactionDraft.bestFeature === v) ? null : v;
            paintSatisfactionStars();
        });
    });

    // 제출
    $('#satisfaction-submit').addEventListener('click', submitSatisfaction);
}

function openSatisfactionModal() {
    resetSatisfactionDraft();
    paintSatisfactionStars();
    $('#satisfaction-comment').value = '';
    $('#satisfaction-form').classList.remove('hidden');
    $('#satisfaction-thanks').classList.add('hidden');
    openModal('satisfaction-modal');
}

function submitSatisfaction() {
    // 별점 3개는 필수
    if (!satisfactionDraft.helpfulness || !satisfactionDraft.ease || !satisfactionDraft.reuseIntent) {
        // 미입력 알림 — 모달 상단 sub 문구 잠시 강조
        const sub = $('#satisfaction-modal .modal-sub');
        const original = sub.textContent;
        sub.textContent = '세 가지 별점 항목을 모두 골라주세요.';
        sub.style.color = 'var(--coral-deep)';
        setTimeout(() => { sub.textContent = original; sub.style.color = ''; }, 2200);
        return;
    }

    const record = {
        helpfulness: satisfactionDraft.helpfulness,
        ease: satisfactionDraft.ease,
        reuseIntent: satisfactionDraft.reuseIntent,
        bestFeature: satisfactionDraft.bestFeature || null,
        comment: ($('#satisfaction-comment').value || '').trim().slice(0, 500),
        ts: Date.now(),
    };

    state.satisfactionLog.push(record);
    // 로컬 평가 기록은 최근 50건까지만 보관
    state.satisfactionLog = state.satisfactionLog.slice(-50);
    saveState();

    // 익명 옵트인 사용자라면 평균값만 서버로 전송 (개별 코멘트 원문은 절대 X)
    if (state.contributionEnabled) contributeData();

    // 감사 화면으로 전환
    $('#satisfaction-form').classList.add('hidden');
    $('#satisfaction-thanks').classList.remove('hidden');

    // 1.6초 후 자동 닫기
    setTimeout(() => {
        closeModal('satisfaction-modal');
    }, 1600);
}

function isGeneralQuestionInProgress(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return false;
    return /[?？]$/.test(trimmed)
        || /(요리|레시피|메뉴|공부|시험|과제|농담|웃긴|테스트|잡담|뭐야|뭐니|어떻게|왜|언제|추천|알려줘|설명해줘)/.test(trimmed);
}

/** 자유 대화 도중 적절한 시점에 부드럽게 1회 안내 */
async function maybeOfferSatisfactionPrompt(lastUserMessage = '') {
    if (DEBUG_DISABLE_AUTO_SATISFACTION) return;
    if (state.flow !== 'idle') return;
    if (isGeneralQuestionInProgress(lastUserMessage)) return;

    // 이미 최근에 평가했거나 너무 자주 안내한 경우 패스
    if (state.satisfactionPromptCount >= 2) return;

    const userTurns = state.dailyUserTurns || 0;
    if (userTurns < SATISFACTION_TRIGGER_TURNS) return;

    const dailyStartedAt = state.dailyModeStartedAt || state.sessionBuffer.startedAt || Date.now();
    if ((Date.now() - dailyStartedAt) < SATISFACTION_MIN_IDLE_MS) return;

    const lastEval = state.satisfactionLog[state.satisfactionLog.length - 1];
    if (lastEval && (Date.now() - lastEval.ts) < SATISFACTION_MIN_GAP_DAYS * 24 * 60 * 60 * 1000) return;

    // 위기 모드일 때는 절대 안내하지 않음 (불쾌·부적절)
    if (state.mode === 'crisis') return;

    state.satisfactionPromptCount += 1;
    saveState();

    await botSay('대화가 좀 진행된 김에, 잠깐 짧은 평가 한 번 부탁드려도 될까요? 오리가 더 잘 도와드리는 데 큰 도움이 돼요.', 900);
    showQuickReplies([
        { label: '네, 평가할게요', onSelect: () => { clearQuickReplies(); openSatisfactionModal(); } },
        { label: '나중에',          onSelect: () => { clearQuickReplies(); state.awaitingInput = true; } },
    ]);
}

// =====================================================================
// 17) 이벤트 바인딩
// =====================================================================
function bindEvents() {
    // 입력
    sendBtn.addEventListener('click', () => handleUserMessage(userInput.value));
    userInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') handleUserMessage(userInput.value);
    });

    // 다크모드
    const themeSwitch = $('#theme-switch');
    if (localStorage.getItem(THEME_KEY) === 'dark') {
        themeSwitch.checked = true;
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    themeSwitch.addEventListener('change', () => {
        if (themeSwitch.checked) {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem(THEME_KEY, 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, 'light');
        }
    });

    // 새로 시작
    $('#reset-btn').addEventListener('click', () => {
        if (!confirm('대화를 새로 시작할까요? 학습된 어휘·기분 기록·자가점검 이력은 그대로 보관돼요.')) return;
        // 이번 세션 요약을 episodicLog에 저장 후 새 시작
        flushSessionToEpisodic();
        chatWindow.innerHTML = '';
        clearQuickReplies();
        hideProgress();
        state.history = [];
        state.assessment = { type: null, index: 0, answers: [], startedAt: null };
        state.flow = 'onboarding';
        setMode('daily');
        saveState();
        startOnboarding();
    });

    // 사이드 패널 탭
    $$('.panel-tab').forEach(tab => {
        tab.addEventListener('click', () => switchPanel(tab.dataset.panel));
    });

    // 도구 버튼
    $$('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tool = btn.dataset.tool;
            if (tool === 'breathing') openModal('breathing-modal');
            if (tool === 'grounding') doGrounding();
            if (tool === 'mood')      openModal('mood-modal');
            if (tool === 'checkup')   { clearQuickReplies(); askGateway(); }
            if (tool === 'safety')    openModal('safety-modal');
            if (tool === 'satisfaction') openSatisfactionModal();
            if (tool === 'recheck') {
                const last = state.assessmentHistory[state.assessmentHistory.length - 1];
                if (last) proposeAssessment(last.type);
                else { clearQuickReplies(); askGateway(); }
            }
        });
    });

    // 외부 링크
    $('#locate-btn').addEventListener('click', () => {
        window.open('https://www.nct.go.kr/distMental/rule/rule02_2.do', '_blank');
    });

    // 호흡 모달
    $('#breathing-start').addEventListener('click', () => {
        $('#breathing-start').disabled = true;
        $('#breathing-start').textContent = '진행 중…';
        runBreathingCycle();
    });

    // 안전 계획
    $('#safety-save').addEventListener('click', saveSafetyPlan);
    $('#safety-export').addEventListener('click', () => window.print());

    // 개인정보 모달
    $('#privacy-btn').addEventListener('click', () => {
        refreshPrivacyStats();
        openModal('privacy-modal');
    });
    $('#learning-toggle').addEventListener('change', e => {
        state.learningEnabled = e.target.checked;
        saveState();
    });

    // 데이터 기여 토글: ON 으로 켤 때만 동의 다이얼로그 → OFF 는 즉시 반영
    $('#contribution-toggle').addEventListener('change', e => {
        if (e.target.checked) {
            // 켤 때는 항상 별도 동의 다이얼로그
            e.target.checked = false; // 동의 전까지 시각적으로도 OFF
            openModal('consent-modal');
        } else {
            state.contributionEnabled = false;
            saveState();
            updateContributionStatus(null);
        }
    });

    // 동의 다이얼로그 — 동의
    $('#consent-accept').addEventListener('click', async () => {
        state.contributionEnabled = true;
        ensureAnonymousId();
        saveState();
        $('#contribution-toggle').checked = true;
        closeModal('consent-modal');
        updateContributionStatus('idle');
        // 즉시 첫 기여 시도
        await contributeData();
    });
    // 거절
    $('#consent-decline').addEventListener('click', () => {
        state.contributionEnabled = false;
        saveState();
        $('#contribution-toggle').checked = false;
        closeModal('consent-modal');
        updateContributionStatus(null);
    });
    // 서버 데이터 삭제 요청
    $('#delete-server-data').addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('서버에 저장된 내 익명 기여분의 삭제를 요청할까요?')) return;
        await requestServerDeletion();
        alert('삭제 요청이 전송되었습니다. (서버 미연결 시 큐에 저장됩니다)');
    });

    $('#export-data').addEventListener('click', exportData);
    $('#delete-data').addEventListener('click', () => {
        if (confirm('정말 모든 데이터를 삭제할까요? 되돌릴 수 없습니다.')) clearAllData();
    });

    // 기분 기록 모달
    $('#add-mood-btn').addEventListener('click', () => openModal('mood-modal'));
    $('#save-mood').addEventListener('click', saveMoodEntry);

    // 모달 닫기 (배경/X 버튼 공통)
    $$('[data-close-modal]').forEach(el => {
        el.addEventListener('click', e => {
            const modal = el.closest('.modal');
            if (modal) closeModal(modal.id);
        });
    });

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            $$('.modal').forEach(m => {
                if (!m.classList.contains('hidden')) closeModal(m.id);
            });
        }
    });
}

// =====================================================================
// 18) 부팅
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    loadSafetyPlan();
    setupMoodModal();
    setupSatisfactionModal();
    bindEvents();
    setMode(state.mode || 'daily');

    // 세션 버퍼 시작 시각 기록
    if (!state.sessionBuffer.startedAt) state.sessionBuffer.startedAt = Date.now();

    startOnboarding();

    // 백엔드 health 체크 — Gemini 활성화 여부 확인
    checkBackendHealth();

    // 옵트인 사용자: 큐에 남은 기여분 재시도 + 5분 주기 자동 동기화
    if (state.contributionEnabled) {
        setTimeout(() => contributeData(), 10000);
        setInterval(() => contributeData(), 5 * 60 * 1000);
    }

    // 페이지 종료 시 세션 요약을 episodicLog에 저장
    window.addEventListener('pagehide', () => {
        flushSessionToEpisodic();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSessionToEpisodic();
        }
    });
});

/** 백엔드 활성화 여부 확인 → 채팅 헤더 뱃지 업데이트 */
async function checkBackendHealth() {
    const badge = document.getElementById('chat-model-badge');
    if (!badge) return;

    if (!API_BASE) {
        updateChatModelBadge('rule');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/v1/health`, {
            method: 'GET',
            signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
        });
        if (!res.ok) throw new Error('not ok');
        const data = await res.json();
        if (data.gemini) {
            updateChatModelBadge('gemini');
        } else {
            updateChatModelBadge('rule');
        }
    } catch (e) {
        updateChatModelBadge('offline');
    }
}
