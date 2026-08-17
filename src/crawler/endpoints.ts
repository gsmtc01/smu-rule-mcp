import { BASE, ORIGIN } from './config.js';
import { encodeForm, encodeValue } from './euckr.js';
import type { PoliteFetcher } from './politeFetch.js';

/**
 * 원격 엔드포인트 래퍼.
 *
 * 응답 본문 앞에 세션 확인용 스크립트가 함께 실려 오므로, JSON.parse 전에
 * 실제 JSON이 시작하는 지점부터 잘라내야 한다. 이 처리를 빠뜨리면 모든
 * 파싱이 실패한다.
 */

function parseJsonAfterPreamble<T>(text: string): T {
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error(`JSON을 찾을 수 없습니다: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start)) as T;
}

export interface RegulationRow {
  bookid: string;
  obookid: string;
  catid: string;
  bookcode: string;
  bookcd: string;
  title: string;
  revcd: string;
  revcha: string;
  statecd: string;
  promuldt: string;
  startdt: string;
  deptname: string;
  noformyn: string;
  ordsort: string;
  statehistoryid: string;
}

export interface FormRow {
  bookid: string;
  noformyn: string;
  title: string;
  pcfilename: string;
  serverfile: string;
  bookcode: string;
  bookcd: string;
  revcd: string;
  revcha: string;
  statecd: string;
  promuldt: string;
  startdt: string;
  filecd: string;
  ordsort: string;
}

interface ListResponse<T> {
  total: string;
  result: T[];
}

/** key: A=현행, B=최신 제·개정, F=폐지 */
export type RegulationSet = 'A' | 'B' | 'F';

export async function fetchRegulationList(
  fetcher: PoliteFetcher,
  key: RegulationSet,
  start = 0,
  limit = 500,
): Promise<ListResponse<RegulationRow>> {
  const res = await fetcher.fetch(`${BASE}/getData.jsp`, {
    body: encodeForm({ key, start, limit }),
  });
  return parseJsonAfterPreamble<ListResponse<RegulationRow>>(res.text);
}

export async function fetchFormList(
  fetcher: PoliteFetcher,
  start = 0,
  limit = 3000,
): Promise<ListResponse<FormRow>> {
  const res = await fetcher.fetch(`${BASE}/getData2.jsp`, {
    body: encodeForm({ filecd: '', sgbn: '', schtext: '', start, limit }),
  });
  return parseJsonAfterPreamble<ListResponse<FormRow>>(res.text);
}

/**
 * 규정 전문(HTML).
 *
 * 일반 조회 화면보다 부가 요소가 적고 개정 이력이 [[개정 …]] 형태의 마커로
 * 표기되어 파싱이 단순하므로 이쪽을 주 소스로 사용한다.
 */
export async function fetchRegulationText(
  fetcher: PoliteFetcher,
  bookid: string,
): Promise<string> {
  const res = await fetcher.fetch(
    `${ORIGIN}/smulaw/jsp/bylaw/existing/createHwp.jsp?Bookid=${encodeURIComponent(bookid)}&Pstate=NOW`,
    { heavy: true },
  );
  return res.text;
}

/** 비정형(noformyn=Y) 규정용 조회 화면. */
export async function fetchNoFormText(fetcher: PoliteFetcher, bookid: string): Promise<string> {
  const res = await fetcher.fetch(
    `${BASE}/regulation/regul_board_noForm.jsp?Bookid=${encodeURIComponent(bookid)}`,
    { heavy: true },
  );
  return res.text;
}

/**
 * 별표·서식 파일을 내려받는다.
 *
 * 정책상 일괄 수집하지 않는다(config.ts의 FORM_DOWNLOAD_STRATEGY).
 * 초기화된 세션이 필요하므로 호출 전에 initSession을 마쳐야 한다.
 * pcfilename은 한글을 포함하므로 EUC-KR 인코딩이 필수다.
 */
export async function downloadForm(
  fetcher: PoliteFetcher,
  serverfile: string,
  pcfilename: string,
): Promise<Buffer> {
  const body =
    `Serverfile=${encodeValue(serverfile)}` +
    `&Pcfilename=${encodeValue(pcfilename)}` +
    `&folder=ATTACH`;

  const res = await fetcher.fetch(`${ORIGIN}/smulaw/Download`, {
    body,
    heavy: true,
    binary: true,
  });

  const type = res.headers.get('content-type') ?? '';
  if (res.status !== 200 || type.includes('text/html')) {
    throw new Error(`첨부 내려받기 실패 (${res.status}, ${type}): ${serverfile}`);
  }
  return res.buffer;
}
