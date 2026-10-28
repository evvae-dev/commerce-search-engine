import { elasticClient } from './elastic-client';
import { validateSearchFilterRule, type SearchFilterRule } from './search-filter-evaluator';
import { listIndexingConfigs } from './indexing-config-service';

export const SEARCH_FILTER_INDEX = process.env.SEARCH_FILTER_INDEX || '.commerce-search-filter-v1';
export interface SearchFilterConfig { targetIndex: string; rules: SearchFilterRule[]; seqNo?: number; primaryTerm?: number; updatedAt: string; updatedBy: string }
export class SearchFilterServiceError extends Error { statusCode: number; constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; } }
const statusOf = (error: unknown) => (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;
let ready: Promise<void> | null = null;
async function ensureIndex() {
  if (!ready) ready = (async () => {
    if (await elasticClient.indices.exists({ index: SEARCH_FILTER_INDEX })) return;
    try { await elasticClient.indices.create({ index: SEARCH_FILTER_INDEX, mappings: { dynamic: false, properties: { targetIndex: { type: 'keyword' }, rules: { type: 'object', enabled: false }, updatedAt: { type: 'date' }, updatedBy: { type: 'keyword' } } } }); }
    catch (error) { if (statusOf(error) !== 400) throw error; }
  })().catch((error) => { ready = null; throw error; });
  return ready;
}
function validIndex(value: string) { return /^[a-z0-9][a-z0-9._-]{0,254}$/.test(value); }
export async function listSearchFilterConfigs(): Promise<SearchFilterConfig[]> {
  await ensureIndex();
  const response = await elasticClient.search<SearchFilterConfig>({ index: SEARCH_FILTER_INDEX, size: 500, query: { match_all: {} } });
  return response.hits.hits.map((hit) => ({ ...(hit._source as SearchFilterConfig), seqNo: hit._seq_no, primaryTerm: hit._primary_term })).filter((item) => item.targetIndex);
}
export async function getSearchFilterConfig(targetIndex: string): Promise<SearchFilterConfig> {
  await ensureIndex();
  if (!validIndex(targetIndex)) throw new SearchFilterServiceError(400, '적용 인덱스명이 올바르지 않습니다.');
  try {
    const response = await elasticClient.get<SearchFilterConfig>({ index: SEARCH_FILTER_INDEX, id: targetIndex });
    const source = response._source as SearchFilterConfig;
    return { ...source, rules: (source.rules || []).filter((rule) => (rule as { kind?: string }).kind !== 'price').map((rule) => ({ ...rule, kind: 'field' as const })), seqNo: response._seq_no, primaryTerm: response._primary_term };
  } catch (error) { if (statusOf(error) === 404) return { targetIndex, rules: [], updatedAt: '', updatedBy: '' }; throw error; }
}
async function validateFields(targetIndex: string, rules: SearchFilterRule[]) {
  if (!await elasticClient.indices.exists({ index: targetIndex })) throw new SearchFilterServiceError(404, `적용 인덱스를 찾을 수 없습니다: ${targetIndex}`);
  const fields = [...new Set([...rules.map((rule) => rule.field), 'sale_amt'])];
  if (!fields.length) return;
  const caps = await elasticClient.fieldCaps({ index: targetIndex, fields });
  for (const rule of rules) {
    const typeEntries = Object.entries(caps.fields?.[rule.field] || {});
    const allowed = ['keyword', 'wildcard'];
    if (!typeEntries.length || !typeEntries.every(([type, metadata]) => allowed.includes(type) && (metadata as { searchable?: boolean }).searchable !== false)) throw new SearchFilterServiceError(422, `필터에 사용할 수 없는 필드입니다: ${rule.field}`);
  }
  const priceEntries = Object.entries(caps.fields?.sale_amt || {});
  if (!priceEntries.length || !priceEntries.every(([type, metadata]) => ['byte', 'short', 'integer', 'long', 'float', 'double', 'half_float', 'scaled_float'].includes(type) && (metadata as { searchable?: boolean }).searchable !== false)) throw new SearchFilterServiceError(422, '가격 필터에 사용할 sale_amt 숫자 필드가 없습니다.');
}
export async function validateSearchFilterDraft(targetIndex: string, inputRules: unknown[]): Promise<SearchFilterRule[]> {
  if (!validIndex(targetIndex)) throw new SearchFilterServiceError(400, '적용 인덱스명이 올바르지 않습니다.');
  if (!(await listIndexingConfigs()).some((config) => config.indexName === targetIndex)) throw new SearchFilterServiceError(422, '등록된 색인 설정의 인덱스만 선택할 수 있습니다.');
  const rules = inputRules.filter((rule) => (rule as { kind?: string }).kind !== 'price').map((rule) => validateSearchFilterRule({ ...(rule as Partial<SearchFilterRule>), kind: 'field', targetIndex }));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new SearchFilterServiceError(400, '중복된 필터 ID가 있습니다.');
  await validateFields(targetIndex, rules);
  return rules;
}
export async function saveSearchFilterConfig(input: { targetIndex: string; rules: unknown[]; seqNo?: number; primaryTerm?: number }, by: string) {
  await ensureIndex();
  if (!validIndex(input.targetIndex)) throw new SearchFilterServiceError(400, '적용 인덱스명이 올바르지 않습니다.');
  if ((input.seqNo === undefined) !== (input.primaryTerm === undefined)) throw new SearchFilterServiceError(400, '동시 수정 검증 정보가 올바르지 않습니다.');
  const current = await getSearchFilterConfig(input.targetIndex);
  if (current.seqNo !== undefined && (input.seqNo === undefined || input.primaryTerm === undefined)) throw new SearchFilterServiceError(409, '최신 설정을 불러온 뒤 저장해 주세요.');
  const rules = await validateSearchFilterDraft(input.targetIndex, input.rules);
  const document = { targetIndex: input.targetIndex, rules, updatedAt: new Date().toISOString(), updatedBy: by };
  try {
    const response = await elasticClient.index({ index: SEARCH_FILTER_INDEX, id: input.targetIndex, document, refresh: 'wait_for', ...(input.seqNo !== undefined && input.primaryTerm !== undefined ? { if_seq_no: input.seqNo, if_primary_term: input.primaryTerm } : { op_type: 'create' as const }) });
    return { ...document, seqNo: response._seq_no, primaryTerm: response._primary_term } as SearchFilterConfig;
  } catch (error) { if (statusOf(error) === 409) throw new SearchFilterServiceError(409, '다른 사용자가 먼저 필터 설정을 저장했습니다. 다시 불러온 뒤 저장해 주세요.'); throw error; }
}
export function getSearchFilterError(error: unknown) { return { statusCode: error instanceof SearchFilterServiceError ? error.statusCode : statusOf(error) || 500, message: error instanceof Error ? error.message : '검색 필터 설정 처리에 실패했습니다.' }; }
