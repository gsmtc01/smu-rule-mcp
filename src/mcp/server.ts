#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  STATE,
  asRow,
  asRows,
  findRegulations,
  getArticles,
  getMeta,
  getRegulation,
  openDb,
  resolveDbPath,
  searchArticles,
  type Regulation,
} from './db.js';
import { cacheInfo, fetchFormFile } from './download.js';

/**
 * 상명대학교 규정 조회 MCP 서버 (stdio).
 *
 * 상시 서버가 없다. 클라이언트가 필요할 때만 이 프로세스를 띄우고,
 * 야간에 만들어진 로컬 DB를 읽어 응답한다.
 */

const db = openDb();
const meta = getMeta(db);

/** 출력 상단에 데이터 기준 시점을 밝힌다. 최신 개정이 빠졌을 수 있음을 알리기 위함. */
const STALENESS = meta.built_at
  ? `데이터 기준: ${meta.built_at.slice(0, 10)} (원문: https://rule.smu.ac.kr)`
  : '데이터 기준 시점 미상';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

function fmtRegulation(r: Regulation): string {
  const state = r.statecd === STATE.repealed ? '폐지' : '현행';
  const rev = r.revcha ? `${r.revcd ?? ''} ${r.revcha}차` : (r.revcd ?? '');
  return [
    `${r.title} [${r.bookcode ?? '-'}]`,
    `  구분: ${r.bookcd ?? '-'} / ${state}`,
    `  ${rev.trim()} · 공포 ${r.promuldt ?? '-'} · 시행 ${r.startdt ?? '-'}`,
    `  소관: ${r.deptname ?? '-'}  (bookid: ${r.bookid})`,
  ].join('\n');
}

/**
 * 서버 인스턴스를 만든다.
 *
 * HTTP(stateless) 모드에서는 요청마다 새 인스턴스와 트랜스포트가 필요하다.
 * 하나를 재사용하면 첫 응답 뒤 트랜스포트가 닫혀 이후 요청이 조용히 실패한다.
 */
