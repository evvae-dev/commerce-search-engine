import type { estypes } from '@elastic/elasticsearch';

import { GOODS_INDEX } from '../constant/api.constant';
import { elasticClient } from './elastic-client';
import { searchTimeout, withSearchBudget } from './search-budget';
import { getSortConfigByName } from './sort-config-service';

export class ExhibitionGoodsInputError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) {
    super(message);
  }
}

export interface ExhibitionGoodsInput {
  exhbtNo?: string | string[];
  thmNo?: string | string[];
  sort?: string | string[];
  page?: string | string[];
  size?: string | string[];
}

function parseNumbers(value: string | string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  const numbers = (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(',').map((part) => part.trim()));
  if (numbers.length > 100 || numbers.some((number) => !/^\d+$/.test(number) || /^0+$/.test(number))) {
    throw new ExhibitionGoodsInputError('INVALID_EXHIBITION_FILTER', `${name}는 쉼표로 구분한 양의 정수이며 최대 100개까지 지정할 수 있습니다.`);
  }
  return [...new Set(numbers.map((number) => number.replace(/^0+/, '')))];
}

function parsePagination(value: string | string[] | undefined, fallback: number, maximum?: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const number = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || (maximum !== undefined && number > maximum)) {
    throw new ExhibitionGoodsInputError('INVALID_PAGINATION', 'page는 1 이상, size는 1~100 사이여야 합니다.');
  }
  return number;
}

function bindThemeSort(options: unknown[], filter: estypes.QueryDslQueryContainer): estypes.SortCombinations[] {
  const sorts = structuredClone(options) as estypes.SortCombinations[];
  for (const item of sorts) {
    if (!item || typeof item !== 'object') continue;
    for (const value of Object.values(item)) {
      if (!value || typeof value !== 'object' || !('nested' in value) || value.nested?.path !== 'exhibition_themes') continue;
      const previous = value.nested.filter;
      value.nested.filter = previous ? { bool: { filter: [previous, filter] } } : filter;
    }
  }
  // 모든 정렬 값이 같을 때도 상품 페이지 순서를 일정하게 유지한다.
  sorts.push({ goods_id: { order: 'asc' } });
  return sorts;
}

export async function getExhibitionGoods(input: ExhibitionGoodsInput) {
  const exhibitions = parseNumbers(input.exhbtNo, 'exhbtNo');
  const themes = parseNumbers(input.thmNo, 'thmNo');
  if (!exhibitions.length && !themes.length) {
    throw new ExhibitionGoodsInputError('EXHIBITION_FILTER_REQUIRED', 'exhbtNo 또는 thmNo가 필요합니다.');
  }
  const page = parsePagination(input.page, 1);
  const size = parsePagination(input.size, 20, 100);
  if (page * size > 10_000) {
    throw new ExhibitionGoodsInputError('INVALID_PAGINATION', '조회 가능한 범위는 처음 10,000개 상품까지입니다.');
  }
  const rawSort = Array.isArray(input.sort) ? input.sort[0] : input.sort;
  const sortName = rawSort?.trim().toUpperCase() || 'DAY_ORDER';
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(sortName)) {
    throw new ExhibitionGoodsInputError('INVALID_SORT_NAME', 'sort는 검색정렬 관리에 등록된 정렬명이어야 합니다.');
  }
  const filters: estypes.QueryDslQueryContainer[] = [];
  if (exhibitions.length) filters.push({ terms: { 'exhibition_themes.exhbt_no': exhibitions } });
  if (themes.length) filters.push({ terms: { 'exhibition_themes.thm_no': themes } });
  const themeFilter: estypes.QueryDslQueryContainer = { bool: { filter: filters } };

  return withSearchBudget(searchTimeout('SEARCH_TOTAL_TIMEOUT_MS', 6000, 10000), async () => {
    const config = await getSortConfigByName(GOODS_INDEX, sortName);
    if (!config) {
      throw new ExhibitionGoodsInputError('SORT_CONFIG_NOT_FOUND', `등록된 정렬을 찾을 수 없습니다: ${sortName}`, 404);
    }
    const response = await elasticClient.search<Record<string, unknown>>({
      index: GOODS_INDEX,
      from: (page - 1) * size,
      size,
      track_total_hits: true,
      allow_partial_search_results: false,
      timeout: '5s',
      query: { bool: { filter: [{ nested: { path: 'exhibition_themes', score_mode: 'none', query: themeFilter } }] } },
      sort: bindThemeSort(config.sortOptions, themeFilter),
      _source: { excludes: [
        '*_vector', 'embedding_text', 'embedding_source', 'embedding_geo_fingerprint', 'embedding_context_hash',
        'exhibition_themes', 'exhbt_no', 'thm_no',
      ] },
    });
    if (response.timed_out || (response._shards?.failed || 0) > 0) {
      throw new Error('상품 조회 결과가 불완전합니다.');
    }
    return {
      page,
      size,
      total: typeof response.hits.total === 'number' ? response.hits.total : response.hits.total?.value || 0,
      result: response.hits.hits.map((hit) => hit._source || {}),
    };
  });
}
