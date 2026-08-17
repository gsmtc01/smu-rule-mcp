/**
 * 최신 규정 DB를 GitHub Release에서 내려받아 로컬 캐시에 둔다.
 *
 * MCP 서버는 원본 시스템이 아니라 이 파일을 읽는다. 데이터는 저장소가 아니라
 * Release로 배포되므로(NOTICE.md §2), 클라이언트는 이 단계를 한 번 거쳐야 한다.
 */
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.env.SMU_MCP_REPO ?? 'gsmtc01/smu-rule-mcp';
const TAG = process.env.SMU_DATA_TAG ?? 'data-latest';
const ASSET = 'smu-rule.sqlite.gz';
const URL_ = process.env.SMU_DATA_URL ?? `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`;

const cacheDir = process.env.SMU_CACHE_DIR ?? join(homedir(), '.cache', 'smu-rule-mcp');
const dbPath = join(cacheDir, 'smu-rule.sqlite');
const tmpPath = `${dbPath}.tmp`;

console.error(`내려받는 중: ${URL_}`);
const res = await fetch(URL_, { redirect: 'follow' });
if (!res.ok) {
  console.error(`실패: HTTP ${res.status}. 배포본이 아직 없을 수 있습니다.`);
  process.exit(1);
}

mkdirSync(cacheDir, { recursive: true });
// 받는 도중 실패해도 기존 DB가 깨지지 않도록 임시 파일에 먼저 쓴다.
await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmpPath));

// 열리는지 확인한 뒤에만 교체한다.
const db = new DatabaseSync(tmpPath, { readOnly: true });
const n = db.prepare('SELECT COUNT(*) AS n FROM regulations').get().n;
const built = db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()?.value;
db.close();

if (!n) {
  console.error('내려받은 DB가 비어 있습니다. 교체하지 않습니다.');
  process.exit(1);
}

const { renameSync } = await import('node:fs');
renameSync(tmpPath, dbPath);
writeFileSync(join(cacheDir, 'NOTICE.txt'), `출처: https://rule.smu.ac.kr\n수집: ${built ?? '미상'}\n규정 데이터의 저작권은 상명대학교에 있습니다.\n`);

console.error(`완료: ${dbPath} (규정 ${n}건, 수집 ${built ?? '미상'})`);
