import { normalizeSearchQuery } from './search-query-policy';

export class RequestExpressionInputError extends Error {}
export class EmptySearchQueryError extends Error {
  code = 'SEARCH_QUERY_EMPTY';
  constructor() { super('요청 표현을 제외한 검색어를 입력해 주세요.'); }
}

export function normalizeRequestExpressions(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RequestExpressionInputError('요청 표현 목록을 입력해 주세요.');
  return [...new Set(value.map((phrase: unknown) => {
    if (typeof phrase !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(phrase)) {
      throw new RequestExpressionInputError('요청 표현은 제어 문자가 없는 문자열이어야 합니다.');
    }
    const normalized = normalizeSearchQuery(phrase);
    if (!normalized || normalized.length > 100) throw new RequestExpressionInputError('요청 표현은 각각 1~100자로 입력해 주세요.');
    return normalized;
  }))];
}

/** 정규식 문법이 아닌 리터럴 구문. 같은 위치에서는 긴 표현부터 한 번만 제거한다. */
export function compileRequestExpressions(phrases: string[]): RegExp | null {
  if (!phrases.length) return null;
  return new RegExp([...new Set(phrases.map(normalizeSearchQuery))].sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
}

export function removeRequestExpressions(query: string, matcher: RegExp | null): { cleanedQuery: string; removedExpressions: string[] } {
  const normalized = normalizeSearchQuery(query);
  const removed = new Set<string>();
  const cleaned = matcher ? normalized.replace(matcher, (phrase) => { removed.add(phrase); return ' '; }) : normalized;
  return { cleanedQuery: cleaned.trim().replace(/\s+/g, ' '), removedExpressions: [...removed] };
}
