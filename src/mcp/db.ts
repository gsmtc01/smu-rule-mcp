import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 조회 계층.
 *
 * MCP 서버는 원본 시스템에 접속하지 않고, 야간 수집으로 만들어진 로컬 DB만 읽는다.
 * 원본 접속이 필요한 것은 별표 파일 내려받기뿐이다(Phase 4).
 */

/**
 * 캐시 위치. Windows는 %LOCALAPPDATA%가 관례이므로 그쪽을 따른다.
 * scripts/updateData.mjs도 같은 규칙을 쓴다. 한쪽만 바꾸면 서로 다른 곳을 본다.
 */
export const DEFAULT_CACHE_DIR =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'smu-rule-mcp')
    : join(homedir(), '.cache', 'smu-rule-mcp');

export function resolveDbPath(): string {
  if (process.env.SMU_DB_PATH) return resolve(process.env.SMU_DB_PATH);
  const cached = join(DEFAULT_CACHE_DIR, 'smu-rule.sqlite');
  if (existsSync(cached)) return cached;
  return resolve('data/smu-rule.sqlite');
}

export function openDb(): DatabaseSync {
  const path = resolveDbPath();
  if (!existsSync(path)) {
    throw new Error(
      `규정 DB를 찾을 수 없습니다: ${path}\n` +
        `'npm run update-data'로 최신 데이터를 내려받거나, SMU_DB_PATH로 경로를 지정하세요.`,
    );
  }
  return new DatabaseSync(path, { readOnly: true });
}

export interface Regulation {
  bookid: string;
  bookcode: string | null;
  bookcd: string | null;
  /** 제목 접미사로 보정한 분류. 표시와 종류 필터는 이 값을 쓴다. */
  bookcd_norm?: string | null;
  title: string;
  revcd: string | null;
  revcha: number | null;
  statecd: string | null;
  promuldt: string | null;
  startdt: string | null;
  deptname: string | null;
  /** 원본 목록에서 사라진 시각. 값이 있으면 개정으로 대체된 구판이다. */
  missing_since?: string | null;
}

export interface ArticleHit {
  bookid: string;
  title: string;
  article_label: string;
  heading: string | null;
  body: string;
  amended_note: string | null;
}

/** 현행 5000 / 폐지 6000 */
export const STATE = { current: '5000', repealed: '6000' } as const;

/**
 * regulations의 열 유무.
 *
 * missing_since는 스키마 2, bookcd_norm은 스키마 3에서 추가됐다. 사용자의 캐시가
 * 그 이전 배포본일 수 있으므로 질의를 조립하기 전에 확인하고, 없으면 그 열에
 * 기대는 동작을 빼서 예전과 같이 처리한다.
 * 프로세스당 DB는 하나이고 실행 중 스키마가 바뀌지 않으므로 한 번만 조회한다.
 */
let regulationColumns: Set<string> | undefined;
function hasColumn(db: DatabaseSync, name: string): boolean {
  if (regulationColumns === undefined) {
    const cols = db.prepare('PRAGMA table_info(regulations)').all() as { name: string }[];
    regulationColumns = new Set(cols.map((c) => c.name));
  }
  return regulationColumns.has(name);
}

/** 구판 표시 열(스키마 2). */
export function hasMissingSince(db: DatabaseSync): boolean {
  return hasColumn(db, 'missing_since');
}

/** 분류 보정 열(스키마 3). */
export function hasBookcdNorm(db: DatabaseSync): boolean {
  return hasColumn(db, 'bookcd_norm');
}

/**
 * 종류 필터에 쓸 열 이름.
 *
 * 원본 bookcd에는 오분류가 있어(현행 301건 중 9건) 보정값 bookcd_norm을 쓴다.
 * 그 열이 없는 예전 캐시에서는 원본 값으로 되돌아간다.
 */
function bookcdColumn(db: DatabaseSync): string {
  return hasColumn(db, 'bookcd_norm') ? 'bookcd_norm' : 'bookcd';
}

/** 조회 결과에 실을 분류 열. 예전 캐시에서는 원본 값을 그대로 보여 준다. */
const bookcdSelect = (db: DatabaseSync, prefix = ''): string =>
  hasColumn(db, 'bookcd_norm')
    ? `${prefix}bookcd_norm`
    : `${prefix}bookcd AS bookcd_norm`;

/**
 * node:sqlite는 결과를 Record<string, SQLOutputValue>로 돌려주므로
 * 선언한 행 타입으로 직접 단언할 수 없다. 캐스팅을 이 한 곳에 모은다.
 */
export const asRows = <T>(r: unknown): T[] => r as T[];
export const asRow = <T>(r: unknown): T | undefined => r as T | undefined;

