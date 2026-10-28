export interface DateExpressionMatch {
  text: string;
  start: string;
  end: string;
}

export interface DateExpressionResult {
  remainingQuery: string;
  matches: DateExpressionMatch[];
}

export interface DateRangeFields {
  start: string;
  end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const DATE_EXPRESSION = /(^|[^\p{L}\p{N}])((?:오늘|내일|이번\s*주|다음\s*주|이번\s*달|(?:1[0-2]|[1-9])월))(?:에|의|부터)?(?=$|[^\p{L}\p{N}])/gu;

/** Asia/Seoul의 달력 날짜를 UTC 경계로 바꾼다. */
function kstBoundary(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day) - KST_MS).toISOString();
}

/** 날짜 계산은 필드·인덱스와 독립적이므로 다른 검색 인덱스에서도 재사용할 수 있다. */
export function parseDateExpressions(query: string, now = new Date()): DateExpressionResult {
  const localNow = new Date(now.getTime() + KST_MS);
  const year = localNow.getUTCFullYear();
  const month = localNow.getUTCMonth() + 1;
  const day = localNow.getUTCDate();
  const today = Date.UTC(year, month - 1, day);
  const matches: DateExpressionMatch[] = [];
  const seenRanges = new Set<string>();
  const remainingQuery = query.normalize('NFKC').replace(DATE_EXPRESSION, (full, prefix: string, expression: string) => {
    const compact = expression.replace(/\s+/g, '');
    let start: string;
    let end: string;
    if (compact === '오늘' || compact === '내일') {
      const offset = compact === '내일' ? DAY_MS : 0;
      start = new Date(today + offset - KST_MS).toISOString();
      end = new Date(today + offset + DAY_MS - KST_MS).toISOString();
    } else if (compact === '이번주' || compact === '다음주') {
      const mondayOffset = (localNow.getUTCDay() + 6) % 7;
      const nextWeekOffset = compact === '다음주' ? 7 : 0;
      start = new Date(today + (nextWeekOffset - mondayOffset) * DAY_MS - KST_MS).toISOString();
      end = new Date(today + (nextWeekOffset - mondayOffset + 7) * DAY_MS - KST_MS).toISOString();
    } else {
      const targetMonth = compact === '이번달' ? month : Number(compact.slice(0, -1));
      const targetYear = compact === '이번달' || targetMonth >= month ? year : year + 1;
      start = kstBoundary(targetYear, targetMonth, 1);
      end = kstBoundary(targetYear, targetMonth + 1, 1);
    }
    const rangeKey = `${start}/${end}`;
    if (!seenRanges.has(rangeKey)) {
      matches.push({ text: full.slice(prefix.length).trim(), start, end });
      seenRanges.add(rangeKey);
    }
    return prefix || ' ';
  });
  return { remainingQuery: remainingQuery.replace(/\s+/g, ' ').trim(), matches };
}

/** 검색 기간과 문서 기간이 하나라도 겹치는 문서를 찾는 Elasticsearch 필터를 만든다. */
export function createDateOverlapFilter(matches: DateExpressionMatch[], fields: DateRangeFields): Record<string, unknown> | null {
  if (!matches.length) return null;
  return { bool: {
    should: matches.map((match) => ({ bool: { filter: [
      { range: { [fields.start]: { lt: match.end } } },
      { range: { [fields.end]: { gte: match.start } } },
    ] } })),
    minimum_should_match: 1,
  } };
}
