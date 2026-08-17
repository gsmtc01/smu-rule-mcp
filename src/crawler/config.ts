/**
 * 수집기 동작 정책 (crawling policy).
 *
 * 대상 시스템은 대규모 자동 트래픽을 상정하고 운영되지 않는다.
 * 여기의 수치는 "정상 이용자 1명 이하"의 부하를 목표로 보수적으로 잡은 값이며,
 * 임의로 완화하지 말 것. 근거는 README.md의 "수집 정책" 절 참조.
 */

export const ORIGIN = 'https://rule.smu.ac.kr';
export const BASE = `${ORIGIN}/smulaw/jsp/lkms3/jsp`;

/**
 * 세션 초기화. 웹 UI가 진입 시 수행하는 것과 동일한 초기화 호출로,
 * 파일 첨부 조회 등 일부 기능이 초기화된 세션을 전제로 동작한다.
 */
export const SESSION_INIT = {
  url: `${ORIGIN}/smulaw/login/noSSO.do`,
  body: 'userid=2',
  /** 배치 실행 중에는 세션을 재사용한다. 매 요청 재초기화는 요청 수를 2배로 만든다. */
  reusePerRun: true,
} as const;

/** 대상 서버는 EUC-KR. 요청 파라미터와 응답 본문 모두 변환이 필요하다. */
export const ENCODING = 'euc-kr';

/**
 * 정직한 User-Agent. 스푸핑하지 않는다.
 * 관리자가 문제 발생 시 차단 대신 연락할 수 있도록 저장소 주소를 포함한다.
 * (연락은 저장소 Issues로 받는다. 메일 주소를 노출하면 수집 대상이 된다.)
 */
export const USER_AGENT = 'SMU-Rule-MCP/1.0 (+https://github.com/gsmtc01/smu-rule-mcp)';

export const RATE_LIMIT = {
  /** 병렬 요청 금지. 항상 직렬로 처리한다. */
  concurrency: 1,
  /** 기본 요청 간 지연(ms). */
  baseDelayMs: 2_000,
  /** 지터 상한(ms). 규칙적인 패턴은 스파이크로 감지되고 부하가 뭉친다. */
  jitterMs: 1_000,
  /** 전문·별표 등 무거운 응답에 적용하는 지연(ms). */
  heavyDelayMs: 3_000,
  heavyJitterMs: 2_000,
  /** 1회 실행에서 허용하는 최대 요청 수(안전장치). 초과 시 중단. */
  maxRequestsPerRun: 2_500,
} as const;

export const TIMEOUT = {
  connectMs: 5_000,
  /** HWP 응답은 느릴 수 있어 넉넉히 잡는다. */
  readMs: 30_000,
} as const;

export const RETRY = {
  /** 4xx는 재시도하지 않는다. 동일 요청을 반복해봐야 낭비다. */
  retryOn: ['network', 'timeout', '5xx'] as const,
  maxAttempts: 3,
  /** 지수 백오프(ms). 각 대기에 0~1000ms 지터를 더한다. */
  backoffMs: [2_000, 4_000, 8_000],
  /** 429/503 수신 시 Retry-After를 우선 준수, 없으면 이 값만큼 대기. */
  rateLimitedFallbackMs: 60_000,
} as const;

/**
 * 서킷 브레이커: 서버가 힘들어하는 신호가 보이면 밀어붙이지 않고 중단한다.
 * 중단 지점은 체크포인트에 기록하고 다음 실행에서 이어받는다.
 */
export const CIRCUIT_BREAKER = {
  consecutiveFailures: 5,
  cumulativeTimeouts: 3,
} as const;

/**
 * 캐시 정책. 요청을 아예 보내지 않는 것이 가장 예의 바른 동작이다.
 * 대상 서버가 ETag/Last-Modified를 제공하지 않을 가능성이 높으므로
 * 조건부 GET 대신 아래의 자체 TTL과 ID 불변성에 의존한다.
 */
export const CACHE = {
  /** 별표 HWP: serverfile ID가 곧 콘텐츠 주소이므로 내용이 바뀌지 않는다. */
  formFile: 'permanent',
  /** 규정 전문: 해당 개정판(statehistoryid)이 바뀌기 전까지 유효. */
  regulationText: 'until-statehistoryid-changes',
  listTtlMs: 6 * 60 * 60 * 1000,
  searchTtlMs: 1 * 60 * 60 * 1000,
} as const;

/**
 * 별표(2,029건)는 초기 일괄 수집하지 않는다.
 * 메타데이터만 미리 확보하고, 파일 자체는 실제 요청이 있을 때 1건씩 받아 영구 캐시한다.
 * 이 설정을 'eager'로 바꾸면 2,029회의 요청이 발생하므로 기본값을 유지할 것.
 */
export const FORM_DOWNLOAD_STRATEGY: 'lazy' | 'eager' = 'lazy';

/** 교내 저사용 시간대(KST)에만 수집한다. */
export const SCHEDULE = {
  windowKst: { startHour: 2, endHour: 5 },
} as const;

/** 킬 스위치: 설정 시 모든 수집을 즉시 중단한다. */
export const KILL_SWITCH_ENV = 'SMU_CRAWLER_DISABLED';
