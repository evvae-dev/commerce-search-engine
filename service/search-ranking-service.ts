import { GOODS_INDEX } from '../constant/api.constant';
import { isContentsIndex } from '../constant/contents-index.constant';
import { getLegacyGoodsIndex } from '../constant/goods-index.constant.mjs';
import { elasticClient } from './elastic-client';
import { validatePopularityConfig, type PopularityConfig } from './popularity-formula';
import { validateAiSearchConfig, type AiSearchConfig } from './ai-search-query-service';
import { DEFAULT_CATEGORY_ADJUSTMENT, validateCategoryAdjustment, type CategoryAdjustmentConfig } from './category-adjustment';
import { DEFAULT_ADAPTIVE_SEARCH, validateAdaptiveSearch, type AdaptiveSearchConfig } from './adaptive-search';
import { DEFAULT_PERSONALIZATION, validatePersonalizationConfig, type PersonalizationConfig } from './personalization-config';

export const SEARCH_RANKING_INDEX = '.commerce-search-ranking-config-v1';

export interface SearchRankingField {
  field: string;
  boost: number;
  enabled: boolean;
}

export interface SearchRankingRevision {
  seqNo: number;
  primaryTerm: number;
}

export interface SearchRankingConfig {
  docType: 'search-ranking-config';
  id: string;
  targetIndex: string;
  fields: SearchRankingField[];
  keywordWeight: number;
  vectorWeight: number;
  popularity: PopularityConfig;
  categoryAdjustment: CategoryAdjustmentConfig;
  ai: AiSearchConfig;
  adaptiveSearch: AdaptiveSearchConfig;
  personalization: PersonalizationConfig;
  updatedAt: string;
  updatedBy: string;
  revision: SearchRankingRevision;
}

type StoredSearchRankingConfig = Omit<SearchRankingConfig, 'revision'>;

export const DEFAULT_KEYWORD_WEIGHT = 0.6;
export const DEFAULT_VECTOR_WEIGHT = 0.4;

const DEFAULT_FIELD_BOOSTS: Array<[string, number]> = [
  ['bnd_nm_ko', 200], ['bnd_nm_en', 200], ['goods_nm', 200], ['onl_goods_nm', 150],
  ['campaign_selling_point', 100], ['selling_point_txt', 80], ['mdl_no', 50], ['display_tag', 50],
  ['up_disp_clsf_nm', 50], ['disp_clsf_nm', 50], ['product_type', 50], ['item_size', 50], ['colors', 50],
  ['goods_id', 50], ['comp_goods_id', 50], ['season', 50], ['volume', 50], ['functionality', 50],
  ['skin_type', 50], ['intake_type', 50], ['exercise_material', 50],
];

export const DEFAULT_SEARCH_RANKING_FIELDS: SearchRankingField[] = DEFAULT_FIELD_BOOSTS.map(([field, boost]) => ({ field, boost, enabled: true }));
export const DEFAULT_CONTENTS_RANKING_FIELDS: SearchRankingField[] = [
  ['title', 200], ['sub_title', 120], ['kwd', 100], ['bdg_text', 80],
  ['bnd_nm_ko', 60], ['bnd_nm_en', 60], ['category', 50], ['corner', 40], ['hashtags', 40],
].map(([field, boost]) => ({ field: String(field), boost: Number(boost), enabled: true }));

function getErrorStatus(error: unknown): number | undefined {
  const typed = error as { statusCode?: number; meta?: { statusCode?: number } };
  return typed.statusCode ?? typed.meta?.statusCode;
}

function configId(targetIndex = GOODS_INDEX): string {
  return `goods:${Buffer.from(targetIndex).toString('base64url')}`;
}

let configIndexReady: Promise<void> | null = null;
const initializedTargets = new Set<string>();

