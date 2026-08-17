/**
 * 배포 전 DB 무결성 검사.
 *
 * 수집이 부분적으로 실패해도 프로세스는 정상 종료될 수 있다. 검증 없이
 * 올리면 정상 데이터가 빈 DB로 덮인다. 최소 기준을 만족할 때만 배포한다.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

const DB_PATH = process.env.SMU_DB_PATH ?? 'data/smu-rule.sqlite';

/** 이 값들을 밑도는 결과는 수집 실패로 간주한다. */
const MIN = {
  regulations: 100,
  articles: 1000,
  forms: 500,
  /** 직전 배포 대비 이만큼 넘게 줄면 중단한다(원본 장애·구조 변경 방어). */
  shrinkRatio: 0.8,
};

if (!existsSync(DB_PATH)) {
  console.error(`검증 실패: DB가 없습니다 — ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const count = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);

const stats = {
  regulations: count('regulations'),
  articles: count('articles'),
  forms: count('forms'),
  fts: count('articles_fts'),
};

const meta = Object.fromEntries(
  db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]),
);

console.log('DB 통계:', JSON.stringify(stats));
console.log('메타:', JSON.stringify(meta));
console.log(`파일 크기: ${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);

const errors = [];
for (const [k, min] of Object.entries(MIN)) {
  if (k === 'shrinkRatio') continue;
  if (stats[k] < min) errors.push(`${k} = ${stats[k]} (최소 ${min})`);
}

// 조문과 FTS 인덱스는 항상 1:1이어야 한다. 어긋나면 검색이 조용히 부정확해진다.
if (stats.articles !== stats.fts) {
  errors.push(`articles(${stats.articles}) != articles_fts(${stats.fts}) — 인덱스 불일치`);
}

// 직전 배포본과 비교 (환경변수로 이전 건수를 넘겨준 경우에만).
const prev = Number(process.env.PREV_REGULATION_COUNT ?? 0);
if (prev > 0 && stats.regulations < prev * MIN.shrinkRatio) {
  errors.push(`규정 수가 직전(${prev}) 대비 ${stats.regulations}건으로 급감`);
}

db.close();

if (errors.length > 0) {
  console.error('검증 실패:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}
console.log('검증 통과.');
