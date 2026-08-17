import iconv from 'iconv-lite';
import { ENCODING } from './config.js';

/**
 * 대상 시스템은 EUC-KR을 사용한다.
 *
 * 주의: 한글 값을 UTF-8로 인코딩해 보내면 오류 없이 조용히 0건이 반환된다.
 * 실패가 드러나지 않으므로 모든 요청 파라미터는 반드시 이 모듈을 거쳐야 한다.
 */

/** 폼 파라미터 하나를 EUC-KR로 퍼센트 인코딩한다. */
export function encodeValue(value: string): string {
  const bytes = iconv.encode(value, ENCODING);
  let out = '';
  for (const b of bytes) {
    // RFC 3986 unreserved: A-Z a-z 0-9 - _ . ~
    const isUnreserved =
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f ||
      b === 0x2e ||
      b === 0x7e;
    out += isUnreserved ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** key=value 쌍들을 EUC-KR 인코딩된 application/x-www-form-urlencoded 본문으로 만든다. */
export function encodeForm(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeValue(k)}=${encodeValue(String(v))}`)
    .join('&');
}

/** EUC-KR 응답 바이트를 문자열로 디코딩한다. */
export function decodeBody(buf: Buffer | ArrayBuffer): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return iconv.decode(b, ENCODING);
}