async function ensureConfigIndex(): Promise<void> {
  if (!configIndexReady) configIndexReady = (async () => {
    if (await elasticClient.indices.exists({ index: SEARCH_RANKING_INDEX })) return;
    try {
      await elasticClient.indices.create({
      index: SEARCH_RANKING_INDEX,
      mappings: {
        properties: {
          docType: { type: 'keyword' },
          id: { type: 'keyword' },
          targetIndex: { type: 'keyword' },
          fields: {
            type: 'nested',
            properties: {
              field: { type: 'keyword' },
              boost: { type: 'double' },
              enabled: { type: 'boolean' },
            },
          },
          updatedAt: { type: 'date' },
          updatedBy: { type: 'keyword' },
        },
      },
      });
    } catch (error) {
      if (getErrorStatus(error) !== 400) throw error;
    }
  })().catch((error) => { configIndexReady = null; throw error; });
  return configIndexReady;
}

async function ensureSearchRankingConfig(targetIndex = GOODS_INDEX): Promise<void> {
  if (initializedTargets.has(targetIndex)) return;
  await ensureConfigIndex();
  const id = configId(targetIndex);
  let legacyConfig: StoredSearchRankingConfig | null = null;
  const legacyTargetIndex = getLegacyGoodsIndex(targetIndex);
  if (legacyTargetIndex) {
    try {
      const legacy = await elasticClient.get<StoredSearchRankingConfig>({
        index: SEARCH_RANKING_INDEX,
        id: configId(legacyTargetIndex),
      });
      legacyConfig = legacy._source || null;
    } catch (error) {
      if (getErrorStatus(error) !== 404) throw error;
    }
  }
  try {
    await elasticClient.create({
      index: SEARCH_RANKING_INDEX,
      id,
      document: legacyConfig
        ? { ...legacyConfig, id, targetIndex }
        : {
            docType: 'search-ranking-config',
            id,
            targetIndex,
            fields: isContentsIndex(targetIndex) ? DEFAULT_CONTENTS_RANKING_FIELDS : DEFAULT_SEARCH_RANKING_FIELDS,
            keywordWeight: DEFAULT_KEYWORD_WEIGHT,
            vectorWeight: DEFAULT_VECTOR_WEIGHT,
            popularity: validatePopularityConfig({}),
            categoryAdjustment: DEFAULT_CATEGORY_ADJUSTMENT,
            ai: validateAiSearchConfig({}),
            adaptiveSearch: DEFAULT_ADAPTIVE_SEARCH,
            personalization: DEFAULT_PERSONALIZATION,
            updatedAt: new Date().toISOString(),
            updatedBy: 'system',
          } satisfies StoredSearchRankingConfig,
      refresh: 'wait_for',
    });
  } catch (error) {
    if (getErrorStatus(error) !== 409) throw error;
  }
  initializedTargets.add(targetIndex);
}

export async function getSearchRankingConfig(targetIndex = GOODS_INDEX): Promise<SearchRankingConfig> {
  await ensureSearchRankingConfig(targetIndex);
  const result = await elasticClient.get<StoredSearchRankingConfig>({ index: SEARCH_RANKING_INDEX, id: configId(targetIndex) });
  if (!result._source || typeof result._seq_no !== 'number' || typeof result._primary_term !== 'number') {
    throw new Error('검색 가중치 설정 revision을 확인할 수 없습니다.');
  }
  return {
    ...result._source,
    keywordWeight: result._source.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT,
    vectorWeight: result._source.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    popularity: validatePopularityConfig(result._source.popularity),
    categoryAdjustment: validateCategoryAdjustment(result._source.categoryAdjustment),
    ai: validateAiSearchConfig(result._source.ai),
    adaptiveSearch: validateAdaptiveSearch(result._source.adaptiveSearch),
    personalization: validatePersonalizationConfig(result._source.personalization),
    revision: { seqNo: result._seq_no, primaryTerm: result._primary_term },
  };
}

export async function listAvailableSearchFields(targetIndex = GOODS_INDEX): Promise<string[]> {
  const caps = await elasticClient.fieldCaps({ index: targetIndex, fields: '*' });
  return Object.entries(caps.fields || {})
    .filter(([field, types]) => {
      if (field.endsWith('_vector')) return false;
      return Object.entries(types).some(([type, capability]) =>
        (type === 'text' || type === 'keyword') && capability.searchable !== false,
      );
    })
    .map(([field]) => field)
    .sort();
}

