import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { SCHEDULE } from './config.js';
import { CrawlAbort, PoliteFetcher } from './politeFetch.js';
import { initSession, ensureSession } from './session.js';
import {
  fetchFormList,
  fetchNoFormText,
  fetchRegulationList,
  fetchRegulationText,
  type RegulationRow,
} from './endpoints.js';
import { extractArticles } from './parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DB_PATH = process.env.SMU_DB_PATH ?? resolve(ROOT, 'data/smu-rule.sqlite');
const SCHEMA_PATH = resolve(__dirname, '../db/schema.sql');

const SCHEMA_VERSION = '2';
const CRAWLER_VERSION = '1.0.0';

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 교내 저사용 시간대에만 수집한다. --force로만 우회할 수 있다. */
function assertWithinWindow(force: boolean): void {
  if (force) return;
  const kstHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  );
  const { startHour, endHour } = SCHEDULE.windowKst;
  if (kstHour < startHour || kstHour >= endHour) {
    throw new CrawlAbort(
      `수집 허용 시간대(KST ${startHour}:00–${endHour}:00) 밖입니다. 현재 ${kstHour}시. ` +
        `의도한 실행이라면 --force를 사용하세요.`,
    );
  }
}

function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/**
 * 스키마 마이그레이션.
 *
 * 매 실행은 직전 배포본을 복원해 이어받으므로, schema.sql의
 * CREATE TABLE IF NOT EXISTS만으로는 이미 만들어진 테이블에 새 열이 붙지 않는다.
 * 여기서 직접 붙인다. schema.sql 쪽 정의는 새 DB를 만들 때 쓰인다.
 */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(regulations)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'missing_since')) {
    db.exec(`ALTER TABLE regulations ADD COLUMN missing_since TEXT`);
    log('스키마 마이그레이션: regulations.missing_since 추가');
  }
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function upsertRegulation(db: DatabaseSync, r: RegulationRow, fetchedAt: string): void {
  db.prepare(
    `INSERT INTO regulations (bookid, obookid, catid, bookcode, bookcd, title, revcd, revcha,
       statecd, promuldt, startdt, deptname, noformyn, ordsort, statehistoryid, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bookid) DO UPDATE SET
       title=excluded.title, revcd=excluded.revcd, revcha=excluded.revcha,
       statecd=excluded.statecd, promuldt=excluded.promuldt, startdt=excluded.startdt,
       deptname=excluded.deptname, ordsort=excluded.ordsort,
       statehistoryid=excluded.statehistoryid, fetched_at=excluded.fetched_at,
       -- 목록에 다시 나타났다면 구판 표시를 해제한다.
       missing_since=NULL`,
  ).run(
    r.bookid,
    r.obookid ?? null,
    r.catid ?? null,
    r.bookcode ?? null,
    r.bookcd ?? null,
    r.title,
    r.revcd ?? null,
    num(r.revcha),
    r.statecd ?? null,
    r.promuldt ?? null,
    r.startdt ?? null,
    r.deptname ?? null,
    r.noformyn ?? null,
    num(r.ordsort),
    r.statehistoryid ?? null,
    fetchedAt,
  );
}

/** 이미 같은 개정판(statehistoryid)의 조문을 갖고 있으면 전문을 다시 받지 않는다. */
function needsText(db: DatabaseSync, r: RegulationRow): boolean {
  const row = db
    .prepare(
      `SELECT r.statehistoryid AS shid, COUNT(a.id) AS n
         FROM regulations r LEFT JOIN articles a ON a.bookid = r.bookid
        WHERE r.bookid = ? GROUP BY r.bookid`,
    )
    .get(r.bookid) as { shid: string | null; n: number } | undefined;

  if (!row || Number(row.n) === 0) return true;
  return row.shid !== r.statehistoryid;
}

function replaceArticles(db: DatabaseSync, bookid: string, title: string, html: string): number {
  const articles = extractArticles(html);
  if (articles.length === 0) return 0;

  // contentless FTS5는 rowid로만 삭제할 수 있으므로 기존 id를 먼저 모은다.
  const oldIds = db.prepare(`SELECT id FROM articles WHERE bookid = ?`).all(bookid) as {
    id: number;
  }[];
  const delFts = db.prepare(`DELETE FROM articles_fts WHERE rowid = ?`);
  for (const { id } of oldIds) delFts.run(id);
  db.prepare(`DELETE FROM articles WHERE bookid = ?`).run(bookid);

  const insArt = db.prepare(
    `INSERT INTO articles (bookid, article_no, article_label, heading, body, amended_note, ord)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFts = db.prepare(
    `INSERT INTO articles_fts (rowid, title, article_label, heading, body) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const a of articles) {
    const info = insArt.run(
      bookid,
      a.articleNo,
      a.articleLabel,
      a.heading,
      a.body,
      a.amendedNote,
      a.ord,
    );
    insFts.run(Number(info.lastInsertRowid), title, a.articleLabel, a.heading ?? '', a.body);
  }
  return articles.length;
}

