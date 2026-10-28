import type { BrandCatalog } from './brand-catalog-service';
import type { CategoryCatalog } from './category-catalog-service';

const letterOrNumber = /[\p{L}\p{N}]/u;
const KOREAN_PARTICLES = [
  '으로부터', '에게서', '한테서', '에서는', '으로는', '에게는', '한테는',
  '부터', '까지', '처럼', '보다', '마다', '조차', '마저', '밖에',
  '으로', '에게', '한테', '께서', '에서',
  '은', '는', '이', '가', '을', '를', '과', '와', '도', '만', '에', '로', '의',
] as const;

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function before(value: string, index: number): string {
  if (!index) return '';
  const previous = value.charCodeAt(index - 1);
  return value.slice(previous >= 0xDC00 && previous <= 0xDFFF ? index - 2 : index - 1, index);
}

function boundary(value: string, start: number, end: number): boolean {
  return !letterOrNumber.test(before(value, start)) && !letterOrNumber.test(String.fromCodePoint(value.codePointAt(end) || 0));
}

type Span = { start: number; end: number; text: string };

function findSpans(query: string, terms: string[], consumeKoreanSuffix = false): Span[] {
  const normalizedQuery = normalize(query);
  const candidates = [...new Set(terms.map(normalize).filter(Boolean))].flatMap((term) => {
    const matches: Span[] = [];
    let start = normalizedQuery.indexOf(term);
    while (start >= 0) {
      let end = start + term.length;
      if (!boundary(normalizedQuery, start, end) && consumeKoreanSuffix) {
        const suffix = KOREAN_PARTICLES.find((candidate) => normalizedQuery.startsWith(candidate, end) && boundary(normalizedQuery, start, end + candidate.length));
        if (suffix) end += suffix.length;
      }
      if (boundary(normalizedQuery, start, end)) matches.push({ start, end, text: term });
      start = normalizedQuery.indexOf(term, Math.max(end, start + 1));
    }
    return matches;
  }).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected: Span[] = [];
  for (const candidate of candidates) if (!selected.some((span) => candidate.start < span.end && candidate.end > span.start)) selected.push(candidate);
  return selected.sort((a, b) => a.start - b.start);
}

export interface StructuredSearchIntent {
  remainingQuery: string;
  filters: unknown[];
  appliedFilters: Array<{ id: string; name: string; field: string; values: string[] }>;
  categoryHardFiltered: boolean;
}

type PreparedBrandTerms = Map<string, { entries: BrandCatalog['entries']; exact: boolean }>;
type PreparedCategoryTerms = Map<string, { paths: CategoryCatalog['paths']; exact: boolean }>;
const preparedBrands = new WeakMap<BrandCatalog['entries'], Map<boolean, PreparedBrandTerms>>();
const preparedCategories = new WeakMap<CategoryCatalog['paths'], PreparedCategoryTerms>();

function prepareBrandTerms(brands: BrandCatalog): PreparedBrandTerms {
  const variants = preparedBrands.get(brands.entries) || new Map<boolean, PreparedBrandTerms>();
  const cached = variants.get(brands.complete);
  if (cached) return cached;
  const result: PreparedBrandTerms = new Map();
  for (const entry of brands.entries) {
    const term = normalize(entry.value);
    const current = result.get(term);
    result.set(term, { entries: [...(current?.entries || []), entry], exact: true });
  }
  if (brands.complete) for (const entry of brands.entries) {
    if (/[()]/u.test(entry.value) || /outlet/iu.test(entry.value)) continue;
    const source = normalize(entry.value);
    let alias = '';
    if (entry.field === 'bnd_nm_ko.keyword' && /^더[가-힣]+$/u.test(entry.value.trim())) {
      const candidate = entry.value.trim().slice(1);
      if ([...candidate].filter((character) => /[가-힣]/u.test(character)).length >= 2) alias = normalize(candidate);
    } else if (entry.field === 'bnd_nm_en.keyword' && /^the\s+[\p{L}\p{N} ]+$/iu.test(entry.value.trim())) {
      const candidate = entry.value.trim().replace(/^the\s+/iu, '');
      if ((candidate.match(/[\p{L}\p{N}]/gu) || []).length >= 3) alias = normalize(candidate);
    }
    if (!alias || result.has(alias)) continue;
    const ambiguous = brands.entries.some((other) => other.field === entry.field && normalize(other.value) !== source && normalize(other.value).includes(alias));
    if (!ambiguous) result.set(alias, { entries: [entry], exact: false });
  }
  variants.set(brands.complete, result);
  preparedBrands.set(brands.entries, variants);
  return result;
}

