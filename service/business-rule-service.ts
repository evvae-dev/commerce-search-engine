import crypto from 'node:crypto';

import { elasticClient } from './elastic-client';
import { evaluateRuleStatus, matchesPinRuleQuery, matchesScoreRuleCondition, normalizeBusinessRuleQuery } from './business-rule-evaluator';

export const BUSINESS_RULE_INDEX = process.env.BUSINESS_RULE_INDEX || '.commerce-business-rule-v1';
export type RuleStatus = 'active' | 'inactive';
export type RuleDisplayStatus = 'inactive' | 'scheduled' | 'running' | 'ended';
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'contains';
interface RuleBase { id: string; targetIndex: string; startAt: string; endAt: string; alwaysOn: boolean; status: RuleStatus; createdAt: string; updatedAt: string; updatedBy: string }
export interface ScoreRule extends RuleBase { kind: 'score'; name: string; description?: string; condition: { field: string; operator: ConditionOperator; value: number | string }; adjustment: number }
export interface PinProduct { goodsId: string; position: number }
export type PinMatchType = 'exact' | 'keyword';
export interface PinRule extends RuleBase { kind: 'pin'; query: string; normalizedQuery: string; matchType: PinMatchType; products: PinProduct[] }
export type BusinessRule = ScoreRule | PinRule;
export type BusinessRuleWithDisplayStatus = BusinessRule & { displayStatus: RuleDisplayStatus };

