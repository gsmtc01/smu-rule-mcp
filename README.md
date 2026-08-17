# smu-rule-mcp

상명대학교 규정관리시스템([rule.smu.ac.kr](https://rule.smu.ac.kr))의 규정을
AI 어시스턴트에서 조회할 수 있게 해주는 **비공식** MCP 서버.

규정 **301건**, 조문 **5,196건**, 별표·서식 **2,029건**을 조문 단위로 검색합니다.

> ⚠️ **이 프로젝트는 상명대학교와 무관한 비공식 도구입니다.**
> 승인·후원·인증을 받지 않았습니다. 공식 규정의 내용은 반드시
> [원문](https://rule.smu.ac.kr)을 확인하시기 바랍니다.
> 자세한 고지는 [NOTICE.md](./NOTICE.md)를 참조하세요.

```
나: 휴학은 최대 몇 년까지 돼?
AI: 학칙 제28조(휴학기간 및 복학)에 따르면 일반휴학은 1년 또는 학기 단위로…
```

## 빠른 시작

Node.js 22 이상이 필요합니다([nodejs.org](https://nodejs.org)에서 LTS 설치).
Windows·macOS·Linux 모두 같은 명령을 씁니다.

```bash
git clone https://github.com/gsmtc01/smu-rule-mcp
cd smu-rule-mcp
npm run setup
```

`npm run setup` 한 번이면 의존성 설치, 빌드, 데이터 내려받기, 클라이언트 등록까지
끝납니다. 등록할 클라이언트는 실행 중에 골라주세요. 설정 파일은 고치기 전에
자동으로 백업되고, 이미 등록된 다른 MCP 서버는 건드리지 않습니다.

```bash
npm run setup -- --client claude-desktop   # 물어보지 않고 바로 등록
npm run setup -- --print                   # 설정 JSON만 출력(직접 붙여넣기)
```

설치가 끝나면 **클라이언트를 완전히 종료했다가 다시 실행하세요.**
MCP 설정은 시작할 때만 읽습니다.

## 클라이언트별 설정

MCP 연결 방식은 크게 둘로 나뉩니다.

- **로컬(stdio)**: 클라이언트가 이 서버를 직접 프로세스로 띄웁니다. 설치만 하면 됩니다.
- **원격(HTTP)**: 브라우저에서 쓰는 클라이언트는 로컬 프로세스를 띄울 수 없어,
  접근 가능한 URL이 필요합니다.

| 클라이언트 | 방식 | 준비물 |
|---|---|---|
| Claude Desktop | 로컬 stdio | `npm run setup` |
| Claude Code | 로컬 stdio | `npm run setup` |
| Codex CLI | 로컬 stdio | `npm run setup -- --print` 후 TOML 작성 |
| Cursor / Windsurf 등 | 로컬 stdio | `npm run setup` |
| Claude 웹(claude.ai) | 원격 HTTP | 서버를 배포하거나 터널 필요 |
| ChatGPT 웹 / Work | 원격 HTTP | 서버를 배포하거나 터널 필요 |

### Claude Desktop

```bash
npm run setup -- --client claude-desktop
```

수동으로 하려면 설정 파일을 직접 고칩니다.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "smu-rule": {
      "command": "node",
      "args": ["<저장소 경로>/dist/mcp/server.js"]
    }
  }
}
```

`command`는 **`node`의 절대경로**를 권장합니다(`which node` / `where node`).
GUI 앱은 셸의 PATH를 물려받지 않아 `node`를 못 찾는 경우가 있습니다.
Windows 경로의 역슬래시는 `"C:\\Users\\..."`처럼 두 번 씁니다.

### Claude Code

```bash
npm run setup -- --client claude-code
```

`~/.claude.json`의 `mcpServers`에 등록됩니다. 형식은 Claude Desktop과 같습니다.
Claude Desktop을 함께 쓴다면 한쪽에만 등록하세요. 데스크톱 앱 설정이
Claude Code 세션에도 적용되어 중복 등록될 수 있습니다.

### Codex CLI

Codex는 TOML을 씁니다. `~/.codex/config.toml`에 추가하세요.

```toml
[mcp_servers.smu-rule]
command = "node"
args = ["<저장소 경로>/dist/mcp/server.js"]
```

경로는 `npm run setup -- --print`로 확인할 수 있습니다.

### Cursor · Windsurf 등

```bash
npm run setup -- --client cursor
```

`mcpServers` 형식을 쓰는 클라이언트라면 위 Claude Desktop과 같은 JSON을
각자의 설정 파일에 넣으면 됩니다.

### Claude 웹(claude.ai) · ChatGPT 웹/Work

브라우저에서 도는 클라이언트는 내 PC의 프로그램을 실행할 수 없습니다.
**서버가 인터넷에서 접근 가능한 주소로 떠 있어야** 커넥터로 등록할 수 있습니다.

이 서버는 `PORT`를 주면 Streamable HTTP로 뜹니다.

```bash
PORT=8080 npm start          # http://localhost:8080/mcp
```

```powershell
$env:PORT=8080; npm start    # Windows PowerShell
```

세 가지 방법이 있습니다.

1. **직접 배포** (권장): Fly.io, Railway, Render 등에 올리고 그 URL을 등록합니다.
   `PORT` 환경변수만 주면 되고, 데이터는 컨테이너 안에서 `npm run update-data`로 받습니다.
2. **임시 터널**: 내 PC에서 띄운 뒤 `cloudflared tunnel --url http://localhost:8080`
   같은 도구로 임시 공개 주소를 만듭니다. PC를 끄면 끊깁니다.
3. **로컬 클라이언트 사용**: 웹 대신 Claude Desktop이나 Claude Code를 씁니다.
   가장 간단하고, 별표 파일도 내 PC에 바로 저장됩니다.

> 공개 주소로 띄우면 누구나 접근할 수 있습니다. 규정 데이터는 공개 정보지만,
> 원본 시스템에 접속하는 `download_form`이 함께 열리므로 접근을 제한하거나
> 신뢰할 수 있는 범위에서만 사용하세요.

## 도구

| 도구 | 설명 | 원 서버 접속 |
|---|---|---|
| `search_regulation` | 조문 단위 전문검색 (FTS5) | 없음 |
| `get_regulation_text` | 규정 전문 조회 | 없음 |
| `list_regulations` | 분류별·부서별 목록 | 없음 |
| `get_recent_amendments` | 최신 제·개정 정보 | 없음 |
| `list_repealed` | 폐지 규정 | 없음 |
| `list_forms` | 별표·서식 메타데이터 | 없음 |
| `download_form` | 별표·서식 HWP 내려받기 | **있음**(최초 1회) |
| `get_data_status` | 로컬 DB 수집 시점·건수 | 없음 |

검색 결과를 규정 단위가 아니라 조문 단위로 특정하는 것이 이 도구의 주된 이점입니다.

이렇게 물어보면 됩니다.

```
휴학은 최대 몇 년까지 가능해?
학칙 제27조 보여줘
교원인사팀이 관리하는 규정 목록 뽑아줘
최근 3개월 안에 개정된 규정 알려줘
학칙 별지1 파일 받아줘
```

## 구조

수집과 질의를 분리한 GitHub 네이티브 구조입니다. 상시 서버가 필요 없습니다.

```
GitHub Actions (야간 크론)          사용자 기기 (stdio, 온디맨드)
  수집 → SQLite FTS 빌드     ──▶     Release에서 DB 내려받아 캐시
  → Release 애셋 업로드              · 검색/목록/전문 → 로컬 DB (원 서버 부담 0)
                                     · 별표 HWP → 필요 시에만 라이브 + 영구 캐시
```

- **검색·전문·메타데이터**는 로컬 DB에서 처리하므로 사용자가 늘어도 원 서버에 부담이 없습니다.
- **원 서버에 실제로 접속하는 것은 별표 HWP 다운로드뿐**입니다.

## 데이터 갱신

```bash
npm run update-data
```

수집은 매일 새벽 자동으로 돌고 결과가 Release로 배포됩니다. 위 명령으로
최신 데이터를 받으세요. 현재 데이터 시점은 `get_data_status`로 확인할 수 있습니다.

## 별표·서식 내려받기

`download_form`만 원본 시스템에 접속합니다. serverfile ID는 사실상 콘텐츠 주소라
한 번 받은 파일은 영구 캐시되고, 같은 파일을 다시 요청하면 네트워크를 쓰지 않습니다.
내려받은 내용이 한글 문서 시그니처와 다르면(오류 페이지 등) 저장하지 않고 실패로 처리합니다.

캐시는 ID로 저장되지만, 사용자에게 건네는 사본은 **원래 파일명으로** 접근하기
쉬운 위치에 놓습니다. 저장 위치는 `SMU_FORM_DIR` > `~/Claude` > `~/Downloads`
순으로 정해지며, 도구 호출 시 `output_dir`로 직접 지정할 수도 있습니다.

원본 파일명은 대부분 `<별표1> (...)` 형태인데 `<`와 `>`는 Windows에서 쓸 수 없어
`[별표1] (...)`로 바꿔 저장합니다. 전체 822건에 대해 검사합니다
(`npm run check-filenames`).

## 환경변수

| 변수 | 뜻 |
|---|---|
| `SMU_DB_PATH` | 규정 DB 경로를 직접 지정 |
| `SMU_CACHE_DIR` | 캐시 위치 (기본: `~/.cache/smu-rule-mcp`, Windows는 `%LOCALAPPDATA%`) |
| `SMU_FORM_DIR` | 내려받은 별표를 놓을 위치 |
| `SMU_DATA_URL` | 데이터 배포 URL을 직접 지정 |
| `PORT` | 지정하면 stdio 대신 HTTP 서버로 실행 |
| `SMU_CRAWLER_DISABLED` | 수집기 킬 스위치 |

## 문제 해결

**도구가 보이지 않습니다**
클라이언트를 완전히 종료(⌘Q / 작업 표시줄에서 종료)했다가 다시 실행하세요.
설정은 시작할 때만 읽습니다.

**"규정 DB를 찾을 수 없습니다"**
`npm run update-data`를 실행하세요. 최초 1회 데이터를 받아야 합니다.

**GUI 앱에서만 서버가 뜨지 않습니다**
`command`를 `node` 대신 절대경로로 바꾸세요(`which node` / `where node`).
GUI 앱은 셸의 PATH를 물려받지 않습니다.

**`node:sqlite`를 쓸 수 없다는 오류**
Node 22.5 미만이거나 플래그가 필요한 버전입니다. Node 24 이상을 권장합니다.
`npm run setup`이 시작할 때 이 부분을 먼저 확인합니다.

**별표 파일을 받았는데 찾을 수 없습니다**
`download_form`이 알려준 경로를 확인하세요. 기본값은 `~/Downloads`입니다.
`output_dir`로 원하는 위치를 지정할 수도 있습니다.

## 수집 정책

대상 시스템은 대규모 자동 트래픽을 상정하고 운영되지 않습니다.
**"정상 이용자 1명 이하"의 부하**를 목표로 아래 정책을 지킵니다.
수치는 [`src/crawler/config.ts`](./src/crawler/config.ts)에 코드로 고정되어 있으며,
임의로 완화하지 마십시오.

| 항목 | 값 |
|---|---|
| 동시성 | 1 (직렬, 병렬 금지) |
| 요청 간 지연 | 2s + 지터 0~1s (무거운 요청 3s + 0~2s) |
| 재시도 | 5xx·타임아웃·네트워크 오류만 3회, 2→4→8s 지수 백오프 |
| 429/503 | `Retry-After` 준수, 없으면 60s 대기 |
| 서킷 브레이커 | 연속 5회 실패 또는 타임아웃 누적 3회 → 즉시 중단 |
| 수집 시간대 | 02:00–05:00 KST |
| User-Agent | 저장소 주소를 포함한 정직한 UA (스푸핑 금지) |
| 별표 파일 | **lazy**: 일괄 수집 금지, 요청 시 1건씩 받아 영구 캐시 |
| 킬 스위치 | `SMU_CRAWLER_DISABLED` 환경변수 |

요청 예산: 초기 텍스트 수집 1회, 이후 일일 증분은 변경분에 한합니다.
별표 파일의 일괄 다운로드는 정책상 수행하지 않습니다.

## 데이터 파이프라인

수집은 [`.github/workflows/crawl.yml`](./.github/workflows/crawl.yml)이 매일 02:00 KST에 수행합니다.

```
이전 Release 복원 → 증분 수집 → 무결성 검증 → gzip → Release(data-latest) 배포
```

- **이전 배포본을 먼저 복원**합니다. 이것이 없으면 매 실행이 전체 재수집이 되므로,
  증분 수집(개정판이 바뀐 규정만 전문 재수집)의 전제 조건입니다.
- 수집기가 스스로 중단한 경우(시간대 밖·킬 스위치·서킷 브레이커)에는
  배포를 건너뛰고 워크플로를 실패로 처리하지 않습니다.
- [`scripts/verifyDb.mjs`](./scripts/verifyDb.mjs)가 최소 건수·인덱스 정합성·
  직전 대비 급감 여부를 확인한 뒤에만 배포합니다. 부분 실패한 결과가
  정상 데이터를 덮어쓰는 것을 막습니다.

**킬 스위치**: 저장소 변수 `SMU_CRAWLER_DISABLED`를 `true`로 설정하면 수집이 중단됩니다.

수동 실행은 Actions 탭의 `crawl` → *Run workflow*에서 가능하며,
`force` 옵션으로 시간대 제한을 우회할 수 있습니다.

## 데이터와 라이선스

- **소스코드**: [MIT](./LICENSE)
- **규정 데이터**: 저작권은 상명대학교에 있으며 MIT 적용 대상이 아닙니다.
  라이선스 경계를 유지하기 위해 데이터는 저장소에 커밋하지 않고
  Release 애셋으로만 분리 배포합니다. → [NOTICE.md](./NOTICE.md)

## 문의

상명대학교 관계자께서 운영 방식의 조정이나 중지를 요청하시는 경우
[Issues](https://github.com/gsmtc01/smu-rule-mcp/issues)로 알려주시면 신속히 대응하겠습니다.