function buildServer(): McpServer {
const server = new McpServer({ name: 'smu-rule-mcp', version: '0.1.0' });

server.registerTool(
  'search_regulation',
  {
    title: '규정 조문 검색',
    description:
      '상명대학교 규정을 조문 단위로 전문검색한다. 어느 규정 몇 조에 해당 내용이 있는지 특정해 돌려준다.',
    inputSchema: {
      query: z.string().describe('검색어 (예: 장학금, 휴학, 징계위원회)'),
      limit: z.number().int().min(1).max(50).optional().describe('최대 결과 수 (기본 10)'),
      include_repealed: z.boolean().optional().describe('폐지 규정 포함 여부 (기본 false)'),
      type: z.enum(['정관', '규정', '시행세칙', '내규']).optional().describe('규정 종류 한정'),
    },
  },
  async ({ query, limit, include_repealed, type }) => {
    const hits = searchArticles(db, query, {
      limit,
      state: include_repealed ? undefined : STATE.current,
      bookcd: type,
    });
    if (hits.length === 0) return text(`"${query}"에 해당하는 조문이 없습니다.\n${STALENESS}`);

    const body = hits
      .map((h, i) => {
        const head = h.heading ? ` (${h.heading})` : '';
        const snippet = h.body.replace(/\s+/g, ' ').slice(0, 400);
        return `${i + 1}. ${h.title} ${h.article_label}${head}\n   ${snippet}${
          h.body.length > 400 ? '…' : ''
        }\n   bookid: ${h.bookid}`;
      })
      .join('\n\n');
    return text(`"${query}" 검색 결과 ${hits.length}건\n${STALENESS}\n\n${body}`);
  },
);

server.registerTool(
  'get_regulation_text',
  {
    title: '규정 전문 조회',
    description: '규정 하나의 전문을 조문 순서대로 돌려준다. bookid 또는 규정명으로 지정한다.',
    inputSchema: {
      bookid: z.string().optional().describe('규정 ID (검색 결과에 포함됨)'),
      title: z.string().optional().describe('규정명 (부분 일치, bookid가 없을 때 사용)'),
      article: z.string().optional().describe('특정 조만 조회 (예: 제12조)'),
    },
  },
  async ({ bookid, title, article }) => {
    let reg = bookid ? getRegulation(db, bookid) : undefined;
    if (!reg && title) {
      const found = findRegulations(db, { title, limit: 5 });
      if (found.length === 0) return text(`"${title}"에 해당하는 규정이 없습니다.`);
      // "학칙"은 "대학원 학칙"에도 부분 일치한다. 정확히 같은 이름이 있으면 그것을 쓴다.
      const exact = found.filter((r) => r.title === title);
      if (exact.length === 1) found.splice(0, found.length, exact[0]);
      if (found.length > 1) {
        return text(
          `여러 규정이 일치합니다. bookid로 다시 지정하세요.\n\n` +
            found.map(fmtRegulation).join('\n\n'),
        );
      }
      reg = found[0];
    }
    if (!reg) return text('bookid 또는 title 중 하나를 지정해야 합니다.');

    let arts = getArticles(db, reg.bookid);
    if (article) {
      const norm = article.replace(/\s/g, '');
      arts = arts.filter((a) => a.article_label.replace(/\s/g, '') === norm);
      if (arts.length === 0) return text(`${reg.title}에 ${article}이(가) 없습니다.`);
    }

    const head = `${fmtRegulation(reg)}\n${STALENESS}`;
    const body = arts.map((a) => a.body).join('\n\n');
    return text(`${head}\n\n${'─'.repeat(50)}\n\n${body}`);
  },
);

server.registerTool(
  'list_regulations',
  {
    title: '규정 목록',
    description: '규정 목록을 규정명·소관부서·종류로 걸러 돌려준다.',
    inputSchema: {
      title: z.string().optional().describe('규정명 부분 일치'),
      dept: z.string().optional().describe('소관부서 부분 일치 (예: 학사운영팀)'),
      type: z.enum(['정관', '규정', '시행세칙', '내규']).optional(),
      include_repealed: z.boolean().optional().describe('폐지 규정 포함 (기본 false)'),
      limit: z.number().int().min(1).max(300).optional(),
    },
  },
  async ({ title, dept, type, include_repealed, limit }) => {
    const rows = findRegulations(db, {
      title,
      dept,
      bookcd: type,
      state: include_repealed ? undefined : STATE.current,
      limit,
    });
    if (rows.length === 0) return text('조건에 맞는 규정이 없습니다.');
    return text(`${rows.length}건\n${STALENESS}\n\n${rows.map(fmtRegulation).join('\n\n')}`);
  },
);

server.registerTool(
  'get_recent_amendments',
  {
    title: '최신 제·개정 정보',
    description: '최근 제·개정된 규정을 공포일 역순으로 돌려준다.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('기본 20'),
      since: z.string().optional().describe('이 날짜 이후만 (YYYY-MM-DD)'),
    },
  },
  async ({ limit, since }) => {
    const rows = asRows<Regulation>(
      db
        .prepare(
          `SELECT bookid, bookcode, bookcd, title, revcd, revcha, statecd, promuldt, startdt, deptname
             FROM regulations
            WHERE statecd = ? AND promuldt IS NOT NULL ${since ? 'AND promuldt >= ?' : ''}
            ORDER BY promuldt DESC
            LIMIT ?`,
        )
        .all(...(since ? [STATE.current, since] : [STATE.current]), Math.min(limit ?? 20, 100)),
    );
    if (rows.length === 0) return text('해당 기간의 제·개정 정보가 없습니다.');
    return text(`최근 제·개정 ${rows.length}건\n${STALENESS}\n\n${rows.map(fmtRegulation).join('\n\n')}`);
  },
);

server.registerTool(
  'list_repealed',
  {
    title: '폐지 규정 목록',
    description: '폐지된 규정 목록을 돌려준다.',
    inputSchema: {
      title: z.string().optional().describe('규정명 부분 일치'),
      limit: z.number().int().min(1).max(300).optional(),
    },
  },
  async ({ title, limit }) => {
    const rows = findRegulations(db, { title, state: STATE.repealed, limit });
    if (rows.length === 0) return text('조건에 맞는 폐지 규정이 없습니다.');
    return text(`폐지 규정 ${rows.length}건\n${STALENESS}\n\n${rows.map(fmtRegulation).join('\n\n')}`);
  },
);

