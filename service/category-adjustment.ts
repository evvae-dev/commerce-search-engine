export interface CategoryAdjustmentConfig {
  enabled: boolean;
  matchMultiplier: number;
  mismatchMultiplier: number;
  undetectedMultiplier: number;
}

export interface CategoryAdjustmentDiagnostic {
  status: 'match' | 'mismatch' | 'undetected';
  detectedTerm: string | null;
  targetCategory: string | null;
  actualCategories: string[];
  multiplier: number;
  reason: string;
}

export interface PreparedCategoryAdjustment {
  detectedTerm: string | null;
  targetCategory: string | null;
  normalizedTargetCategories: string[];
  source: 'query' | 'ai' | null;
  detectionReason: string | null;
  catalogComplete: boolean;
  catalogHasCategories: boolean;
}

export const DEFAULT_CATEGORY_ADJUSTMENT: CategoryAdjustmentConfig = {
  enabled: false,
  matchMultiplier: 1.25,
  mismatchMultiplier: 0.9,
  undetectedMultiplier: 1,
};

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

interface PreparedCategoryCatalog {
  terms: Array<{ term: string; normalizedTerm: string; category: string; normalizedCategory: string }>;
  knownCategoryByNormalized: Map<string, string>;
  knownCategoryByPart: Map<string, string>;
}

const preparedCategoryCatalogs = new WeakMap<string[], PreparedCategoryCatalog>();
const letterOrNumber = /[\p{L}\p{N}]/u;

function prepareCategoryCatalog(categories: string[]): PreparedCategoryCatalog {
  const cached = preparedCategoryCatalogs.get(categories);
  if (cached) return cached;
  const knownCategoryByNormalized = new Map(categories.map((category) => [normalize(category), category]));
  const knownCategoryByPart = new Map(categories.flatMap((category) => category.split(/[/,·]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => [normalize(part), category] as const)));
  const terms = categories.flatMap((category) => [category, ...category.split(/[/,·]/u)]
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => ({ term, normalizedTerm: normalize(term), category, normalizedCategory: normalize(category) })))
    .filter(({ normalizedTerm }) => normalizedTerm);
  const prepared = { terms, knownCategoryByNormalized, knownCategoryByPart };
  preparedCategoryCatalogs.set(categories, prepared);
  return prepared;
}

function characterBefore(value: string, index: number): string {
  if (!index) return '';
  const previous = value.charCodeAt(index - 1);
  const start = previous >= 0xDC00 && previous <= 0xDFFF ? index - 2 : index - 1;
  return value.slice(Math.max(0, start), index);
}

function hasWordBoundary(value: string, start: number, end: number): boolean {
  return !letterOrNumber.test(characterBefore(value, start)) && !letterOrNumber.test(String.fromCodePoint(value.codePointAt(end) || 0));
}

export function validateCategoryAdjustment(input: unknown): CategoryAdjustmentConfig {
  const source = input && typeof input === 'object' ? input as Partial<CategoryAdjustmentConfig> : {};
  const multiplier = (value: unknown, fallback: number, label: string) => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 0.1 || number > 5) throw new Error(`${label}는 0.1~5 사이여야 합니다.`);
    return number;
  };
  return {
    enabled: source.enabled === true,
    matchMultiplier: multiplier(source.matchMultiplier, DEFAULT_CATEGORY_ADJUSTMENT.matchMultiplier, '일치 배율'),
    mismatchMultiplier: multiplier(source.mismatchMultiplier, DEFAULT_CATEGORY_ADJUSTMENT.mismatchMultiplier, '불일치 배율'),
    undetectedMultiplier: multiplier(source.undetectedMultiplier, DEFAULT_CATEGORY_ADJUSTMENT.undetectedMultiplier, '감지 안 됨 배율'),
  };
}

