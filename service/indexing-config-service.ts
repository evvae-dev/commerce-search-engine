import crypto from 'node:crypto';

import cron from 'node-cron';

import { elasticClient } from './elastic-client';
import type { IndexingEnvironment } from './indexing-job-service';
import { normalizeGeoConfig } from '../scripts/geo-embedding-config.mjs';

export const INDEXING_CONFIG_INDEX =
  process.env.INDEXING_CONFIG_INDEX || '.commerce-indexing-config-v1';

export interface IndexingConfig {
  docType: 'config';
  id: string;
  environment: IndexingEnvironment;
  displayName: string;
  indexName: string;
  documentIdColumn: string;
  fullQuery: string;
  fullSchedule: string;
  fullEnabled: boolean;
  autoRegisterDictionary?: boolean;
  addQuery?: string;
  deleteQuery?: string;
  syncSchedule?: string;
  syncEnabled: boolean;
  embedding?: EmbeddingConfig;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingItem {
  label: string;
  fields: string[];
}

export interface EmbeddingConfig {
  enabled: boolean;
  items: EmbeddingItem[];
  geo?: { enabled: boolean; query: string; dbFields?: string[]; properties?: string[] };
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: true,
  items: [
    { label: '브랜드명', fields: ['bnd_nm_ko', 'bnd_nm_en'] },
    { label: '상품명', fields: ['onl_goods_nm', 'goods_nm'] },
    { label: '카테고리', fields: ['up_disp_clsf_nm', 'disp_clsf_nm'] },
    { label: '색상', fields: ['colors'] },
    { label: '상품유형', fields: ['product_type'] },
    { label: '시즌', fields: ['season'] },
    { label: '성별', fields: ['recommended_gender'] },
    { label: '특징', fields: ['selling_point_txt', 'selling_point'] },
  ],
};

export const NEW_INDEX_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  items: [],
};

const EMBEDDING_FORBIDDEN_FIELDS = new Set([
  'embedding_text', 'embedding_version', 'embedding_hash',
  'embedding_source', 'embedding_geo_fingerprint', 'embedding_context_hash', 'geo_content', 'geo_payload',
]);

export function normalizeEmbeddingConfig(value?: EmbeddingConfig, indexName?: string): EmbeddingConfig {
  if (!value) return { ...DEFAULT_EMBEDDING_CONFIG, geo: normalizeGeoConfig(undefined, indexName) };
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.items)) {
    throw new Error('임베딩 설정 형식이 올바르지 않습니다.');
  }
  const items = value.items.map((item) => {
    if (!item || typeof item.label !== 'string' || !item.label.trim() || !Array.isArray(item.fields) || !item.fields.length) {
      throw new Error('임베딩 항목명과 필드를 입력해야 합니다.');
    }
    const fields = item.fields.map((field) => String(field).trim().toLowerCase());
    if (fields.some((field) => !/^[a-z][a-z0-9_.]*$/.test(field) || field.endsWith('_vector') || EMBEDDING_FORBIDDEN_FIELDS.has(field))) {
      throw new Error('임베딩 대상에 허용되지 않는 필드가 포함되어 있습니다.');
    }
    return { label: item.label.trim().slice(0, 100), fields: [...new Set(fields)] };
  });
  return { enabled: value.enabled, items, geo: normalizeGeoConfig(value.geo, indexName) };
}

export type IndexingConfigInput = Omit<
  IndexingConfig,
  'docType' | 'id' | 'createdAt' | 'updatedAt'
>;

function getErrorStatus(error: unknown): number | undefined {
  const typed = error as { statusCode?: number; meta?: { statusCode?: number } };
  return typed.statusCode ?? typed.meta?.statusCode;
}

function stripSqlLiteralsAndComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
}