server.registerTool(
  'list_forms',
  {
    title: '별표·서식 목록',
    description:
      '규정에 딸린 별표·서식(HWP)의 목록을 돌려준다. 파일은 download_form으로 내려받는다.',
    inputSchema: {
      title: z.string().optional().describe('규정명 부분 일치'),
      keyword: z.string().optional().describe('별표·서식 파일명 부분 일치'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ title, keyword, limit }) => {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (title) {
      conds.push('title LIKE ?');
      args.push(`%${title}%`);
    }
    if (keyword) {
      conds.push('pcfilename LIKE ?');
      args.push(`%${keyword}%`);
    }
    const rows = db
      .prepare(
        `SELECT serverfile, pcfilename, title, bookcode, promuldt
           FROM forms
          ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
          ORDER BY ordsort LIMIT ?`,
      )
      .all(...args, Math.min(limit ?? 30, 200)) as {
      serverfile: string;
      pcfilename: string;
      title: string | null;
      bookcode: string | null;
      promuldt: string | null;
    }[];

    if (rows.length === 0) return text('조건에 맞는 별표·서식이 없습니다.');
    const body = rows
      .map((r) => `· ${r.pcfilename}\n    규정: ${r.title ?? '-'} [${r.bookcode ?? '-'}] · ${r.serverfile}`)
      .join('\n');
    return text(`별표·서식 ${rows.length}건\n${STALENESS}\n\n${body}`);
  },
);

server.registerTool(
  'download_form',
  {
    title: '별표·서식 파일 내려받기',
    description:
      '별표·서식 HWP 파일을 내려받아 원래 파일명으로 저장하고 경로를 돌려준다. ' +
      'serverfile은 list_forms 결과에 포함되어 있다. ' +
      '이 도구만 원본 시스템에 접속하며, 받은 파일은 영구 캐시되어 재요청 시 다시 받지 않는다.',
    inputSchema: {
      serverfile: z.string().describe('서버 파일 ID (예: 110294380.hwp)'),
      output_dir: z
        .string()
        .optional()
        .describe('저장할 디렉터리. 생략하면 사용자가 접근 가능한 기본 위치에 저장한다.'),
    },
  },
  async ({ serverfile, output_dir }) => {
    const row = asRow<{ serverfile: string; pcfilename: string; title: string | null }>(
      db
        .prepare('SELECT serverfile, pcfilename, title FROM forms WHERE serverfile = ?')
        .get(serverfile),
    );
    if (!row) {
      return text(
        `serverfile "${serverfile}"을(를) 찾을 수 없습니다. list_forms로 먼저 확인하세요.`,
      );
    }

    try {
      const r = await fetchFormFile(row.serverfile, row.pcfilename, output_dir);
      return text(
        [
          `${row.pcfilename}`,
          `  규정: ${row.title ?? '-'}`,
          `  저장 위치: ${r.path}`,
          `  크기: ${(r.bytes / 1024).toFixed(1)} KB${r.cached ? ' (캐시됨, 원본 접속 없음)' : ''}`,
          '',
          '한글(HWP) 파일입니다. 위 경로에서 바로 열 수 있습니다.',
          '다른 위치에 두려면 output_dir을 지정하세요.',
          '저작권은 상명대학교에 있습니다.',
        ].join('\n'),
      );
    } catch (err) {
      return text(`내려받기에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  'get_data_status',
  {
    title: '데이터 상태',
    description: '로컬 규정 DB의 수집 시점과 수록 건수를 돌려준다.',
    inputSchema: {},
  },
  async () => {
    const n = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return text(
      [
        `DB 경로: ${resolveDbPath()}`,
        `수집 시각: ${meta.built_at ?? '미상'}`,
        `규정 ${n('regulations')}건 · 조문 ${n('articles')}건 · 별표/서식 ${n('forms')}건`,
        `별표 캐시: ${cacheInfo().files}개 파일 (${(cacheInfo().bytes / 1024 / 1024).toFixed(1)} MB)`,
        '',
        '이 데이터는 수집 시점의 사본입니다. 법적 효력을 갖는 것은',
        '상명대학교가 게시한 원문(https://rule.smu.ac.kr)뿐입니다.',
      ].join('\n'),
    );
  },
);

  return server;
}

/**
 * 트랜스포트 선택.
 *
 * 기본은 stdio다. 데스크톱 앱·CLI처럼 프로세스를 직접 띄우는 클라이언트가 쓴다.
 * PORT가 지정되면 Streamable HTTP로 뜬다. claude.ai나 ChatGPT처럼 브라우저에서
 * 쓰는 클라이언트는 로컬 프로세스를 띄울 수 없어 접근 가능한 URL이 필요하다.
 */
const port = Number(process.env.PORT ?? 0);

if (port > 0) {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { createServer } = await import('node:http');

  createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'smu-rule-mcp' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: unknown;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      void (async () => {
        // 요청마다 새로 만들고 끝나면 정리한다(상태 없는 처리).
        const s = buildServer();
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void t.close();
          void s.close();
        });
        await s.connect(t);
        await t.handleRequest(req, res, body);
      })();
    });
  }).listen(port, () => {
    console.error(`smu-rule-mcp: http://localhost:${port} (Streamable HTTP)`);
  });
} else {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}
