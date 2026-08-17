#!/usr/bin/env node
/**
 * 한 번에 설치하고 MCP 클라이언트에 등록한다.
 *
 *   node scripts/setup.mjs            대화형으로 클라이언트를 고른다
 *   node scripts/setup.mjs --client claude-desktop
 *   node scripts/setup.mjs --print    설정 JSON만 출력한다(직접 붙여넣기)
 *
 * 설정 파일을 고칠 때는 항상 먼저 백업한다. 다른 서버 등록을 건드리지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist', 'mcp', 'server.js');
const IS_WIN = platform() === 'win32';
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)) : undefined;
};

const log = (m) => console.log(m);
const step = (m) => console.log(`\n▸ ${m}`);

/** 설정 파일 경로. 운영체제마다 다르다. */
const CLIENTS = {
  'claude-desktop': {
    label: 'Claude Desktop',
    path: IS_WIN
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    key: 'mcpServers',
  },
  'claude-code': {
    label: 'Claude Code',
    path: join(homedir(), '.claude.json'),
    key: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    path: join(homedir(), '.cursor', 'mcp.json'),
    key: 'mcpServers',
  },
};

function serverEntry() {
  // GUI 앱은 셸 PATH를 물려받지 않으므로 node 절대경로를 쓴다.
  return { command: process.execPath, args: [SERVER] };
}

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Node 22 이상이 필요합니다. 현재 ${process.version}`);
    console.error('https://nodejs.org 에서 최신 LTS를 설치하세요.');
    process.exit(1);
  }
  // node:sqlite는 버전에 따라 플래그가 필요했다. 실제로 쓸 수 있는지 확인한다.
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(b, tokenize='trigram')");
    db.close();
  } catch (e) {
    console.error(`이 Node에서는 node:sqlite(FTS5)를 쓸 수 없습니다: ${e.message}`);
    console.error('Node 24 이상을 권장합니다.');
    process.exit(1);
  }
  log(`  Node ${process.version} · node:sqlite(FTS5) 사용 가능`);
}

function patchConfig(clientKey) {
  const c = CLIENTS[clientKey];
  if (!c) {
    console.error(`알 수 없는 클라이언트: ${clientKey}`);
    process.exit(1);
  }

  mkdirSync(dirname(c.path), { recursive: true });
  let cfg = {};
  if (existsSync(c.path)) {
    // 기존 설정을 잃지 않도록 반드시 백업한 뒤에 고친다.
    const backup = `${c.path}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
    copyFileSync(c.path, backup);
    log(`  백업: ${backup}`);
    try {
      cfg = JSON.parse(readFileSync(c.path, 'utf8'));
    } catch {
      console.error(`  기존 설정을 읽을 수 없습니다: ${c.path}`);
      console.error('  파일을 확인한 뒤 다시 실행하거나, --print로 직접 붙여넣으세요.');
      process.exit(1);
    }
  }

  cfg[c.key] ??= {};
  cfg[c.key]['smu-rule'] = serverEntry();
  writeFileSync(c.path, JSON.stringify(cfg, null, 2) + '\n');
  log(`  등록 완료: ${c.path}`);
  log(`  현재 서버: ${Object.keys(cfg[c.key]).join(', ')}`);
}

async function chooseClient() {
  const keys = Object.keys(CLIENTS);
  log('\n어느 클라이언트에 등록할까요?');
  keys.forEach((k, i) => log(`  ${i + 1}) ${CLIENTS[k].label}`));
  log(`  ${keys.length + 1}) 설정 JSON만 출력 (직접 붙여넣기)`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('번호 선택 (기본 1): ')).trim();
  rl.close();

  const n = Number(ans || '1');
  return n === keys.length + 1 ? null : keys[n - 1] ?? keys[0];
}

// ── 실행 ────────────────────────────────────────────────────
log('smu-rule-mcp 설치');

step('1/4 실행 환경 확인');
await checkNode();

step('2/4 의존성 설치와 빌드');
run(IS_WIN ? 'npm.cmd' : 'npm', ['ci']);
run(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build']);

step('3/4 규정 데이터 내려받기');
run(process.execPath, [join(ROOT, 'scripts', 'updateData.mjs')]);

step('4/4 MCP 클라이언트 등록');
const entry = { mcpServers: { 'smu-rule': serverEntry() } };

if (flag('print')) {
  log('\n아래 내용을 클라이언트 설정 파일에 붙여넣으세요.\n');
  log(JSON.stringify(entry, null, 2));
} else {
  const chosen = flag('client') ?? (await chooseClient());
  if (chosen === null || chosen === true) {
    log('\n아래 내용을 클라이언트 설정 파일에 붙여넣으세요.\n');
    log(JSON.stringify(entry, null, 2));
  } else {
    patchConfig(chosen);
    log('\n클라이언트를 완전히 종료했다가 다시 실행하세요. 설정은 시작할 때만 읽습니다.');
  }
}

log('\n끝났습니다. "휴학 규정 알려줘" 처럼 물어보면 됩니다.');
