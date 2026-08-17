import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { PoliteFetcher } from '../crawler/politeFetch.js';
import { initSession } from '../crawler/session.js';
import { downloadForm } from '../crawler/endpoints.js';
import { DEFAULT_CACHE_DIR } from './db.js';

/**
 * 별표·서식 파일 내려받기.
 *
 * MCP 서버에서 원본 시스템에 접속하는 유일한 경로다.
 *
 * serverfile ID는 사실상 콘텐츠 주소라 한 번 받은 파일은 내용이 바뀌지 않는다.
 * 따라서 영구 캐시하고, 같은 파일을 다시 요청받으면 네트워크를 쓰지 않는다.
 */

const CACHE_DIR = process.env.SMU_CACHE_DIR
  ? join(process.env.SMU_CACHE_DIR, 'forms')
  : join(DEFAULT_CACHE_DIR, 'forms');

/** 한글 문서(HWP 5.x)는 OLE 복합문서 시그니처로 시작한다. */
const HWP_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function isHwp(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(HWP_MAGIC);
}

/** 파일명에 경로 구분자나 상위 참조가 섞이지 않게 한다. */
function safeName(serverfile: string): string {
  return serverfile.replace(/[^A-Za-z0-9._-]/g, '_');
}

let fetcher: PoliteFetcher | null = null;
let sessionReady = false;

async function ensureFetcher(): Promise<PoliteFetcher> {
  if (!fetcher) {
    fetcher = new PoliteFetcher();
    sessionReady = false;
  }
  if (!sessionReady) {
    await initSession(fetcher);
    sessionReady = true;
  }
  return fetcher;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  cached: boolean;
}

export async function fetchFormFile(
  serverfile: string,
  pcfilename: string,
): Promise<DownloadResult> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, safeName(serverfile));

  if (existsSync(path)) {
    const buf = readFileSync(path);
    if (isHwp(buf)) return { path, bytes: buf.length, cached: true };
    // 캐시가 깨졌으면 다시 받는다.
  }

  let buf: Buffer;
  try {
    buf = await downloadForm(await ensureFetcher(), serverfile, pcfilename);
  } catch (err) {
    // 세션이 만료되면 서버가 오류 페이지를 돌려준다. 한 번만 다시 맺고 재시도한다.
    sessionReady = false;
    fetcher = null;
    buf = await downloadForm(await ensureFetcher(), serverfile, pcfilename);
    void err;
  }

  if (!isHwp(buf)) {
    throw new Error(
      `내려받은 내용이 한글 문서가 아닙니다(${buf.length}바이트). ` +
        `원본 시스템이 오류 페이지를 반환했을 수 있습니다.`,
    );
  }

  writeFileSync(path, buf);
  return { path, bytes: buf.length, cached: false };
}

export function cacheInfo(): { dir: string; files: number; bytes: number } {
  if (!existsSync(CACHE_DIR)) return { dir: CACHE_DIR, files: 0, bytes: 0 };
  const names = readdirSync(CACHE_DIR);
  let bytes = 0;
  for (const n of names) bytes += statSync(join(CACHE_DIR, n)).size;
  return { dir: CACHE_DIR, files: names.length, bytes };
}