function prepareCategoryTerms(categories: CategoryCatalog): PreparedCategoryTerms {
  const cached = preparedCategories.get(categories.paths);
  if (cached) return cached;
  const result: PreparedCategoryTerms = new Map();
  for (const entry of categories.paths || []) for (const segment of entry.path.split('>').map((part) => part.trim()).filter(Boolean)) {
    const terms = [{ value: segment, exact: true }, ...segment.split(/[/,·]/u).map((value) => ({ value: value.trim(), exact: false }))];
    for (const term of terms) {
      const key = normalize(term.value);
      if (!key) continue;
      const current = result.get(key);
      if (current?.exact && !term.exact) continue;
      result.set(key, { paths: [...(current && current.exact === term.exact ? current.paths : []), entry], exact: term.exact });
    }
  }
  preparedCategories.set(categories.paths, result);
  return result;
}

export function detectStructuredSearchIntent(query: string, brands: BrandCatalog, categories: CategoryCatalog, categoryEnabled: boolean): StructuredSearchIntent {
  const brandByTerm = prepareBrandTerms(brands);
  let brandSpans = findSpans(query, [...brandByTerm.keys()], true);
  let brandEntries = brandSpans.flatMap((span) => brandByTerm.get(span.text)?.entries || []);
  const filters: unknown[] = [];
  const appliedFilters: StructuredSearchIntent['appliedFilters'] = [];

  const categoryTerms = categoryEnabled && categories.complete ? prepareCategoryTerms(categories) : new Map<string, { paths: CategoryCatalog['paths']; exact: boolean }>();
  let categorySpans = categoryEnabled && categories.complete ? findSpans(query, [...categoryTerms.keys()]) : [];
  const categoryPrefix = (term: string) => {
    const matches = categoryTerms.get(term)?.paths || [];
    const prefixes = [...new Map(matches.map((entry) => {
      const parts = entry.path.split('>').map((part) => part.trim()).filter(Boolean);
      const position = parts.findIndex((part) => normalize(part) === term || part.split(/[/,·]/u).some((alias) => normalize(alias) === term));
      const prefix = parts.slice(0, position + 1).join('>');
      return [`${entry.field}\0${prefix}`, { field: entry.field, prefix, depth: position + 1 }] as const;
    })).values()].filter((entry) => entry.depth >= 2 && entry.depth <= 3);
    return prefixes.length === 1 ? prefixes[0] : null;
  };
  let compoundSpan: Span | null = null;
  if (brands.complete && categories.complete && categoryEnabled) {
    const normalizedQuery = normalize(query);
    const candidates: Array<{ span: Span; brandTerm: string; categoryTerm: string }> = [];
    for (const match of normalizedQuery.matchAll(/\S+/gu)) {
      const token = match[0];
      const start = match.index;
      const characters = [...token];
      for (let position = 1; position < characters.length; position += 1) {
        const brandTerm = characters.slice(0, position).join('');
        const categoryTerm = characters.slice(position).join('');
        if (brandByTerm.has(brandTerm) && categoryTerms.has(categoryTerm) && categoryPrefix(categoryTerm)) {
          candidates.push({ span: { start, end: start + token.length, text: token }, brandTerm, categoryTerm });
        }
      }
    }
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const contains = (span: Span) => span.start >= candidate.span.start && span.end <= candidate.span.end;
      const hasOutsideBrand = brandSpans.some((span) => !contains(span));
      const hasOutsideCategory = categorySpans.some((span) => !contains(span));
      if (!hasOutsideBrand && !hasOutsideCategory) {
        compoundSpan = candidate.span;
        brandSpans = [{ ...candidate.span, text: candidate.brandTerm }];
        categorySpans = [{ ...candidate.span, text: candidate.categoryTerm }];
        brandEntries = brandByTerm.get(candidate.brandTerm)?.entries || [];
      }
    }
  }
  if (brandEntries.length) {
    filters.push({ bool: { should: brandEntries.map((entry) => ({ term: { [entry.field]: entry.value } })), minimum_should_match: 1 } });
    appliedFilters.push({ id: 'auto-brand', name: '자동 감지 브랜드', field: 'bnd_nm', values: [...new Set(brandEntries.map((entry) => entry.value))] });
  }
  let categoryHardFiltered = false;
  if (categorySpans.length === 1) {
    const selected = categoryPrefix(categorySpans[0].text);
    if (selected) {
      filters.push({ bool: { should: [
        { term: { [selected.field]: selected.prefix } },
        { prefix: { [selected.field]: `${selected.prefix}>` } },
      ], minimum_should_match: 1 } });
      appliedFilters.push({ id: 'auto-category', name: '자동 감지 카테고리', field: selected.field, values: [selected.prefix] });
      categoryHardFiltered = true;
    }
  }
  const consumed = [...(compoundSpan ? [compoundSpan] : brandSpans), ...(!compoundSpan && categoryHardFiltered ? categorySpans : [])].sort((a, b) => b.start - a.start);
  let remainingQuery = normalize(query);
  for (const span of consumed) remainingQuery = `${remainingQuery.slice(0, span.start)} ${remainingQuery.slice(span.end)}`;
  remainingQuery = remainingQuery.replace(/\s+/g, ' ').trim();
  return { remainingQuery, filters, appliedFilters, categoryHardFiltered };
}
