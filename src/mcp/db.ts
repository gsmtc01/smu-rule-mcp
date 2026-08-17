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
  title: string;
  revcd: string | null;
  revcha: number | null;
  statecd: string | null;
  promuldt: string | null;
  startdt: string | null;
  deptname: string | null;
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
  opts: { limit?: number; state?: string; bookcd?: string } = {},
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
    filters.push('r.bookcd = ?');
    extra.push(opts.bookcd);
  }
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
  opts: { title?: string; dept?: string; state?: string; bookcd?: string; limit?: number },
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
    conds.push('bookcd = ?');
    args.push(opts.bookcd);
  }

  return asRows<Regulation>(db
    .prepare(
      `SELECT bookid, bookcode, bookcd, title, revcd, revcha, statecd, promuldt, startdt, deptname
         FROM regulations
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY ordsort, bookcode
        LIMIT ?`,
    )
    .all(...args, limit));
}

export function getRegulation(db: DatabaseSync, bookid: string): Regulation | undefined {
  return db
    .prepare(
      `SELECT bookid, bookcode, bookcd, title, revcd, revcha, statecd, promuldt, startdt, deptname
         FROM regulations WHERE bookid = ?`,
    )
    .get(bookid) as Regulation | undefined;
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
