-- 상명대 규정 로컬 인덱스 스키마 (SQLite + FTS5)
--
-- 이 DB는 GitHub Actions가 야간에 빌드하여 Release 애셋으로 배포한다.
-- 저장소 소스 트리에는 커밋하지 않는다 (NOTICE.md §2).

PRAGMA journal_mode = WAL;

-- ── 규정 ────────────────────────────────────────────────────
-- 원본 필드명(getData.jsp 응답)을 그대로 유지해 매핑을 추적 가능하게 둔다.
CREATE TABLE IF NOT EXISTS regulations (
  bookid          TEXT PRIMARY KEY,
  obookid         TEXT,
  catid           TEXT,
  bookcode        TEXT,           -- 규정코드 (예: 1-0-1, 2-1-1)
  bookcd          TEXT,           -- 정관 / 규정 / 시행세칙 / 내규 (원본 값 그대로)
  -- 제목 접미사로 보정한 분류. 원본 bookcd에 오분류가 있어 조회 필터는 이쪽을 쓴다
  -- (예: "ESG연구소 규정"이 원본에서는 정관). 접미사로 판정할 수 없으면 bookcd와 같다.
  bookcd_norm     TEXT,
  title           TEXT NOT NULL,
  revcd           TEXT,           -- 제정 / 개정 / 폐지
  revcha          INTEGER,        -- 개정 차수
  statecd         TEXT,           -- 현행(5000) / 폐지
  promuldt        TEXT,           -- 제·개정일 (YYYY-MM-DD)
  startdt         TEXT,           -- 시행일
  deptname        TEXT,           -- 소관부서
  noformyn        TEXT,           -- Y이면 비정형(regul_board_noForm.jsp)
  ordsort         INTEGER,
  statehistoryid  TEXT,           -- 개정판 식별자. 전문 캐시 무효화 기준.
  fetched_at      TEXT NOT NULL,
  -- 원본 목록에서 사라진 시각. NULL이면 마지막 수집 시점의 목록에 있었다는 뜻.
  -- 개정 시 새 bookid가 발급되면 옛 bookid는 목록에서 빠지는데 삭제 신호는
  -- 오지 않는다. 그 구판을 현행과 구분하기 위한 표시다.
  missing_since   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reg_state ON regulations(statecd);
CREATE INDEX IF NOT EXISTS idx_reg_dept  ON regulations(deptname);
CREATE INDEX IF NOT EXISTS idx_reg_promul ON regulations(promuldt DESC);

-- ── 조문 ────────────────────────────────────────────────────
-- 전문을 조문 단위로 쪼개 저장한다. 원 사이트의 검색(sMenu=TB)은
-- 규정 단위까지만 알려주므로, 조문 단위 특정이 이 프로젝트의 핵심 이점이다.
CREATE TABLE IF NOT EXISTS articles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bookid        TEXT NOT NULL REFERENCES regulations(bookid) ON DELETE CASCADE,
  article_no    INTEGER,          -- 제N조의 N
  article_label TEXT,             -- "제12조" / "제12조의2"
  heading       TEXT,             -- 조 제목 (목적, 정의 …)
  body          TEXT NOT NULL,
  amended_note  TEXT,             -- <개정 2020.09.01, 2024.05.29> 원문
  ord           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_art_book ON articles(bookid, ord);

-- 토크나이저로 trigram을 쓴다.
--   unicode61은 공백 단위로 끊으므로 한국어 조사에 걸린다.
--   ("장학금"으로 "장학금의"가, "총장"으로 "총장이"가 검색되지 않는다.)
--   trigram은 부분 문자열을 매칭하므로 형태소 분석기 없이도 조사 문제를 피한다.
-- 제약: MATCH는 3글자 이상에서만 동작한다. 2글자 이하 질의는
--       조회 계층에서 LIKE로 우회한다(trigram 인덱스가 LIKE도 가속한다).
-- contentless(content='')로 두면 DELETE가 거부되어 증분 갱신에서 조문을
-- 교체할 수 없다(SQLite 3.43+의 contentless_delete=1이 있어야 하는데,
-- 런타임에 실린 SQLite 버전에 의존하게 된다). 본문을 중복 저장하더라도
-- 일반 FTS5 테이블을 써서 어느 버전에서든 갱신이 되게 한다.
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,                          -- 규정명 (검색 편의를 위해 비정규화)
  article_label,
  heading,
  body,
  tokenize = 'trigram'
);

-- ── 별표 · 서식 ─────────────────────────────────────────────
-- 메타데이터만 인덱싱한다. HWP 파일 자체는 요청 시 받아 캐시한다
-- (config.ts의 FORM_DOWNLOAD_STRATEGY = 'lazy').
CREATE TABLE IF NOT EXISTS forms (
  serverfile   TEXT PRIMARY KEY,  -- 서버 파일 ID (예: 110294380.hwp). 콘텐츠 주소로 취급.
  bookid       TEXT REFERENCES regulations(bookid) ON DELETE CASCADE,
  pcfilename   TEXT NOT NULL,     -- 원본 파일명 (다운로드 시 EUC-KR 인코딩 필요)
  title        TEXT,              -- 소속 규정명
  bookcode     TEXT,
  bookcd       TEXT,
  filecd       TEXT,              -- BYUL 등
  revcd        TEXT,
  revcha       INTEGER,
  statecd      TEXT,
  promuldt     TEXT,
  startdt      TEXT,
  ordsort      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_forms_book ON forms(bookid);

-- ── 메타 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 기록 항목: schema_version, built_at, source_url, regulation_count,
--            form_count, crawler_version, superseded_count
--
-- regulation_count는 원본 목록 기준 건수다. regulations 테이블 행 수는
-- 구판(missing_since IS NOT NULL)을 포함하므로 그보다 클 수 있다.
-- 두 값의 차이는 scripts/verifyDb.mjs가 배포 전에 대조한다.
