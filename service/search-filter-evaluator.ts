export type SearchFilterStatus = 'active' | 'inactive';
export type CategoryMatchType = 'prefix' | 'term' | 'contains';
export type PriceOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface CategoryFilterRule {
  id: string;
  name: string;
  targetIndex: string;
  kind: 'category';
  field: string;
  matchType: CategoryMatchType;
  detectionTerms: string[];
  values: string[];
  status: SearchFilterStatus;
}

export interface FieldFilterRule extends Omit<CategoryFilterRule, 'kind'> { kind: 'field' | 'category' }
export type SearchFilterRule = FieldFilterRule;
export interface SearchFilterEvaluation {
  remainingQuery: string;
  filters: Array<Record<string, unknown>>;
  matchedRules: Array<{ id: string; name: string; kind: SearchFilterRule['kind']; field: string; values: string[]; range?: { gte?: number; gt?: number; lt?: number; lte?: number } }>;
}

const fieldPattern = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const MAX_PRICE = 1_000_000_000;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

export function validateSearchFilterRule(input: Partial<SearchFilterRule>): SearchFilterRule {
  if (!input.id || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) throw new Error('필터 ID가 올바르지 않습니다.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) throw new Error('필터명은 1~100자로 입력해 주세요.');
  if (!input.targetIndex || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(input.targetIndex)) throw new Error('적용 인덱스명이 올바르지 않습니다.');
  const field = typeof input.field === 'string' ? input.field.trim() : '';
  if (!fieldPattern.test(field)) throw new Error('필터 필드를 입력해 주세요.');
  if (input.status !== 'active' && input.status !== 'inactive') throw new Error('사용 여부가 올바르지 않습니다.');
  if (input.kind === 'category' || input.kind === 'field') {
    if (input.matchType !== 'prefix' && input.matchType !== 'term' && input.matchType !== 'contains') throw new Error('카테고리 매칭 방식을 입력해 주세요.');
    const detectionTerms = Array.isArray(input.detectionTerms) ? input.detectionTerms.map(String).map(normalize).filter(Boolean) : [];
    const values = Array.isArray(input.values) ? input.values.map(String).map((value) => value.trim()).filter(Boolean) : [];
    if (!detectionTerms.length || !values.length) throw new Error('감지어와 필터 값을 입력해 주세요.');
    return { ...input, kind: 'field', id: input.id.trim(), name, targetIndex: input.targetIndex.trim(), field, detectionTerms, values, status: input.status } as FieldFilterRule;
  }
  throw new Error('필터 유형이 올바르지 않습니다.');
}

type PriceRange = { gte?: number; gt?: number; lt?: number; lte?: number };
const escapeWildcard = (value: string) => value.replace(/[\\*?]/g, '\\$&');
export function parsePriceExpression(value: string): { text: string; range: PriceRange } | null {
  const source = normalize(value).replace(/\s+/g, ' ');
  const match = source.match(/(^|[^\p{L}\p{N}])([0-9][0-9,]*)\s*(만원|만\s*원|만|원)\s*(대|이상|이하|미만|초과)(?=$|[^\p{L}\p{N}])/u);
  if (!match || !match[2] || !match[4]) return null;
  const unit = match[3].replace(/\s+/g, '');
  const amount = Number(match[2].replace(/,/g, '')) * (unit === '만원' || unit === '만' ? 10000 : 1);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_PRICE) return null;
  const suffix = match[4] || '';
  if (suffix === '대' && unit !== '만원' && unit !== '만') return null;
  const text = match[0].trim();
  if (suffix === '대') return { text, range: { gte: amount, lt: amount + 10000 } };
  if (suffix === '이상') return { text, range: { gte: amount } };
  if (suffix === '이하') return { text, range: { lte: amount } };
  if (suffix === '미만') return { text, range: { lt: amount } };
  if (suffix === '초과') return { text, range: { gt: amount } };
  return { text, range: { gte: amount, lte: amount } };
}

export function evaluateSearchFilters(query: string, rules: SearchFilterRule[], parsePrice = true): SearchFilterEvaluation {
  let remainingQuery = query.normalize('NFKC').trim();
  const normalizedQuery = normalize(remainingQuery);
  const termsToRemove = new Set<string>();
  const filters: Array<Record<string, unknown>> = [];
  const matchedRules: SearchFilterEvaluation['matchedRules'] = [];
  const priceMatches = (parsePrice ? [...remainingQuery.matchAll(/(^|[^\p{L}\p{N}])([0-9][0-9,]*)\s*(만원|만\s*원|만|원)\s*(대|이상|이하|미만|초과)(?=$|[^\p{L}\p{N}])/gu)] : [])
    .map((match) => parsePriceExpression(match[0].trim())).filter((item): item is NonNullable<typeof item> => Boolean(item));
  for (const [index, parsed] of priceMatches.entries()) {
    filters.push({ range: { sale_amt: parsed.range } });
    matchedRules.push({ id: `price-parser-${index}`, name: '가격 표현', kind: 'field', field: 'sale_amt', values: [parsed.text], range: parsed.range });
    remainingQuery = remainingQuery.replace(parsed.text, ' ');
  }
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (rule.kind === 'category' || rule.kind === 'field') {
      const matched = rule.detectionTerms.filter((term) => normalizedQuery.includes(term));
      if (!matched.length) continue;
      const values = [...new Set(rule.values)];
      filters.push(rule.matchType === 'term'
        ? { terms: { [rule.field]: values } }
        : { bool: { should: values.map((value) => rule.matchType === 'contains'
          ? { wildcard: { [rule.field]: `*${escapeWildcard(value)}*` } }
          : { prefix: { [rule.field]: value } }), minimum_should_match: 1 } });
      matchedRules.push({ id: rule.id, name: rule.name, kind: 'field', field: rule.field, values });
      for (const term of matched) termsToRemove.add(term);
    }
  }
  for (const term of [...termsToRemove].sort((left, right) => right.length - left.length)) {
    if (/\s/.test(term)) {
      remainingQuery = remainingQuery.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
      continue;
    }
    // 활용형 감지어가 들어간 어절 전체를 제거해 `쌀쌀할때`가 `때`로 남지 않게 한다.
    remainingQuery = remainingQuery.split(/\s+/).filter((token) => !normalize(token).includes(term)).join(' ');
  }
  return { remainingQuery: remainingQuery.replace(/\s+/g, ' ').trim(), filters, matchedRules };
}