export async function listAvailableNumericFields(targetIndex = GOODS_INDEX): Promise<string[]> {
  const caps = await elasticClient.fieldCaps({ index: targetIndex, fields: '*' });
  return Object.entries(caps.fields || {}).filter(([, types]) => Object.keys(types).some((type) => ['byte', 'short', 'integer', 'long', 'float', 'double', 'half_float', 'scaled_float'].includes(type))).map(([field]) => field).sort();
}

export function validatePopularityFields(fields: string[], available: string[]): string[] {
  const missing = fields.find((field) => !available.includes(field));
  if (missing) throw new Error(`인기도 수식의 숫자 필드를 찾을 수 없습니다: ${missing}`);
  return fields;
}

export function validateSearchRankingFields(input: unknown): SearchRankingField[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    throw new Error('검색 필드는 1~100개로 입력해야 합니다.');
  }
  const fields = input.map((raw) => {
    const item = raw as Partial<SearchRankingField>;
    const field = typeof item.field === 'string' ? item.field.trim() : '';
    const boost = Number(item.boost);
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)) throw new Error(`필드명이 올바르지 않습니다: ${field || '(비어 있음)'}`);
    if (!Number.isFinite(boost) || boost < 0.1 || boost > 1000) throw new Error(`${field}의 가중치는 0.1~1000 사이여야 합니다.`);
    return { field, boost, enabled: item.enabled !== false };
  });
  if (new Set(fields.map((field) => field.field)).size !== fields.length) throw new Error('중복된 검색 필드가 있습니다.');
  if (!fields.some((field) => field.enabled)) throw new Error('사용할 검색 필드를 하나 이상 선택해야 합니다.');
  // 상품에 값이 없으면 매핑 자체가 생기지 않을 수 있으므로 미매핑 필드는 Elasticsearch가 무시하도록 허용한다.
  return fields;
}

export function validateSearchScoreWeights(keywordWeight: unknown, vectorWeight: unknown): { keywordWeight: number; vectorWeight: number } {
  const keyword = Number(keywordWeight);
  const vector = Number(vectorWeight);
  if (!Number.isFinite(keyword) || !Number.isFinite(vector) || keyword < 0 || keyword > 1 || vector < 0 || vector > 1 || Math.abs(keyword + vector - 1) > 0.000001) {
    throw new Error('키워드와 벡터 비율은 각각 0~100%이고 합계가 100%여야 합니다.');
  }
  return { keywordWeight: keyword, vectorWeight: vector };
}

export async function saveSearchRankingConfig(
  targetIndex: string,
  fields: SearchRankingField[],
  keywordWeight: number,
  vectorWeight: number,
  updatedBy: string,
  revision: SearchRankingRevision,
  popularity?: PopularityConfig,
  ai?: AiSearchConfig,
  categoryAdjustment?: CategoryAdjustmentConfig,
  adaptiveSearch?: AdaptiveSearchConfig,
  personalization?: PersonalizationConfig,
): Promise<SearchRankingConfig> {
  const id = configId(targetIndex);
  const document: StoredSearchRankingConfig = {
    docType: 'search-ranking-config',
    id,
    targetIndex,
    fields,
    keywordWeight,
    vectorWeight,
    popularity: popularity ?? validatePopularityConfig({}),
    categoryAdjustment: validateCategoryAdjustment(categoryAdjustment ?? DEFAULT_CATEGORY_ADJUSTMENT),
    ai: ai ?? validateAiSearchConfig({}),
    adaptiveSearch: validateAdaptiveSearch(adaptiveSearch ?? DEFAULT_ADAPTIVE_SEARCH),
    personalization: validatePersonalizationConfig(personalization ?? DEFAULT_PERSONALIZATION),
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await elasticClient.index({
    index: SEARCH_RANKING_INDEX,
    id,
    document,
    refresh: 'wait_for',
    if_seq_no: revision.seqNo,
    if_primary_term: revision.primaryTerm,
  });
  return getSearchRankingConfig(targetIndex);
}

export function rankingQueryFields(config: SearchRankingConfig): string[] {
  return config.fields.filter((item) => item.enabled).map((item) => `${item.field}^${item.boost}`);
}

export { getErrorStatus as getSearchRankingErrorStatus };
