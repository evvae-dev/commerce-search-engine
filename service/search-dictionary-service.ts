import crypto from 'node:crypto';
import { normalizeSearchQuery } from './search-query-policy';

import { elasticClient } from './elastic-client';
import { listIndexingConfigs } from './indexing-config-service';
import { normalizeRequestExpressions, RequestExpressionInputError } from './request-expression';

export const SEARCH_DICTIONARY_INDEX =
  process.env.SEARCH_DICTIONARY_INDEX || '.commerce-search-dictionary-v1';

export type SynonymMode = 'bidirectional' | 'unidirectional';
export interface SynonymRule {
  id: string;
  mode: SynonymMode;
  representative: string;
  terms: string[];
  enabled: boolean;
}
export interface SynonymConfig {
  docType: 'synonym-config';
  id: string;
  targetIndex: string;
  rules: SynonymRule[];
  updatedAt: string;
  updatedBy: string;
  revision: DictionaryRevision;
}
export interface StopWordRule { id: string; term: string; enabled: boolean; }
export type ForbiddenMatchType = 'token' | 'phrase';
export type ForbiddenAction = 'block' | 'warn';
export interface ForbiddenWordRule {
  id: string;
  term: string;
  matchType: ForbiddenMatchType;
  action: ForbiddenAction;
  message: string;
  enabled: boolean;
}
export interface WordPolicyConfig {
  docType: 'word-policy-config';
  id: string;
  targetIndex: string;
  stopWords: StopWordRule[];
  forbiddenWords: ForbiddenWordRule[];
  updatedAt: string;
  updatedBy: string;
  revision: DictionaryRevision;
}
export interface DictionaryRevision { seqNo: number; primaryTerm: number; }

export interface RequestExpressionConfig {
  targetIndex: string;
  phrases: string[];
  updatedAt: string;
  updatedBy: string;
  revision: DictionaryRevision | null;
}

interface StoredDictionaryDocument {
  docType: 'synonym-config' | 'word-policy-config' | 'request-expression-config';
  id: string;
  targetIndex: string;
  rules?: SynonymRule[];
  stopWords?: StopWordRule[];
  forbiddenWords?: ForbiddenWordRule[];
  phrases?: string[];
  updatedAt: string;
  updatedBy: string;
}

function statusOf(error: unknown): number | undefined {
  const typed = error as { statusCode?: number; meta?: { statusCode?: number } };
  return typed.statusCode ?? typed.meta?.statusCode;
}

export function getSearchDictionaryErrorStatus(error: unknown): number | undefined {
  return statusOf(error);
}

export function normalizeDictionaryTerm(value: unknown, label = '검색어'): string {
  if (typeof value !== 'string') throw new Error(`${label}을 입력해야 합니다.`);
  const normalized = normalizeSearchQuery(value);
  if (!normalized) throw new Error(`${label}을 입력해야 합니다.`);
  if (normalized.length > 100) throw new Error(`${label}은 100자 이하로 입력해야 합니다.`);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new Error(`${label}에 제어 문자를 사용할 수 없습니다.`);
  return normalized;
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : crypto.randomUUID();
}

function validateTargetIndex(targetIndex: unknown): string {
  if (typeof targetIndex !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(targetIndex)) {
    throw new Error('대상 인덱스가 올바르지 않습니다.');
  }
  return targetIndex;
}

async function assertRegisteredIndex(targetIndex: string): Promise<void> {
  const configs = await listIndexingConfigs();
  if (!configs.some((config) => config.indexName === targetIndex)) {
    throw new Error('등록된 대상 인덱스만 선택할 수 있습니다.');
  }
}