function countSuperseded(db: DatabaseSync): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM regulations WHERE missing_since IS NOT NULL`).get() as {
      n: number;
    }).n,
  );
}

/**
 * 목록에서 사라진 규정을 구판으로 표시한다.
 *
 * upsertRegulation이 목록에 있는 행마다 fetched_at을 이번 실행 시각으로 덮으므로,
 * 그보다 오래된 행은 이번 목록에 없었던 것이다. 원본은 개정 시 새 bookid를 발급하고
 * 옛 bookid를 목록에서 빼는데 삭제 신호는 주지 않는다. 표시하지 않고 두면 구판이
 * statecd=5000(현행)인 채로 남아 검색·목록에 현행처럼 섞인다.
 *
 * 지우지는 않는다. 이 프로젝트는 폐지 규정도 이력으로 보존하며, bookid로 직접
 * 조회하면 구판 전문도 계속 볼 수 있어야 한다.
 */
function markSuperseded(db: DatabaseSync, fetchedAt: string): void {
  const stale = db
    .prepare(
      `SELECT bookid, title, revcha, promuldt FROM regulations
        WHERE fetched_at < ? AND missing_since IS NULL`,
    )
    .all(fetchedAt) as {
    bookid: string;
    title: string;
    revcha: number | null;
    promuldt: string | null;
  }[];

  if (stale.length === 0) return;

  transaction(db, () => {
    const mark = db.prepare(`UPDATE regulations SET missing_since = ? WHERE bookid = ?`);
    for (const s of stale) mark.run(fetchedAt, s.bookid);
  });

  log(`목록에서 사라진 규정 ${stale.length}건을 구판으로 표시`);
  for (const s of stale) {
    log(`  · ${s.title} (${s.bookid}, 개정 ${s.revcha ?? '?'}차 ${s.promuldt ?? '-'})`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  assertWithinWindow(force);

  const db = openDb();
  const fetcher = new PoliteFetcher();
  const fetchedAt = new Date().toISOString();

  log('세션 초기화');
  await initSession(fetcher);

  // 1) 목록: 현행 + 폐지
  const all: RegulationRow[] = [];
  for (const key of ['A', 'F'] as const) {
    const list = await fetchRegulationList(fetcher, key);
    log(`목록 ${key}: ${list.result.length}건 (total=${list.total})`);
    all.push(...list.result);
  }

  transaction(db, () => {
    for (const r of all) upsertRegulation(db, r, fetchedAt);
  });

  markSuperseded(db, fetchedAt);

  // 2) 전문: 개정판이 바뀐 것만 받는다.
  const targets = all.filter((r) => needsText(db, r));
  log(`전문 수집 대상 ${targets.length}건 (전체 ${all.length}건)`);

  let done = 0;
  for (const r of targets) {
    try {
      const html =
        r.noformyn === 'Y'
          ? await fetchNoFormText(fetcher, r.bookid)
          : await fetchRegulationText(fetcher, r.bookid);

      await ensureSession(fetcher, html);

      let n = 0;
      transaction(db, () => {
        n = replaceArticles(db, r.bookid, r.title, html);
      });
      done++;
      log(`  [${done}/${targets.length}] ${r.title} (조문 ${n})`);
    } catch (err) {
      if (err instanceof CrawlAbort) throw err;
      // 개별 실패는 건너뛴다. 다음 실행에서 다시 대상이 된다.
      log(`  ! 실패: ${r.title} (${r.bookid}): ${String(err)}`);
    }
  }

  // 3) 별표·서식: 메타데이터만. 파일은 요청 시 내려받는다.
  const forms = await fetchFormList(fetcher);
  log(`별표·서식 메타 ${forms.result.length}건 (total=${forms.total})`);

  const insForm = db.prepare(
    `INSERT INTO forms (serverfile, bookid, pcfilename, title, bookcode, bookcd, filecd,
       revcd, revcha, statecd, promuldt, startdt, ordsort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(serverfile) DO UPDATE SET
       pcfilename=excluded.pcfilename, title=excluded.title, statecd=excluded.statecd,
       promuldt=excluded.promuldt, startdt=excluded.startdt, ordsort=excluded.ordsort`,
  );
  const knownBook = db.prepare(`SELECT 1 AS ok FROM regulations WHERE bookid = ?`);

  transaction(db, () => {
    for (const f of forms.result) {
      insForm.run(
        f.serverfile,
        // 목록에 없는 규정을 참조하면 FK 제약에 걸리므로 끊어 둔다.
        knownBook.get(f.bookid) ? f.bookid : null,
        f.pcfilename,
        f.title ?? null,
        f.bookcode ?? null,
        f.bookcd ?? null,
        f.filecd ?? null,
        f.revcd ?? null,
        num(f.revcha),
        f.statecd ?? null,
        f.promuldt ?? null,
        f.startdt ?? null,
        num(f.ordsort),
      );
    }
  });

  const meta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  meta.run('schema_version', SCHEMA_VERSION);
  meta.run('crawler_version', CRAWLER_VERSION);
  meta.run('built_at', new Date().toISOString());
  meta.run('source_url', 'https://rule.smu.ac.kr');
  meta.run('regulation_count', String(all.length));
  meta.run('form_count', String(forms.result.length));
  meta.run('superseded_count', String(countSuperseded(db)));

  log(`완료. 요청 ${fetcher.stats.requests}회, DB: ${DB_PATH}`);
  db.close();
}

main().catch((err) => {
  if (err instanceof CrawlAbort) {
    log(`중단: ${err.message}`);
    process.exit(2);
  }
  log(`오류: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
