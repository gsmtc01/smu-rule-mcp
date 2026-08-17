# smu-rule-mcp

상명대학교 규정관리시스템([rule.smu.ac.kr](https://rule.smu.ac.kr))의 규정을
AI 어시스턴트에서 조회할 수 있게 해주는 **비공식** MCP 서버.

> ⚠️ **이 프로젝트는 상명대학교와 무관한 비공식 도구입니다.**
> 승인·후원·인증을 받지 않았습니다. 공식 규정의 내용은 반드시
> [원문](https://rule.smu.ac.kr)을 확인하시기 바랍니다.
> 자세한 고지는 [NOTICE.md](./NOTICE.md)를 참조하세요.

## 상태

**Phase 4 — 기능 완성.** 검색·전문·목록·별표 내려받기가 모두 동작합니다.

- [x] Phase 0 · 저장소 스캐폴드, 라이선스/고지, 수집 정책 정의
- [x] Phase 1 · 수집기 (세션·EUC-KR·정중한 fetch) → SQLite FTS 빌드
- [x] Phase 2 · GitHub Actions 야간 크론 + Release 배포
- [x] Phase 3 · stdio MCP 서버 (검색·전문·목록)
- [x] Phase 4 · 별표/서식 다운로드 (라이브 + 캐시)

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

## 설치

```bash
npm install -g smu-rule-mcp   # 또는 저장소에서 npm ci && npm run build
smu-rule-mcp                  # stdio MCP 서버
```

최초 1회 데이터를 내려받습니다(저장소가 아니라 Release에서 배포됩니다).

```bash
npm run update-data
```

MCP 클라이언트 설정 예시:

```json
{
  "mcpServers": {
    "smu-rule": { "command": "smu-rule-mcp" }
  }
}
```

환경변수: `SMU_DB_PATH`(DB 경로 직접 지정), `SMU_CACHE_DIR`, `SMU_DATA_URL`.

### 별표·서식 내려받기

`download_form`만 원본 시스템에 접속합니다. serverfile ID는 사실상 콘텐츠 주소라
한 번 받은 파일은 `~/.cache/smu-rule-mcp/forms/`에 영구 캐시되고, 같은 파일을
다시 요청하면 네트워크를 쓰지 않습니다. 내려받은 내용이 한글 문서 시그니처와
다르면(오류 페이지 등) 저장하지 않고 실패로 처리합니다.

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
| User-Agent | 연락처를 포함한 정직한 UA (스푸핑 금지) |
| 별표 파일 | **lazy** — 일괄 수집 금지, 요청 시 1건씩 받아 영구 캐시 |
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
