import {
  CIRCUIT_BREAKER,
  KILL_SWITCH_ENV,
  RATE_LIMIT,
  RETRY,
  TIMEOUT,
  USER_AGENT,
} from './config.js';
import { decodeBody } from './euckr.js';

/**
 * 수집 정책을 강제하는 단일 진입점.
 *
 * 모든 원격 요청은 이 모듈을 통해야 한다. 여기서 직렬화·지연·백오프·
 * 서킷 브레이커·요청 총량 상한이 함께 적용된다. fetch를 직접 호출하면
 * 정책이 우회되므로 금지.
 */

export class CrawlAbort extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (max: number) => Math.floor(Math.random() * max);

export interface FetchOptions {
  /** EUC-KR로 인코딩이 끝난 폼 본문. 생략하면 GET. */
  body?: string;
  /** 전문·첨부처럼 무거운 응답이면 true. 더 긴 지연을 적용한다. */
  heavy?: boolean;
  /** 바이너리(HWP 등) 응답이면 true. 디코딩하지 않고 Buffer로 돌려준다. */
  binary?: boolean;
  headers?: Record<string, string>;
}

export interface FetchResult {
  status: number;
  /** binary: false일 때 EUC-KR 디코딩된 본문. */
  text: string;
  /** binary: true일 때 원본 바이트. */
  buffer: Buffer;
  headers: Headers;
}

export class PoliteFetcher {
  private requestCount = 0;
  private consecutiveFailures = 0;
  private cumulativeTimeouts = 0;
  /** concurrency: 1 을 보장하기 위한 직렬화 체인. */
  private queue: Promise<unknown> = Promise.resolve();
  private cookie: string | null = null;

  setCookie(cookie: string | null): void {
    this.cookie = cookie;
  }

  getCookie(): string | null {
    return this.cookie;
  }

  get stats() {
    return { requests: this.requestCount };
  }

  /** 요청을 큐에 넣어 항상 직렬로 실행한다. */
  fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const run = this.queue.then(
      () => this.execute(url, opts),
      () => this.execute(url, opts),
    );
    // 체인이 거부로 끊기지 않도록 큐 자체는 항상 resolve 시킨다.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private guard(): void {
    if (process.env[KILL_SWITCH_ENV]) {
      throw new CrawlAbort(`킬 스위치(${KILL_SWITCH_ENV})가 설정되어 수집을 중단합니다.`);
    }
    if (this.requestCount >= RATE_LIMIT.maxRequestsPerRun) {
      throw new CrawlAbort(
        `1회 실행 요청 상한(${RATE_LIMIT.maxRequestsPerRun})에 도달하여 중단합니다.`,
      );
    }
    if (this.consecutiveFailures >= CIRCUIT_BREAKER.consecutiveFailures) {
      throw new CrawlAbort(
        `연속 ${this.consecutiveFailures}회 실패. 서버 부하 신호로 보고 중단합니다.`,
      );
    }
    if (this.cumulativeTimeouts >= CIRCUIT_BREAKER.cumulativeTimeouts) {
      throw new CrawlAbort(
        `타임아웃 ${this.cumulativeTimeouts}회 누적. 서버 부하 신호로 보고 중단합니다.`,
      );
    }
  }

  private async execute(url: string, opts: FetchOptions): Promise<FetchResult> {
    this.guard();

    // 요청 사이 간격. 지터를 섞어 규칙적인 패턴을 피한다.
    const base = opts.heavy ? RATE_LIMIT.heavyDelayMs : RATE_LIMIT.baseDelayMs;
    const jit = opts.heavy ? RATE_LIMIT.heavyJitterMs : RATE_LIMIT.jitterMs;
    if (this.requestCount > 0) await sleep(base + jitter(jit));

    let lastError: unknown;

    for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoff = RETRY.backoffMs[Math.min(attempt - 1, RETRY.backoffMs.length - 1)];
        await sleep(backoff + jitter(1_000));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT.readMs);

      try {
        this.requestCount++;
        const res = await fetch(url, {
          method: opts.body === undefined ? 'GET' : 'POST',
          body: opts.body,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            ...(opts.body !== undefined
              ? { 'Content-Type': 'application/x-www-form-urlencoded' }
              : {}),
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...opts.headers,
          },
        });

        // 429/503: Retry-After를 우선 존중한다.
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1_000 : RETRY.rateLimitedFallbackMs;
          this.consecutiveFailures++;
          lastError = new Error(`HTTP ${res.status}, ${waitMs}ms 대기 후 재시도`);
          await sleep(waitMs);
          continue;
        }

        if (res.status >= 500) {
          this.consecutiveFailures++;
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }

        // 4xx는 재시도하지 않는다. 동일 요청을 반복해봐야 결과가 같다.
        this.consecutiveFailures = 0;
        const buffer = Buffer.from(await res.arrayBuffer());
        return {
          status: res.status,
          buffer,
          text: opts.binary ? '' : decodeBody(buffer),
          headers: res.headers,
        };
      } catch (err) {
        if (controller.signal.aborted) this.cumulativeTimeouts++;
        this.consecutiveFailures++;
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      this.guard();
    }

    throw new Error(`요청 실패 (${RETRY.maxAttempts}회 시도): ${url} / ${String(lastError)}`);
  }
}