export function prepareCategoryAdjustment(
  query: string,
  config: CategoryAdjustmentConfig,
  categoryCatalog: { categories: string[]; complete: boolean } = { categories: [], complete: false },
  aiCategories: string[] = [],
): PreparedCategoryAdjustment {
  if (!config.enabled) {
    return { detectedTerm: null, targetCategory: null, normalizedTargetCategories: [], source: null, detectionReason: '카테고리 보정이 비활성화되어 있습니다.', catalogComplete: categoryCatalog.complete, catalogHasCategories: categoryCatalog.categories.length > 0 };
  }
  const normalizedQuery = normalize(query);
  const preparedCatalog = prepareCategoryCatalog(categoryCatalog.categories);
  const candidates = preparedCatalog.terms.flatMap(({ term, normalizedTerm, category, normalizedCategory }) => {
    const matches = [];
    let start = normalizedQuery.indexOf(normalizedTerm);
    while (start >= 0) {
      const end = start + normalizedTerm.length;
      if (hasWordBoundary(normalizedQuery, start, end)) matches.push({ term, category, normalizedCategory, start, end, length: normalizedTerm.length });
      start = normalizedQuery.indexOf(normalizedTerm, end);
    }
    return matches;
  }).sort((left, right) => right.length - left.length || left.start - right.start);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (!selected.some((item) => candidate.start < item.end && candidate.end > item.start)) selected.push(candidate);
  }
  const categories = [...new Set(selected.map(({ normalizedCategory }) => normalizedCategory))];
  if (categories.length) {
    const queryTargets = categories.map((category) => selected.find((item) => item.normalizedCategory === category)?.category || category);
    return {
      detectedTerm: [...new Set(selected.map(({ term }) => term))].join(', '),
      targetCategory: queryTargets.join(', '),
      normalizedTargetCategories: categories,
      source: 'query',
      detectionReason: null,
      catalogComplete: categoryCatalog.complete,
      catalogHasCategories: categoryCatalog.categories.length > 0,
    };
  }

  const aiTargets = [...new Set(aiCategories.flatMap((category) => [category, ...category.split(/[/,·]/u)])
    .map((category) => category.trim())
    .filter(Boolean)
    .flatMap((category) => {
      const known = preparedCatalog.knownCategoryByNormalized.get(normalize(category)) || preparedCatalog.knownCategoryByPart.get(normalize(category));
      return known ? [known] : [];
    }))];
  if (aiTargets.length) {
    return { detectedTerm: aiCategories.join(', '), targetCategory: aiTargets.join(', '), normalizedTargetCategories: aiTargets.map(normalize), source: 'ai', detectionReason: null, catalogComplete: categoryCatalog.complete, catalogHasCategories: categoryCatalog.categories.length > 0 };
  }
  return { detectedTerm: null, targetCategory: null, normalizedTargetCategories: [], source: null, detectionReason: '검색어와 AI 결과에서 카테고리 표현을 감지하지 못했습니다.', catalogComplete: categoryCatalog.complete, catalogHasCategories: categoryCatalog.categories.length > 0 };
}

export function diagnosePreparedCategoryAdjustment(
  source: Record<string, unknown>,
  config: CategoryAdjustmentConfig,
  prepared: PreparedCategoryAdjustment,
): CategoryAdjustmentDiagnostic {
  const value = source.up_disp_clsf_nm;
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const actualCategories = [...new Set(values.flatMap((entry) => typeof entry === 'string' ? entry.split('>').map((part) => part.trim()).filter(Boolean) : []))];
  const multiplier = (status: CategoryAdjustmentDiagnostic['status']) => status === 'match'
    ? config.matchMultiplier
    : status === 'mismatch' ? config.mismatchMultiplier : config.undetectedMultiplier;
  if (!prepared.normalizedTargetCategories.length) {
    return { status: 'undetected', detectedTerm: prepared.detectedTerm, targetCategory: prepared.targetCategory, actualCategories, multiplier: multiplier('undetected'), reason: prepared.detectionReason || '검색어에서 카테고리 표현을 감지하지 못했습니다.' };
  }
  if (!actualCategories.length) {
    return { status: 'undetected', detectedTerm: prepared.detectedTerm, targetCategory: prepared.targetCategory, actualCategories, multiplier: multiplier('undetected'), reason: '상품 카테고리 값이 없습니다.' };
  }
  const matches = actualCategories.some((category) => prepared.normalizedTargetCategories.includes(normalize(category)));
  if (!matches && prepared.source === 'ai') {
    return { status: 'undetected', detectedTerm: prepared.detectedTerm, targetCategory: prepared.targetCategory, actualCategories, multiplier: multiplier('undetected'), reason: 'AI 선호 카테고리에 포함되지 않아 중립 점수를 적용했습니다.' };
  }
  if (!matches && !prepared.catalogComplete && prepared.catalogHasCategories) {
    return { status: 'undetected', detectedTerm: prepared.detectedTerm, targetCategory: prepared.targetCategory, actualCategories, multiplier: multiplier('undetected'), reason: '카테고리 목록이 일부만 수집되어 불일치를 판정하지 않았습니다.' };
  }
  const status = matches ? 'match' : 'mismatch';
  return { status, detectedTerm: prepared.detectedTerm, targetCategory: prepared.targetCategory, actualCategories, multiplier: multiplier(status), reason: matches ? '상품 카테고리 경로에 목표 카테고리가 있습니다.' : '상품 카테고리 경로에 목표 카테고리가 없습니다.' };
}

export function diagnoseCategoryAdjustment(
  query: string,
  source: Record<string, unknown>,
  config: CategoryAdjustmentConfig,
  categoryCatalog: { categories: string[]; complete: boolean } = { categories: [], complete: false },
): CategoryAdjustmentDiagnostic {
  return diagnosePreparedCategoryAdjustment(source, config, prepareCategoryAdjustment(query, config, categoryCatalog));
}