export function validateReadOnlySql(sql: string, label: string): string {
  const value = typeof sql === 'string' ? sql.trim() : '';
  if (!value) throw new Error(`${label}이 비어 있습니다.`);
  const normalized = stripSqlLiteralsAndComments(value);
  if (!/^\s*(select|with)\b/i.test(normalized)) {
    throw new Error(`${label}은 SELECT 또는 WITH 문으로 시작해야 합니다.`);
  }
  if (normalized.includes(';')) {
    throw new Error(`${label}에는 세미콜론을 사용할 수 없습니다.`);
  }
  const sqlWithoutListaggOverflow = normalized.replace(
    /\bon\s+overflow\s+truncate\b/gi,
    ' ',
  );
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|begin|declare|call|execute|commit|rollback)\b/i.test(sqlWithoutListaggOverflow)) {
    throw new Error(`${label}에는 데이터 변경 구문을 사용할 수 없습니다.`);
  }
  const binds = [...normalized.matchAll(/:([a-zA-Z][a-zA-Z0-9_]*)/g)].map(
    (match) => match[1].toLowerCase(),
  );
  const invalidBind = binds.find((bind) => bind !== 'claim_id');
  if (invalidBind) throw new Error(`${label}에서 허용되지 않은 바인드 변수입니다: ${invalidBind}`);
  return value;
}

export function validateIndexingConfigInput(input: IndexingConfigInput): IndexingConfigInput {
  if (!['dev', 'prd'].includes(input.environment)) throw new Error('환경은 dev 또는 prd여야 합니다.');
  const displayName = input.displayName?.trim();
  if (!displayName || displayName.length > 100) throw new Error('항목명은 1~100자로 입력해야 합니다.');
  const indexName = input.indexName?.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(indexName)) throw new Error('인덱스명은 소문자 영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.');
  if (!indexName.startsWith(`${input.environment}-`)) throw new Error(`인덱스명은 ${input.environment}- 접두어로 시작해야 합니다.`);
  const documentIdColumn = input.documentIdColumn?.trim().toLowerCase();
  if (!documentIdColumn || !/^[a-z][a-z0-9_]{0,63}$/.test(documentIdColumn)) throw new Error('문서 ID 컬럼명을 입력해 주세요. 영문으로 시작하는 영문·숫자·밑줄만 사용할 수 있습니다.');
  if (input.autoRegisterDictionary !== undefined && typeof input.autoRegisterDictionary !== 'boolean') throw new Error('사전 자동등록 여부는 체크박스 값이어야 합니다.');
  if (!cron.validate(input.fullSchedule?.trim())) throw new Error('전체 색인 주기가 올바른 5필드 cron 표현식이 아닙니다.');
  const fullQuery = validateReadOnlySql(input.fullQuery, '전체 색인 SQL');
  const addQuery = input.addQuery?.trim() || undefined;
  const deleteQuery = input.deleteQuery?.trim() || undefined;
  if (Boolean(addQuery) !== Boolean(deleteQuery)) throw new Error('증분 SQL과 삭제 SQL은 함께 입력해야 합니다.');
  let syncSchedule = input.syncSchedule?.trim() || undefined;
  if (addQuery && (!syncSchedule || !cron.validate(syncSchedule))) throw new Error('증분/삭제 주기가 올바른 5필드 cron 표현식이 아닙니다.');
  if (!addQuery) syncSchedule = undefined;
  return {
    ...input,
    displayName,
    indexName,
    documentIdColumn,
    autoRegisterDictionary: input.autoRegisterDictionary !== false,
    fullQuery,
    fullSchedule: input.fullSchedule.trim(),
    addQuery: addQuery ? validateReadOnlySql(addQuery, '증분 색인 SQL') : undefined,
    deleteQuery: deleteQuery ? validateReadOnlySql(deleteQuery, '삭제 색인 SQL') : undefined,
    syncSchedule,
    syncEnabled: Boolean(addQuery) && input.syncEnabled !== false,
    ...(input.embedding === undefined ? {} : { embedding: normalizeEmbeddingConfig(input.embedding, indexName) }),
  };
}

async function ensureConfigIndex(): Promise<void> {
  const exists = await elasticClient.indices.exists({ index: INDEXING_CONFIG_INDEX });
  if (exists) return;
  try {
    await elasticClient.indices.create({
      index: INDEXING_CONFIG_INDEX,
      mappings: {
        properties: {
          docType: { type: 'keyword' },
          id: { type: 'keyword' },
          environment: { type: 'keyword' },
          displayName: { type: 'keyword' },
          indexName: { type: 'keyword' },
          documentIdColumn: { type: 'keyword' },
          fullQuery: { type: 'text', index: false },
          fullSchedule: { type: 'keyword' },
          fullEnabled: { type: 'boolean' },
          autoRegisterDictionary: { type: 'boolean' },
          addQuery: { type: 'text', index: false },
          deleteQuery: { type: 'text', index: false },
          syncSchedule: { type: 'keyword' },
          syncEnabled: { type: 'boolean' },
          embedding: { type: 'object', enabled: false, properties: {
            enabled: { type: 'boolean' },
            items: { type: 'object', enabled: false },
          } },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
        },
      },
    });
  } catch (error) {
    if (getErrorStatus(error) !== 400) throw error;
  }
}