function normalizeSynonymRules(value: unknown): SynonymRule[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('동의어 규칙은 인덱스당 최대 1000개입니다.');
  const rules = value.map((raw, index) => {
    const item = raw as Partial<SynonymRule>;
    const mode = item.mode === 'unidirectional' ? 'unidirectional' : item.mode === 'bidirectional' ? 'bidirectional' : null;
    if (!mode) throw new Error(`${index + 1}번째 동의어 규칙의 방향이 올바르지 않습니다.`);
    const representative = normalizeDictionaryTerm(item.representative, '대표어');
    if (!Array.isArray(item.terms) || item.terms.length < 1 || item.terms.length > 20) throw new Error('동의어 terms는 규칙당 1~20개입니다.');
    const terms = item.terms.map((term) => normalizeDictionaryTerm(term, '동의어')); 
    const all = [representative, ...terms];
    if (new Set(all).size !== all.length) throw new Error('규칙 안에서 대표어와 동의어를 중복 입력할 수 없습니다.');
    return { id: normalizeId(item.id), mode: mode as SynonymMode, representative, terms, enabled: item.enabled !== false };
  });
  const bidirectionalSets = new Map<string, number>();
  const sourceOwners = new Map<string, number>();
  const edges = new Map<string, string>();
  rules.forEach((rule, index) => {
    if (rule.mode === 'bidirectional') {
      const key = [...new Set([rule.representative, ...rule.terms])].sort().join('\u0000');
      if (bidirectionalSets.has(key)) throw new Error('동일한 양방향 동의어 집합이 중복됩니다.');
      bidirectionalSets.set(key, index);
    } else {
      rule.terms.forEach((term) => {
        if (sourceOwners.has(term)) throw new Error('단방향 동의어 원문이 다른 규칙과 충돌합니다.');
        sourceOwners.set(term, index);
        if (edges.has(term) && edges.get(term) !== rule.representative) throw new Error('단방향 동의어 원문이 충돌합니다.');
        edges.set(term, rule.representative);
      });
    }
  });
  const hasCycle = (start: string): boolean => {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && edges.has(current)) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = edges.get(current);
    }
    return false;
  };
  if ([...edges.keys()].some(hasCycle)) throw new Error('단방향 동의어에 순환 참조가 있습니다.');
  return rules;
}