class BusinessRuleError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}
const statusOf = (error: unknown) => (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;

export const normalizeRuleQuery = normalizeBusinessRuleQuery;
function normalizeStoredRule(rule: BusinessRule & { goodsId?: string; position?: number }): BusinessRule {
  if (rule.kind !== 'pin') return { ...rule, alwaysOn: rule.alwaysOn === true };
  const products = Array.isArray(rule.products) ? rule.products : rule.goodsId && rule.position ? [{ goodsId: rule.goodsId, position: rule.position }] : [];
  return { ...rule, alwaysOn: rule.alwaysOn === true, normalizedQuery: normalizeRuleQuery(rule.normalizedQuery || rule.query), matchType: rule.matchType === 'keyword' ? 'keyword' : 'exact', products };
}
let indexReady: Promise<void> | null = null;

async function ensureIndex() {
  if (!indexReady) indexReady = (async () => {
    if (await elasticClient.indices.exists({ index: BUSINESS_RULE_INDEX })) return;
    try {
      await elasticClient.indices.create({ index: BUSINESS_RULE_INDEX, mappings: { dynamic: false, properties: {
      id: { type: 'keyword' }, kind: { type: 'keyword' }, targetIndex: { type: 'keyword' }, name: { type: 'keyword' }, query: { type: 'keyword' }, normalizedQuery: { type: 'keyword' },
      products: { type: 'nested', properties: { goodsId: { type: 'keyword' }, position: { type: 'integer' } } }, adjustment: { type: 'double' }, status: { type: 'keyword' },
      startAt: { type: 'date' }, endAt: { type: 'date' }, alwaysOn: { type: 'boolean' }, matchType: { type: 'keyword' }, createdAt: { type: 'date' }, updatedAt: { type: 'date' }, updatedBy: { type: 'keyword' },
      } } });
    } catch (error) { if (statusOf(error) !== 400) throw error; }
  })().catch((error) => { indexReady = null; throw error; });
  return indexReady;
}
function validDate(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Number.isFinite(new Date(value).getTime()); }
export function getRuleDisplayStatus(rule: BusinessRule, at = new Date()): RuleDisplayStatus {
  return evaluateRuleStatus(rule, at);
}
export function isRuleLive(rule: BusinessRule, at = new Date()): boolean { return getRuleDisplayStatus(rule, at) === 'running'; }

export function validateBusinessRule(input: Partial<BusinessRule>): BusinessRule {
  if (!input.targetIndex || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(input.targetIndex)) throw new BusinessRuleError(400, '적용 인덱스명이 올바르지 않습니다.');
  if (!['active', 'inactive'].includes(input.status || '')) throw new BusinessRuleError(400, '사용 여부가 올바르지 않습니다.');
  const alwaysOn = input.alwaysOn === true;
  if (!alwaysOn && (!validDate(input.startAt) || !validDate(input.endAt) || new Date(input.startAt) >= new Date(input.endAt))) throw new BusinessRuleError(400, '시작일과 종료일을 올바르게 입력해 주세요.');
  if (input.kind === 'score') {
    const rule = input as Partial<ScoreRule>; const adjustment = Number(rule.adjustment); const contains = rule.condition?.operator === 'contains';
    if (!rule.name?.trim() || rule.name.trim().length > 100) throw new BusinessRuleError(400, '룰 이름은 1~100자로 입력해 주세요.');
    if (!rule.condition?.field || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(rule.condition.field) || !['gt', 'gte', 'lt', 'lte', 'eq', 'contains'].includes(rule.condition.operator)) throw new BusinessRuleError(400, '점수 룰 조건을 입력해 주세요.');
    const value = contains ? String(rule.condition.value ?? '').trim() : Number(rule.condition.value);
    if (contains && (!value || String(value).length > 200)) throw new BusinessRuleError(400, '포함 조건 값은 1~200자로 입력해 주세요.');
    if (!contains && !Number.isFinite(value)) throw new BusinessRuleError(400, '조건 값은 숫자로 입력해 주세요.');
    if (!Number.isFinite(adjustment) || adjustment < -1 || adjustment > 5 || adjustment === 0) throw new BusinessRuleError(400, '점수 조정률은 -100%~500% 범위에서 0을 제외하고 입력해 주세요.');
    return { ...rule, alwaysOn, name: rule.name.trim(), condition: { ...rule.condition, value }, adjustment } as ScoreRule;
  }
  if (input.kind === 'pin') {
    const rule = input as Partial<PinRule>; const query = rule.query?.trim() || ''; const products = Array.isArray(rule.products) ? rule.products : [];
    const matchType: PinMatchType = rule.matchType === 'keyword' ? 'keyword' : 'exact';
    if (!query || query.length > 100) throw new BusinessRuleError(400, '검색어는 1~100자로 입력해 주세요.');
    if (products.length < 1 || products.length > 20) throw new BusinessRuleError(400, '고정 상품은 1~20개로 입력해 주세요.');
    const normalizedProducts = products.map((product) => ({ goodsId: String(product.goodsId || '').trim(), position: Number(product.position) }));
    if (normalizedProducts.some((product) => !/^[A-Za-z0-9_-]+$/.test(product.goodsId) || !Number.isInteger(product.position) || product.position < 1 || product.position > 100)) throw new BusinessRuleError(400, '상품 ID와 고정 순위(1~100)를 올바르게 입력해 주세요.');
    if (new Set(normalizedProducts.map((product) => product.goodsId)).size !== normalizedProducts.length) throw new BusinessRuleError(400, '중복된 상품 ID가 있습니다.');
    if (new Set(normalizedProducts.map((product) => product.position)).size !== normalizedProducts.length) throw new BusinessRuleError(400, '중복된 고정 순위가 있습니다.');
    return { ...rule, alwaysOn, query, normalizedQuery: normalizeRuleQuery(query), matchType, products: normalizedProducts } as PinRule;
  }
  throw new BusinessRuleError(400, '룰 유형이 올바르지 않습니다.');
}

async function validateTargetDetails(rule: BusinessRule) {
  if (!await elasticClient.indices.exists({ index: rule.targetIndex })) throw new BusinessRuleError(404, `적용 인덱스를 찾을 수 없습니다: ${rule.targetIndex}`);
  if (rule.kind === 'score') {
    const caps = await elasticClient.fieldCaps({ index: rule.targetIndex, fields: [rule.condition.field] }); const types = Object.keys(caps.fields?.[rule.condition.field] || {});
    const allowedTypes = rule.condition.operator === 'contains'
      ? ['keyword', 'text', 'match_only_text', 'wildcard']
      : ['byte', 'short', 'integer', 'long', 'float', 'double', 'half_float', 'scaled_float'];
    if (!types.some((type) => allowedTypes.includes(type))) throw new BusinessRuleError(422, `${rule.condition.operator === 'contains' ? '포함' : '숫자'} 조건에 사용할 수 없는 필드입니다: ${rule.condition.field}`);
    return;
  }
  const response = await elasticClient.mget({ index: rule.targetIndex, ids: rule.products.map((product) => product.goodsId) });
  const missing = response.docs.filter((document) => !('found' in document) || !document.found).map((document) => document._id);
  if (missing.length) throw new BusinessRuleError(422, `상품을 찾을 수 없습니다: ${missing.join(', ')}`);
}
function periodsOverlap(left: BusinessRule, right: BusinessRule): boolean { return left.alwaysOn || right.alwaysOn || new Date(left.startAt) <= new Date(right.endAt) && new Date(right.startAt) <= new Date(left.endAt); }
async function validateConflicts(rule: BusinessRule, excludeId?: string) {
  const rules = await listBusinessRules(rule.targetIndex);
  if (rule.kind === 'score' && rules.some((item) => item.id !== excludeId && item.kind === 'score' && item.name === rule.name)) throw new BusinessRuleError(409, '같은 이름의 점수 룰이 이미 있습니다.');
  if (rule.kind === 'pin' && rules.some((item) => item.id !== excludeId && item.kind === 'pin' && item.normalizedQuery === rule.normalizedQuery && item.status === 'active' && rule.status === 'active' && periodsOverlap(item, rule))) throw new BusinessRuleError(409, '같은 검색어의 상품 고정 기간이 겹칩니다.');
}
function now() { return new Date().toISOString(); }
export async function listBusinessRules(targetIndex?: string): Promise<BusinessRule[]> {
  await ensureIndex(); const response = await elasticClient.search<BusinessRule>({ index: BUSINESS_RULE_INDEX, size: 500, sort: [{ updatedAt: 'desc' }], query: { bool: { filter: [{ exists: { field: 'id' } }, ...(targetIndex ? [{ term: { targetIndex } }] : [])] } } });
  return response.hits.hits.map((hit) => hit._source && normalizeStoredRule(hit._source)).filter(Boolean) as BusinessRule[];
}
export async function listBusinessRulesWithStatus(targetIndex?: string): Promise<BusinessRuleWithDisplayStatus[]> { return (await listBusinessRules(targetIndex)).map((rule) => ({ ...rule, displayStatus: getRuleDisplayStatus(rule) })); }
export async function listRuleConditionFields(targetIndex: string): Promise<string[]> {
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(targetIndex)) throw new BusinessRuleError(400, '적용 인덱스명이 올바르지 않습니다.');
  const caps = await elasticClient.fieldCaps({ index: targetIndex, fields: '*' });
  const supportedTypes = ['byte', 'short', 'integer', 'long', 'float', 'double', 'half_float', 'scaled_float', 'keyword', 'text', 'match_only_text', 'wildcard'];
  return Object.entries(caps.fields || {}).filter(([, types]) => Object.keys(types).some((type) => supportedTypes.includes(type))).map(([field]) => field).sort();
}
export async function createBusinessRule(input: Partial<BusinessRule>, by: string): Promise<BusinessRule> {
  await ensureIndex(); const valid = validateBusinessRule(input); await validateTargetDetails(valid); await validateConflicts(valid); const id = crypto.randomUUID(); const timestamp = now(); const document = { ...valid, id, createdAt: timestamp, updatedAt: timestamp, updatedBy: by }; await elasticClient.create({ index: BUSINESS_RULE_INDEX, id, document, refresh: 'wait_for' }); return document;
}
export async function updateBusinessRule(id: string, input: Partial<BusinessRule>, by: string): Promise<BusinessRule> {
  await ensureIndex(); const old = await elasticClient.get<BusinessRule>({ index: BUSINESS_RULE_INDEX, id }); if (!old._source) throw new BusinessRuleError(404, '룰을 찾을 수 없습니다.'); const valid = validateBusinessRule({ ...normalizeStoredRule(old._source), ...input }); await validateTargetDetails(valid); await validateConflicts(valid, id); const document = { ...valid, id, createdAt: old._source.createdAt, updatedAt: now(), updatedBy: by }; await elasticClient.index({ index: BUSINESS_RULE_INDEX, id, document, refresh: 'wait_for' }); return document;
}
export async function deleteBusinessRule(id: string) { await ensureIndex(); try { await elasticClient.delete({ index: BUSINESS_RULE_INDEX, id, refresh: 'wait_for' }); } catch (error) { if (statusOf(error) === 404) throw new BusinessRuleError(404, '룰을 찾을 수 없습니다.'); throw error; } }
export function matchesScoreRule(rule: ScoreRule, source: Record<string, unknown>): boolean { return matchesScoreRuleCondition(rule, source); }
export function matchesPinRule(rule: PinRule, query: string, effectiveTokens: string[]): boolean { return matchesPinRuleQuery(rule, query, effectiveTokens); }
export function getBusinessRuleError(error: unknown) { return { statusCode: statusOf(error) || (error instanceof BusinessRuleError ? error.statusCode : 500), message: error instanceof Error ? error.message : '비즈니스 룰 처리에 실패했습니다.' }; }