export async function ensureIndexingConfigs(): Promise<void> {
  await ensureConfigIndex();
}

export async function listIndexingConfigs(): Promise<IndexingConfig[]> {
  await ensureIndexingConfigs();
  const response = await elasticClient.search<IndexingConfig>({
    index: INDEXING_CONFIG_INDEX,
    size: 200,
    sort: [{ environment: { order: 'asc' } }, { indexName: { order: 'asc' } }],
    query: { term: { docType: 'config' } },
  });
  return response.hits.hits.map((hit) => hit._source).filter((value): value is IndexingConfig => Boolean(value));
}

export async function getIndexingConfig(id: string): Promise<IndexingConfig | null> {
  await ensureIndexingConfigs();
  try {
    const response = await elasticClient.get<IndexingConfig>({ index: INDEXING_CONFIG_INDEX, id });
    return response._source || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) return null;
    throw error;
  }
}

async function assertIndexNameAvailable(
  environment: IndexingEnvironment,
  indexName: string,
  excludeId?: string,
): Promise<void> {
  const response = await elasticClient.search<IndexingConfig>({
    index: INDEXING_CONFIG_INDEX,
    size: 2,
    query: {
      bool: {
        filter: [
          { term: { docType: 'config' } },
          { term: { environment } },
          { term: { indexName } },
        ],
      },
    },
  });
  if (response.hits.hits.some((hit) => hit._id !== excludeId)) {
    throw new Error('같은 환경에 동일한 인덱스명이 이미 등록되어 있습니다.');
  }
}

export async function createIndexingConfig(input: IndexingConfigInput): Promise<IndexingConfig> {
  await ensureIndexingConfigs();
  const validated = validateIndexingConfigInput(input);
  await assertIndexNameAvailable(validated.environment, validated.indexName);
  const now = new Date().toISOString();
  const config: IndexingConfig = { docType: 'config', id: crypto.randomUUID(), ...validated, embedding: validated.embedding || NEW_INDEX_EMBEDDING_CONFIG, createdAt: now, updatedAt: now };
  await elasticClient.create({ index: INDEXING_CONFIG_INDEX, id: config.id, document: config, refresh: 'wait_for' });
  return config;
}

export async function updateIndexingConfig(id: string, input: IndexingConfigInput): Promise<IndexingConfig> {
  const existing = await getIndexingConfig(id);
  if (!existing) throw Object.assign(new Error('인덱스 설정을 찾을 수 없습니다.'), { statusCode: 404 });
  const validated = validateIndexingConfigInput(input);
  await assertIndexNameAvailable(validated.environment, validated.indexName, id);
  const config: IndexingConfig = { ...existing, ...validated, embedding: validated.embedding || existing.embedding || DEFAULT_EMBEDDING_CONFIG, id, updatedAt: new Date().toISOString() };
  await elasticClient.index({ index: INDEXING_CONFIG_INDEX, id, document: config, refresh: 'wait_for' });
  return config;
}

export async function deleteIndexingConfig(id: string): Promise<void> {
  const existing = await getIndexingConfig(id);
  if (!existing) throw Object.assign(new Error('인덱스 설정을 찾을 수 없습니다.'), { statusCode: 404 });
  await elasticClient.delete({ index: INDEXING_CONFIG_INDEX, id, refresh: 'wait_for' });
}
export async function hasActiveIndexingJob(configId: string): Promise<boolean> {
  const jobsIndex = process.env.INDEXING_JOBS_INDEX || '.commerce-indexing-jobs-v1';
  try {
    const response = await elasticClient.count({
      index: jobsIndex,
      query: {
        bool: {
          filter: [
            { term: { docType: 'job' } },
            { term: { configId } },
            { terms: { status: ['queued', 'running'] } },
          ],
        },
      },
    });
    return response.count > 0;
  } catch (error) {
    if (getErrorStatus(error) === 404) return false;
    throw error;
  }
}