export function validateSynonymConfigInput(value: unknown): { targetIndex: string; rules: SynonymRule[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('동의어 설정 형식이 올바르지 않습니다.');
  const input = value as { targetIndex?: unknown; rules?: unknown };
  return { targetIndex: validateTargetIndex(input.targetIndex), rules: normalizeSynonymRules(input.rules) };
}

function normalizePolicyRows(value: unknown): { stopWords: StopWordRule[]; forbiddenWords: ForbiddenWordRule[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('단어 정책 설정 형식이 올바르지 않습니다.');
  const input = value as { stopWords?: unknown; forbiddenWords?: unknown };
  if (!Array.isArray(input.stopWords) || !Array.isArray(input.forbiddenWords) || input.stopWords.length + input.forbiddenWords.length > 1000) {
    throw new Error('단어 정책은 인덱스당 최대 1000개입니다.');
  }
  const stopWords = input.stopWords.map((raw, index) => {
    const item = raw as Partial<StopWordRule>;
    return { id: normalizeId(item.id), term: normalizeDictionaryTerm(item.term, `${index + 1}번째 불용어`), enabled: item.enabled !== false };
  });
  const forbiddenWords = input.forbiddenWords.map((raw, index) => {
    const item = raw as Partial<ForbiddenWordRule>;
    const matchType = item.matchType === 'phrase' ? 'phrase' : item.matchType === 'token' ? 'token' : null;
    const action = item.action === 'warn' ? 'warn' : item.action === 'block' ? 'block' : null;
    if (!matchType || !action) throw new Error(`${index + 1}번째 금지어의 검사 방식 또는 동작이 올바르지 않습니다.`);
    const message = typeof item.message === 'string' ? item.message.normalize('NFKC').trim().slice(0, 200) : '';
    return { id: normalizeId(item.id), term: normalizeDictionaryTerm(item.term, `${index + 1}번째 금지어`), matchType: matchType as ForbiddenMatchType, action: action as ForbiddenAction, message, enabled: item.enabled !== false };
  });
  const terms = [...stopWords.map((item) => item.term), ...forbiddenWords.map((item) => item.term)];
  if (new Set(terms).size !== terms.length) throw new Error('불용어와 금지어 사이에 중복된 단어가 있습니다.');
  return { stopWords, forbiddenWords };
}

export function assertNoSynonymPolicyOverlap(rules: SynonymRule[], policy: Pick<WordPolicyConfig, 'stopWords' | 'forbiddenWords'>): void {
  const synonymTerms = new Set(rules.flatMap((rule) => [rule.representative, ...rule.terms]).map(normalizeSearchQuery));
  const policyTerms = [...policy.stopWords, ...policy.forbiddenWords].map((item) => normalizeSearchQuery(item.term));
  if (policyTerms.some((term) => synonymTerms.has(term))) throw new Error('동의어와 불용어/금지어는 같은 단어를 사용할 수 없습니다.');
}

export async function validateDictionaryInput(value: unknown, kind: 'synonym' | 'policy'): Promise<{ targetIndex: string; rules?: SynonymRule[]; stopWords?: StopWordRule[]; forbiddenWords?: ForbiddenWordRule[] }> {
  const input: { targetIndex: string; rules?: SynonymRule[]; stopWords?: StopWordRule[]; forbiddenWords?: ForbiddenWordRule[] } = kind === 'synonym' ? validateSynonymConfigInput(value) : (() => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('단어 정책 설정 형식이 올바르지 않습니다.');
    const raw = value as { targetIndex?: unknown };
    return { targetIndex: validateTargetIndex(raw.targetIndex), ...normalizePolicyRows(value) };
  })();
  await assertRegisteredIndex(input.targetIndex);
  if (kind === 'synonym' && input.rules) {
    assertNoSynonymPolicyOverlap(input.rules, await getWordPolicyConfig(input.targetIndex));
  }
  if (kind === 'policy' && input.stopWords && input.forbiddenWords) {
    assertNoSynonymPolicyOverlap((await getSynonymConfig(input.targetIndex)).rules, { stopWords: input.stopWords, forbiddenWords: input.forbiddenWords });
  }
  return input;
}

function documentId(kind: 'synonym' | 'policy' | 'request-expression', targetIndex: string): string {
  return `${kind}:${Buffer.from(targetIndex).toString('base64url')}`;
}

let dictionaryIndexReady: Promise<void> | null = null;

async function ensureDictionaryIndex(): Promise<void> {
  if (!dictionaryIndexReady) dictionaryIndexReady = (async () => {
    if (await elasticClient.indices.exists({ index: SEARCH_DICTIONARY_INDEX })) return;
    try {
      await elasticClient.indices.create({
      index: SEARCH_DICTIONARY_INDEX,
      mappings: { properties: {
        docType: { type: 'keyword' }, id: { type: 'keyword' }, targetIndex: { type: 'keyword' },
        rules: { type: 'nested', properties: { id: { type: 'keyword' }, mode: { type: 'keyword' }, representative: { type: 'keyword' }, terms: { type: 'keyword' }, enabled: { type: 'boolean' } } },
        stopWords: { type: 'nested', properties: { id: { type: 'keyword' }, term: { type: 'keyword' }, enabled: { type: 'boolean' } } },
        forbiddenWords: { type: 'nested', properties: { id: { type: 'keyword' }, term: { type: 'keyword' }, matchType: { type: 'keyword' }, action: { type: 'keyword' }, message: { type: 'keyword' }, enabled: { type: 'boolean' } } },
        updatedAt: { type: 'date' }, updatedBy: { type: 'keyword' },
      } },
      });
    } catch (error) { if (statusOf(error) !== 400) throw error; }
  })().catch((error) => { dictionaryIndexReady = null; throw error; });
  return dictionaryIndexReady;
}

export async function listDictionaryTargets(): Promise<Array<{ id: string; displayName: string; indexName: string; environment: 'dev' | 'prd' }>> {
  return (await listIndexingConfigs()).map((config) => ({ id: config.id, displayName: config.displayName, indexName: config.indexName, environment: config.environment }));
}

export async function getSynonymConfig(targetIndex: string): Promise<SynonymConfig> {
  await ensureDictionaryIndex();
  await assertRegisteredIndex(targetIndex);
  const id = documentId('synonym', targetIndex);
  try {
    const result = await elasticClient.get<StoredDictionaryDocument>({ index: SEARCH_DICTIONARY_INDEX, id });
    if (!result._source || typeof result._seq_no !== 'number' || typeof result._primary_term !== 'number') throw new Error('동의어 설정 revision을 확인할 수 없습니다.');
    return { docType: 'synonym-config', id, targetIndex, rules: result._source.rules || [], updatedAt: result._source.updatedAt, updatedBy: result._source.updatedBy, revision: { seqNo: result._seq_no, primaryTerm: result._primary_term } };
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    const now = new Date().toISOString();
    await elasticClient.create({ index: SEARCH_DICTIONARY_INDEX, id, document: { docType: 'synonym-config', id, targetIndex, rules: [], updatedAt: now, updatedBy: 'system' }, refresh: 'wait_for' });
    return getSynonymConfig(targetIndex);
  }
}

export async function getWordPolicyConfig(targetIndex: string): Promise<WordPolicyConfig> {
  await ensureDictionaryIndex();
  await assertRegisteredIndex(targetIndex);
  const id = documentId('policy', targetIndex);
  try {
    const result = await elasticClient.get<StoredDictionaryDocument>({ index: SEARCH_DICTIONARY_INDEX, id });
    if (!result._source || typeof result._seq_no !== 'number' || typeof result._primary_term !== 'number') throw new Error('단어 정책 설정 revision을 확인할 수 없습니다.');
    return { docType: 'word-policy-config', id, targetIndex, stopWords: result._source.stopWords || [], forbiddenWords: result._source.forbiddenWords || [], updatedAt: result._source.updatedAt, updatedBy: result._source.updatedBy, revision: { seqNo: result._seq_no, primaryTerm: result._primary_term } };
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    const now = new Date().toISOString();
    await elasticClient.create({ index: SEARCH_DICTIONARY_INDEX, id, document: { docType: 'word-policy-config', id, targetIndex, stopWords: [], forbiddenWords: [], updatedAt: now, updatedBy: 'system' }, refresh: 'wait_for' });
    return getWordPolicyConfig(targetIndex);
  }
}

export async function saveSynonymConfig(input: { targetIndex: string; rules: SynonymRule[] }, updatedBy: string, revision: DictionaryRevision): Promise<SynonymConfig> {
  const id = documentId('synonym', input.targetIndex);
  await elasticClient.index({ index: SEARCH_DICTIONARY_INDEX, id, document: { docType: 'synonym-config', id, targetIndex: input.targetIndex, rules: input.rules, updatedAt: new Date().toISOString(), updatedBy }, refresh: 'wait_for', if_seq_no: revision.seqNo, if_primary_term: revision.primaryTerm });
  return getSynonymConfig(input.targetIndex);
}

export async function saveWordPolicyConfig(input: { targetIndex: string; stopWords: StopWordRule[]; forbiddenWords: ForbiddenWordRule[] }, updatedBy: string, revision: DictionaryRevision): Promise<WordPolicyConfig> {
  const id = documentId('policy', input.targetIndex);
  await elasticClient.index({ index: SEARCH_DICTIONARY_INDEX, id, document: { docType: 'word-policy-config', id, targetIndex: input.targetIndex, stopWords: input.stopWords, forbiddenWords: input.forbiddenWords, updatedAt: new Date().toISOString(), updatedBy }, refresh: 'wait_for', if_seq_no: revision.seqNo, if_primary_term: revision.primaryTerm });
  return getWordPolicyConfig(input.targetIndex);
}

/** 미등록 설정은 생성하지 않고 빈 목록으로 반환한다. */
export async function getRequestExpressionConfig(targetIndex: string): Promise<RequestExpressionConfig> {
  const id = documentId('request-expression', targetIndex);
  try {
    const result = await elasticClient.get<StoredDictionaryDocument>({ index: SEARCH_DICTIONARY_INDEX, id });
    if (!result._source || typeof result._seq_no !== 'number' || typeof result._primary_term !== 'number') throw new Error('요청 표현 revision을 확인할 수 없습니다.');
    return { targetIndex, phrases: normalizeRequestExpressions(result._source.phrases || []), updatedAt: result._source.updatedAt, updatedBy: result._source.updatedBy, revision: { seqNo: result._seq_no, primaryTerm: result._primary_term } };
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    return { targetIndex, phrases: [], updatedAt: '', updatedBy: '', revision: null };
  }
}

export async function validateRequestExpressionTarget(value: unknown): Promise<string> {
  let targetIndex: string;
  try { targetIndex = validateTargetIndex(value); }
  catch { throw new RequestExpressionInputError('대상 인덱스가 올바르지 않습니다.'); }
  const targets = await listDictionaryTargets();
  if (!targets.some((target) => target.indexName === targetIndex)) throw new RequestExpressionInputError('등록된 대상 인덱스만 선택할 수 있습니다.');
  return targetIndex;
}

export async function saveRequestExpressionConfig(input: { targetIndex: string; phrases: string[] }, updatedBy: string, revision: DictionaryRevision | null): Promise<RequestExpressionConfig> {
  await ensureDictionaryIndex();
  const id = documentId('request-expression', input.targetIndex);
  await elasticClient.index({
    index: SEARCH_DICTIONARY_INDEX, id,
    document: { docType: 'request-expression-config', id, ...input, updatedAt: new Date().toISOString(), updatedBy },
    refresh: 'wait_for',
    ...(revision ? { if_seq_no: revision.seqNo, if_primary_term: revision.primaryTerm } : { op_type: 'create' as const }),
  });
  return getRequestExpressionConfig(input.targetIndex);
}