/**
 * trigram 토크나이저는 3글자 미만 질의를 MATCH로 처리하지 못한다.
 * 그런 경우 LIKE로 우회한다(trigram 인덱스가 LIKE도 가속한다).
 */
export function searchArticles(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number; state?: string; bookcd?: string; includeSuperseded?: boolean } = {},
): ArticleHit[] {
  const limit = Math.min(opts.limit ?? 10, 50);
  const q = query.trim();
  if (!q) return [];

  const filters: string[] = [];
  const extra: (string | number)[] = [];
  if (opts.state) {
    filters.push('r.statecd = ?');
    extra.push(opts.state);
  }
  if (opts.bookcd) {
    filters.push(`r.${bookcdColumn(db)} = ?`);
    extra.push(opts.bookcd);
  }
  // 개정으로 대체된 구판은 기본적으로 뺀다. 두면 3년 묵은 조문이 현행처럼 섞인다.
  if (!opts.includeSuperseded && hasMissingSince(db)) filters.push('r.missing_since IS NULL');
  const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';

  if (q.length >= 3) {
    // FTS5 질의 문법 문자를 그대로 넘기면 구문 오류가 나므로 큰따옴표로 감싼다.
    const phrase = `"${q.replace(/"/g, '""')}"`;
    return asRows<ArticleHit>(db
      .prepare(
        `SELECT a.bookid, r.title, a.article_label, a.heading, a.body, a.amended_note
           FROM articles_fts f
           JOIN articles a ON a.id = f.rowid
           JOIN regulations r ON r.bookid = a.bookid
          WHERE articles_fts MATCH ?${where}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(phrase, ...extra, limit));
  }

  return asRows<ArticleHit>(db
    .prepare(
      `SELECT a.bookid, r.title, a.article_label, a.heading, a.body, a.amended_note
         FROM articles a
         JOIN regulations r ON r.bookid = a.bookid
        WHERE (a.body LIKE ? OR r.title LIKE ?)${where}
        ORDER BY r.ordsort, a.ord
        LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, ...extra, limit));
}

export function findRegulations(
  db: DatabaseSync,
  opts: {
    title?: string;
    dept?: string;
    state?: string;
    bookcd?: string;
    limit?: number;
    includeSuperseded?: boolean;
  },
): Regulation[] {
  const limit = Math.min(opts.limit ?? 50, 300);
  const conds: string[] = [];
  const args: (string | number)[] = [];

  if (opts.title) {
    conds.push('title LIKE ?');
    args.push(`%${opts.title}%`);
  }
  if (opts.dept) {
    conds.push('deptname LIKE ?');
    args.push(`%${opts.dept}%`);
  }
  if (opts.state) {
    conds.push('statecd = ?');
    args.push(opts.state);
  }
  if (opts.bookcd) {
    conds.push(`${bookcdColumn(db)} = ?`);
    args.push(opts.bookcd);
  }
  if (!opts.includeSuperseded && hasMissingSince(db)) conds.push('missing_since IS NULL');

  return asRows<Regulation>(db
    .prepare(
      `SELECT bookid, bookcode, bookcd, ${bookcdSelect(db)},
              title, revcd, revcha, statecd, promuldt, startdt, deptname
         FROM regulations
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY ordsort, bookcode
        LIMIT ?`,
    )
    .all(...args, limit));
}

/** bookid로 직접 조회할 때는 구판도 돌려준다. 구판 여부는 missing_since로 알린다. */
export function getRegulation(db: DatabaseSync, bookid: string): Regulation | undefined {
  const col = hasMissingSince(db) ? 'missing_since' : 'NULL AS missing_since';
  return db
    .prepare(
      `SELECT bookid, bookcode, bookcd, ${bookcdSelect(db)},
              title, revcd, revcha, statecd, promuldt, startdt, deptname, ${col}
         FROM regulations WHERE bookid = ?`,
    )
    .get(bookid) as Regulation | undefined;
}

/** 구판 건수. 없거나 열이 없으면 0. */
export function countSuperseded(db: DatabaseSync): number {
  if (!hasMissingSince(db)) return 0;
  return Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM regulations WHERE missing_since IS NOT NULL')
        .get() as { n: number }
    ).n,
  );
}

export function getArticles(
  db: DatabaseSync,
  bookid: string,
): { article_label: string; heading: string | null; body: string }[] {
  return db
    .prepare(
      `SELECT article_label, heading, body FROM articles WHERE bookid = ? ORDER BY ord`,
    )
    .all(bookid) as { article_label: string; heading: string | null; body: string }[];
}

export function getMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
