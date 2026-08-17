/** 전문 HTML에서 조문을 추출한다. */

export interface ParsedArticle {
  articleNo: number | null;
  articleLabel: string;
  heading: string | null;
  body: string;
  amendedNote: string | null;
  ord: number;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
};

function decodeEntities(s: string): string {
  // 전문 소스는 &amp;nbsp; 처럼 이중 이스케이프된 실체 참조를 포함한다.
  return s.replace(/&(#?\w+);/g, (m, e: string) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    return m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 조 표제. "제12조" / "제12조의2" 및 뒤따르는 괄호 제목. */
const ARTICLE_HEAD =
  /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*(?:[(（]((?:[^()（）]|[(（][^()（）]*[)）])*)[)）])?/;

/** 개정 이력 표기. 전문 소스는 [[개정 …]], 일반 화면은 <개정 …>을 쓴다. */
const AMENDED_RE = /(?:\[\[|[<〈])\s*(?:개정|신설|전문개정|제정)\s*[^\]>〉]*(?:\]\]|[>〉])/;

interface StrongBlock {
  start: number;
  end: number;
  text: string;
}

function findStrongBlocks(html: string): StrongBlock[] {
  return [...html.matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/gi)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    text: decodeEntities(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')))
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

/**
 * 조문 경계를 판정한다.
 *
 * 본문에는 "제3조의 규정에 의하여"처럼 다른 조를 가리키는 표현이 흔해서,
 * 텍스트에서 "제N조" 패턴만 찾으면 상호참조까지 새 조문으로 오인한다
 * (학칙 기준 89개 조문이 195개로 부풀었다).
 *
 * 전문 소스는 조 표제를 <strong>으로 감싸므로 이 구조를 경계로 삼는다.
 * 구조가 없는 문서(비정형 등)에서는 텍스트 기반으로 물러서되,
 * 조 번호가 증가하는 위치만 채택해 상호참조를 걸러낸다.
 */
export function extractArticles(html: string): ParsedArticle[] {
  const structural = extractByStructure(html);
  if (structural.length > 0) return structural;
  return extractByText(html);
}

/**
 * "제3장 총칙", "제1절 임 원" 같은 편제 표제. 조문 본문에 섞이면 안 된다.
 * 주의: \b는 ASCII 기준이라 한글 앞뒤에서는 경계로 잡히지 않는다. 쓰지 말 것.
 */
const CHAPTER_HEAD = /^제\s*\d+\s*[편장절관](?:\s|$)/;

function extractByStructure(html: string): ParsedArticle[] {
  const strongs = findStrongBlocks(html);
  const heads = strongs.filter((s) => ARTICLE_HEAD.test(s.text));
  if (heads.length === 0) return [];

  // 조문 본문은 다음 조 표제뿐 아니라 장·절 표제에서도 끊어야 한다.
  // 그러지 않으면 다음 장의 제목이 앞 조문 끝에 붙어, 검색이 엉뚱한 조문을
  // 상위로 올린다("휴학"으로 검색했더니 바로 앞 조인 수강신청 조가 걸리는 식).
  const bounds = strongs
    .filter((s) => ARTICLE_HEAD.test(s.text) || CHAPTER_HEAD.test(s.text))
    .map((s) => s.start)
    .sort((a, b) => a - b);

  const articles: ParsedArticle[] = [];
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    const next = { start: bounds.find((b) => b > cur.start) ?? html.length };
    const m = ARTICLE_HEAD.exec(cur.text);
    if (!m) continue;

    const no = Number(m[1]);
    const sub = m[2] ? Number(m[2]) : 0;
    const label = sub ? `제${no}조의${sub}` : `제${no}조`;
    const bodyHtml = html.slice(cur.end, next.start);
    const bodyText = htmlToText(bodyHtml);
    const full = `${cur.text} ${bodyText}`.trim();

    articles.push({
      articleNo: no,
      articleLabel: label,
      heading: m[3]?.trim() || null,
      body: full,
      amendedNote: AMENDED_RE.exec(full)?.[0] ?? null,
      ord: articles.length,
    });
  }
  return articles;
}

/** 구조 마커가 없는 문서용 대체 경로. */
function extractByText(html: string): ParsedArticle[] {
  const text = htmlToText(html);
  const RE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*(?:[(（]((?:[^()（）]|[(（][^()（）]*[)）]){0,80})[)）])?/g;

  const marks: { index: number; no: number; sub: number; heading: string | null }[] = [];
  let lastKey = -1;
  for (const m of text.matchAll(RE)) {
    const no = Number(m[1]);
    const sub = m[2] ? Number(m[2]) : 0;
    const key = no * 1000 + sub;
    const heading = m[3]?.trim() || null;

    // 번호가 되돌아가는 매치는 상호참조로 본다. 다만 부칙은 번호가 다시 1부터
    // 시작하므로, 직전 구간에 "부칙"이 나오면 기준을 초기화한다.
    if (key <= lastKey) {
      const gap = text.slice(marks.at(-1)?.index ?? 0, m.index ?? 0);
      if (!gap.includes('부칙')) continue;
    }
    marks.push({ index: m.index ?? 0, no, sub, heading });
    lastKey = key;
  }

  const articles: ParsedArticle[] = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const next = marks[i + 1];
    const raw = text.slice(cur.index, next ? next.index : text.length).trim();
    if (!raw) continue;
    articles.push({
      articleNo: cur.no,
      articleLabel: cur.sub ? `제${cur.no}조의${cur.sub}` : `제${cur.no}조`,
      heading: cur.heading,
      body: raw,
      amendedNote: AMENDED_RE.exec(raw)?.[0] ?? null,
      ord: articles.length,
    });
  }
  return articles;
}
