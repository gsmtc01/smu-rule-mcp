import { SESSION_INIT } from './config.js';
import type { PoliteFetcher } from './politeFetch.js';

/**
 * 세션 관리.
 *
 * 웹 UI는 진입 시 초기화 호출을 수행하며, 파일 첨부 조회 등 일부 기능은
 * 초기화된 세션을 전제로 동작한다. 배치 실행에서는 세션을 1회만 만들어
 * 실행 내내 재사용한다. 매 요청 재초기화는 요청 수를 2배로 만든다.
 */

export interface Session {
  cookie: string;
  createdAt: number;
}

function extractJsessionId(headers: Headers): string | null {
  // Node의 fetch는 동일 헤더를 합쳐서 돌려주므로 getSetCookie()를 우선 사용한다.
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];

  for (const line of raw) {
    const m = /JSESSIONID=([^;]+)/.exec(line);
    if (m) return `JSESSIONID=${m[1]}`;
  }
  return null;
}

/** 세션을 새로 만들고 fetcher에 쿠키를 심는다. */
export async function initSession(fetcher: PoliteFetcher): Promise<Session> {
  fetcher.setCookie(null);

  const res = await fetcher.fetch(SESSION_INIT.url, { body: SESSION_INIT.body });
  const cookie = extractJsessionId(res.headers);

  if (!cookie) {
    throw new Error('세션 쿠키를 받지 못했습니다. 대상 시스템의 진입 절차가 변경되었을 수 있습니다.');
  }

  // 응답은 {"data":"P"} 형태. 값이 비어 있으면 초기화가 끝나지 않은 것으로 본다.
  let ok = false;
  try {
    ok = Boolean(JSON.parse(res.text.trim())?.data);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`세션 초기화 응답이 예상과 다릅니다: ${res.text.slice(0, 120)}`);
  }

  fetcher.setCookie(cookie);
  return { cookie, createdAt: Date.now() };
}

/**
 * 세션 만료로 보이는 응답인지 판정한다.
 * 만료 시 목록 조회는 진입 페이지로 되돌리는 스크립트를 함께 돌려준다.
 */
export function looksExpired(text: string): boolean {
  return text.includes('/smulaw/index.jsp') && !text.includes('{');
}

/** 만료가 의심되면 세션을 재발급한다. */
export async function ensureSession(fetcher: PoliteFetcher, text: string): Promise<void> {
  if (looksExpired(text)) await initSession(fetcher);
}
