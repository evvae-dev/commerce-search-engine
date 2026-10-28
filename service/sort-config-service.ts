import crypto from 'node:crypto';

import type { estypes } from '@elastic/elasticsearch';

import { elasticClient } from './elastic-client';

export const SORT_CONFIG_INDEX = process.env.SORT_CONFIG_INDEX || '.commerce-sort-config-v1';

export interface SortConfig {
  docType: 'sort-config';
  id: string;
  targetIndex: string;
  sortName: string;
  description: string;
  sortOptions: unknown[];
  referencedFields: string[];
  validatedAt: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SortConfigInput {
  targetIndex: string;
  sortName: string;
  description: string;
  sortOptionsText: string;
}

class SortConfigValidationError extends Error {
  statusCode: number;
  errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

function getErrorStatus(error: unknown): number | undefined {
  const typed = error as { statusCode?: number; meta?: { statusCode?: number } };
  return typed.statusCode ?? typed.meta?.statusCode;
}

function getElasticReason(error: unknown): string {
  const typed = error as { message?: string; meta?: { body?: { error?: { reason?: string; root_cause?: Array<{ reason?: string }> } } } };
  return typed.meta?.body?.error?.root_cause?.[0]?.reason
    || typed.meta?.body?.error?.reason
    || typed.message
    || 'Elasticsearch가 정렬 옵션을 처리하지 못했습니다.';
}

async function ensureSortConfigIndex(): Promise<void> {
  if (await elasticClient.indices.exists({ index: SORT_CONFIG_INDEX })) return;
  try {
    await elasticClient.indices.create({
      index: SORT_CONFIG_INDEX,
      mappings: {
        dynamic: 'strict',
        properties: {
          docType: { type: 'keyword' },
          id: { type: 'keyword' },
          targetIndex: { type: 'keyword' },
          sortName: { type: 'keyword' },
          description: { type: 'keyword', index: false },
          sortOptions: { type: 'object', enabled: false },
          referencedFields: { type: 'keyword' },
          validatedAt: { type: 'date' },
          createdAt: { type: 'date' },
          createdBy: { type: 'keyword' },
          updatedAt: { type: 'date' },
          updatedBy: { type: 'keyword' },
        },
      },
    });
  } catch (error) {
    if (getErrorStatus(error) !== 400) throw error;
  }
}

function parseSortOptions(text: unknown): unknown[] {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SortConfigValidationError(400, 'EMPTY_SORT_OPTIONS', '정렬옵션을 JSON 배열로 입력해 주세요.');
  }
  if (Buffer.byteLength(text, 'utf8') > 20 * 1024) {
    throw new SortConfigValidationError(400, 'SORT_OPTIONS_TOO_LARGE', '정렬옵션은 20KB를 초과할 수 없습니다.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SortConfigValidationError(400, 'INVALID_JSON', `정렬옵션 JSON 문법이 올바르지 않습니다: ${error instanceof Error ? error.message : '파싱 오류'}`);
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new SortConfigValidationError(400, 'INVALID_SORT_OPTIONS', '정렬옵션은 1~20개의 항목을 가진 JSON 배열이어야 합니다.');
  }
  return parsed;
}

function validateSortStructure(sortOptions: unknown[]): string[] {
  const referenced = new Set<string>();
  for (const [index, rawItem] of sortOptions.entries()) {
    if (typeof rawItem === 'string') {
      if (!['_score', '_doc'].includes(rawItem)) referenced.add(rawItem);
      continue;
    }
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new SortConfigValidationError(400, 'INVALID_SORT_DSL', `정렬옵션 ${index + 1}번째 항목은 필드명 또는 객체여야 합니다.`);
    }
    const entries = Object.entries(rawItem as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new SortConfigValidationError(400, 'INVALID_SORT_DSL', `정렬옵션 ${index + 1}번째 객체에는 정렬 기준 하나만 입력해 주세요.`);
    }
    const [field, value] = entries[0];
    if (field === '_script') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SortConfigValidationError(400, 'INVALID_SCRIPT_SORT', '_script 정렬 설정이 올바르지 않습니다.');
      }
      const scriptSort = value as Record<string, unknown>;
      if (!['number', 'string'].includes(String(scriptSort.type))) {
        throw new SortConfigValidationError(400, 'INVALID_SCRIPT_TYPE', '_script.type은 number 또는 string이어야 합니다.');
      }
      if (!['asc', 'desc'].includes(String(scriptSort.order))) {
        throw new SortConfigValidationError(400, 'INVALID_SORT_ORDER', '_script.order는 asc 또는 desc여야 합니다.');
      }
      const script = scriptSort.script;
      if (!script || typeof script !== 'object' || Array.isArray(script)) {
        throw new SortConfigValidationError(400, 'INVALID_SCRIPT', '_script.script 객체가 필요합니다.');
      }
      const scriptObject = script as Record<string, unknown>;
      if ((scriptObject.lang ?? 'painless') !== 'painless') {
        throw new SortConfigValidationError(400, 'INVALID_SCRIPT_LANGUAGE', 'Painless 스크립트만 사용할 수 있습니다.');
      }
      if (typeof scriptObject.source !== 'string' || !scriptObject.source.trim()) {
        throw new SortConfigValidationError(400, 'EMPTY_SCRIPT_SOURCE', 'Painless source를 입력해 주세요.');
      }
      if (Buffer.byteLength(scriptObject.source, 'utf8') > 10 * 1024) {
        throw new SortConfigValidationError(400, 'SCRIPT_TOO_LARGE', 'Painless source는 10KB를 초과할 수 없습니다.');
      }
      const source = scriptObject.source;
      const matches = [...source.matchAll(/doc\s*\[\s*(['"])([^'"]+)\1\s*\]/g)];
      const docAccessCount = (source.match(/doc\s*\[/g) || []).length;
      if (matches.length !== docAccessCount) {
        throw new SortConfigValidationError(400, 'DYNAMIC_FIELD_ACCESS', "필드는 doc['field_name'] 형식의 고정 문자열로 참조해야 합니다.");
      }
      matches.forEach((match) => referenced.add(match[2]));
      continue;
    }
    if (field.startsWith('_')) {
      throw new SortConfigValidationError(400, 'UNSUPPORTED_SORT_TYPE', `지원하지 않는 정렬 유형입니다: ${field}`);
    }
    referenced.add(field);
    if (typeof value === 'string') {
      if (!['asc', 'desc'].includes(value)) {
        throw new SortConfigValidationError(400, 'INVALID_SORT_ORDER', `${field}의 order는 asc 또는 desc여야 합니다.`);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const order = (value as Record<string, unknown>).order;
      if (order !== undefined && !['asc', 'desc'].includes(String(order))) {
        throw new SortConfigValidationError(400, 'INVALID_SORT_ORDER', `${field}의 order는 asc 또는 desc여야 합니다.`);
      }
    } else {
      throw new SortConfigValidationError(400, 'INVALID_FIELD_SORT', `${field}의 정렬 설정이 올바르지 않습니다.`);
    }
  }
  return [...referenced].sort();
}

async function validateTargetAndFields(targetIndex: string, referencedFields: string[]): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(targetIndex) || targetIndex.startsWith('.')) {
    throw new SortConfigValidationError(400, 'INVALID_TARGET_INDEX', '적용 인덱스명이 올바르지 않습니다.');
  }
  if (!await elasticClient.indices.exists({ index: targetIndex })) {
    throw new SortConfigValidationError(404, 'TARGET_INDEX_NOT_FOUND', `적용 인덱스를 찾을 수 없습니다: ${targetIndex}`);
  }
  if (!referencedFields.length) return;
  const caps = await elasticClient.fieldCaps({ index: targetIndex, fields: referencedFields });
  const missing = referencedFields.filter((field) => !caps.fields?.[field]);
  if (missing.length) {
    throw new SortConfigValidationError(422, 'FIELD_NOT_FOUND', `적용 인덱스에 없는 필드입니다: ${missing.join(', ')}`);
  }
  const unsortable = referencedFields.filter((field) =>
    Object.values(caps.fields?.[field] || {}).every((capability) => capability.aggregatable === false),
  );
  if (unsortable.length) {
    throw new SortConfigValidationError(422, 'UNSORTABLE_FIELD', `정렬에 사용할 수 없는 필드입니다: ${unsortable.join(', ')}. text 필드는 keyword 하위 필드를 사용해 주세요.`);
  }
}

async function preflightSort(targetIndex: string, sortOptions: unknown[]): Promise<void> {
  try {
    await elasticClient.search({
      index: targetIndex,
      size: 1,
      query: { match_all: {} },
      sort: sortOptions as estypes.Sort,
      _source: false,
      allow_partial_search_results: false,
      timeout: '5s',
    });
  } catch (error) {
    throw new SortConfigValidationError(422, 'SORT_PREFLIGHT_FAILED', `Elasticsearch 정렬 검증에 실패했습니다: ${getElasticReason(error)}`);
  }
}

export async function validateSortConfigInput(input: SortConfigInput): Promise<{ validated: SortConfigInput; sortOptions: unknown[]; referencedFields: string[] }> {
  const targetIndex = typeof input.targetIndex === 'string' ? input.targetIndex.trim() : '';
  const sortName = typeof input.sortName === 'string' ? input.sortName.trim().toUpperCase() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(sortName)) {
    throw new SortConfigValidationError(400, 'INVALID_SORT_NAME', '정렬명은 영문 대문자로 시작하고 대문자, 숫자, 밑줄만 사용할 수 있습니다.');
  }
  if (!description || description.length > 200) {
    throw new SortConfigValidationError(400, 'INVALID_DESCRIPTION', '설명은 1~200자로 입력해 주세요.');
  }
  const sortOptions = parseSortOptions(input.sortOptionsText);
  const referencedFields = validateSortStructure(sortOptions);
  await validateTargetAndFields(targetIndex, referencedFields);
  await preflightSort(targetIndex, sortOptions);
  return { validated: { targetIndex, sortName, description, sortOptionsText: JSON.stringify(sortOptions, null, 2) }, sortOptions, referencedFields };
}

async function assertUnique(targetIndex: string, sortName: string, excludeId?: string): Promise<void> {
  const response = await elasticClient.search<SortConfig>({
    index: SORT_CONFIG_INDEX,
    size: 2,
    query: { bool: { filter: [{ term: { docType: 'sort-config' } }, { term: { targetIndex } }, { term: { sortName } }] } },
    _source: false,
  });
  if (response.hits.hits.some((hit) => hit._id !== excludeId)) {
    throw new SortConfigValidationError(409, 'DUPLICATE_SORT_NAME', '같은 적용 인덱스에 동일한 정렬명이 이미 등록되어 있습니다.');
  }
}

export async function listSortConfigs(): Promise<SortConfig[]> {
  await ensureSortConfigIndex();
  const response = await elasticClient.search<SortConfig>({
    index: SORT_CONFIG_INDEX,
    size: 500,
    sort: [{ targetIndex: 'asc' }, { sortName: 'asc' }],
    query: { term: { docType: 'sort-config' } },
  });
  return response.hits.hits.map((hit) => hit._source).filter((item): item is SortConfig => Boolean(item));
}

export async function getSortConfig(id: string): Promise<SortConfig | null> {
  await ensureSortConfigIndex();
  try {
    const response = await elasticClient.get<SortConfig>({ index: SORT_CONFIG_INDEX, id });
    return response._source || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) return null;
    throw error;
  }
}

export async function getSortConfigByName(targetIndex: string, sortName: string): Promise<SortConfig | null> {
  try {
    const response = await elasticClient.search<SortConfig>({
      index: SORT_CONFIG_INDEX,
      size: 1,
      query: { bool: { filter: [
        { term: { docType: 'sort-config' } },
        { term: { targetIndex } },
        { term: { sortName: sortName.trim().toUpperCase() } },
      ] } },
      allow_partial_search_results: false,
    });
    if (response.timed_out || (response._shards?.failed || 0) > 0) {
      throw new Error('정렬 설정 조회 결과가 불완전합니다.');
    }
    return response.hits.hits[0]?._source || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) return null;
    throw error;
  }
}

export async function createSortConfig(input: SortConfigInput, requester: string): Promise<SortConfig> {
  await ensureSortConfigIndex();
  const result = await validateSortConfigInput(input);
  await assertUnique(result.validated.targetIndex, result.validated.sortName);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const config: SortConfig = {
    docType: 'sort-config',
    id,
    targetIndex: result.validated.targetIndex,
    sortName: result.validated.sortName,
    description: result.validated.description,
    sortOptions: result.sortOptions,
    referencedFields: result.referencedFields,
    validatedAt: now,
    createdAt: now,
    createdBy: requester,
    updatedAt: now,
    updatedBy: requester,
  };
  await elasticClient.create({ index: SORT_CONFIG_INDEX, id, document: config, refresh: 'wait_for' });
  return config;
}

export async function updateSortConfig(id: string, input: SortConfigInput, requester: string): Promise<SortConfig> {
  const existing = await getSortConfig(id);
  if (!existing) throw new SortConfigValidationError(404, 'SORT_CONFIG_NOT_FOUND', '정렬 설정을 찾을 수 없습니다.');
  const result = await validateSortConfigInput(input);
  await assertUnique(result.validated.targetIndex, result.validated.sortName, id);
  const now = new Date().toISOString();
  const config: SortConfig = {
    ...existing,
    targetIndex: result.validated.targetIndex,
    sortName: result.validated.sortName,
    description: result.validated.description,
    sortOptions: result.sortOptions,
    referencedFields: result.referencedFields,
    validatedAt: now,
    updatedAt: now,
    updatedBy: requester,
  };
  await elasticClient.index({ index: SORT_CONFIG_INDEX, id, document: config, refresh: 'wait_for' });
  return config;
}

export async function deleteSortConfig(id: string): Promise<void> {
  if (!await getSortConfig(id)) throw new SortConfigValidationError(404, 'SORT_CONFIG_NOT_FOUND', '정렬 설정을 찾을 수 없습니다.');
  await elasticClient.delete({ index: SORT_CONFIG_INDEX, id, refresh: 'wait_for' });
}

export function getSortConfigError(error: unknown): { statusCode: number; errorCode: string; message: string } {
  if (error instanceof SortConfigValidationError) {
    return { statusCode: error.statusCode, errorCode: error.errorCode, message: error.message };
  }
  return { statusCode: 500, errorCode: 'SORT_CONFIG_ERROR', message: error instanceof Error ? error.message : '정렬 설정 처리 중 오류가 발생했습니다.' };
}
