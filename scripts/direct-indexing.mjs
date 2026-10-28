/**
 * SQLite 결과를 스트리밍으로 읽어 Elasticsearch Bulk API에 직접 반영한다.
 */
import { openDemoDatabase } from './demo-source.mjs';
import { getGoodsIndex } from '../constant/goods-index.constant.mjs';
import { getVectorField } from '../constant/vector-field.constant.mjs';
import { createEmbeddingHash, createEmbeddingText, createGeoEmbeddingText, createGeoFingerprint, createEmbeddingContextHash } from './embedding-text.mjs';
import { isGoodsGeoIndex, normalizeGeoConfig } from './geo-embedding-config.mjs';
import { createGeoReader } from './geo-embedding.mjs';
import { collectDictionaryWords, registerDictionaryWords } from './nori-dictionary.mjs';
import { isProtectedGoodsAlias } from './index-alias.mjs';

function positiveIntegerSetting(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(maximum, value) : fallback;
}

const FETCH_SIZE = 500;
const EMBEDDING_BATCH_SIZE = positiveIntegerSetting('EMBEDDING_BATCH_SIZE', 128, 512);
const EMBEDDING_REQUEST_BATCH_SIZE = positiveIntegerSetting('EMBEDDING_REQUEST_BATCH_SIZE', 32, 32);
const EMBEDDING_CONCURRENCY = positiveIntegerSetting('EMBEDDING_CONCURRENCY', 2, 8);

const EXHIBITION_THEMES_MAPPING = {
  type: 'nested',
  properties: {
    exhbt_no: { type: 'keyword' },
    thm_no: { type: 'keyword' },
    disp_prior_rank: { type: 'long' },
    fix_disp_prior_rank: { type: 'long' },
    main_disp_prior_rank: { type: 'long' },
  },
};

export function getIndexingErrorMessage(error, fallback) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

const QUEUE_BATCH_SIZE = positiveIntegerSetting('INDEXING_QUEUE_BATCH_SIZE', 1000, 10000);
const QUEUE_MAX_RETRY_COUNT = positiveIntegerSetting('INDEXING_QUEUE_MAX_RETRY_COUNT', 5, 20);
const QUEUE_STALE_MINUTES = positiveIntegerSetting('INDEXING_QUEUE_STALE_MINUTES', 35, 180);

// 큐는 로컬 SQLite 트랜잭션으로 선점한다. dev/prd는 같은 가상 원본을 사용한다.
export async function claimSyncQueue(environment, claimId) {
  const database = openDemoDatabase({ readOnly: false });
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`UPDATE DEMO_SYNC_QUEUE
      SET UPDATE_STATE = CASE WHEN RETRY_COUNT + 1 >= :max_retry THEN 'FAILED' ELSE 'WAIT' END,
          RETRY_COUNT = RETRY_COUNT + 1, CLAIM_ID = NULL,
          LAST_ERROR = '이전 작업 시간 초과'
      WHERE UPDATE_STATE = 'RUNNING' AND CLAIMED_AT < :stale`).run({
      max_retry: QUEUE_MAX_RETRY_COUNT, stale: Date.now() - QUEUE_STALE_MINUTES * 60_000,
    });
    const rows = database.prepare(`UPDATE DEMO_SYNC_QUEUE
      SET UPDATE_STATE = 'RUNNING', CLAIM_ID = :claim_id, CLAIMED_AT = :now
      WHERE QUEUE_ID IN (SELECT QUEUE_ID FROM DEMO_SYNC_QUEUE
        WHERE UPDATE_STATE = 'WAIT' ORDER BY QUEUE_ID LIMIT :batch_size)
      RETURNING QUEUE_ID`).all({ claim_id: claimId, now: Date.now(), batch_size: QUEUE_BATCH_SIZE });
    database.exec('COMMIT');
    return rows.length;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}

export async function completeSyncQueue(environment, claimId) {
  const database = openDemoDatabase({ readOnly: false });
  try {
    return database.prepare(`UPDATE DEMO_SYNC_QUEUE SET UPDATE_STATE = 'COMPLETE', LAST_ERROR = NULL
      WHERE CLAIM_ID = :claim_id AND UPDATE_STATE = 'RUNNING'`).run({ claim_id: claimId }).changes;
  } finally { database.close(); }
}

export async function failSyncQueue(environment, claimId, errorMessage) {
  const database = openDemoDatabase({ readOnly: false });
  try {
    return database.prepare(`UPDATE DEMO_SYNC_QUEUE
      SET UPDATE_STATE = CASE WHEN RETRY_COUNT + 1 >= :max_retry THEN 'FAILED' ELSE 'WAIT' END,
          RETRY_COUNT = RETRY_COUNT + 1, LAST_ERROR = :error, CLAIM_ID = NULL
      WHERE CLAIM_ID = :claim_id AND UPDATE_STATE = 'RUNNING'`).run({
      max_retry: QUEUE_MAX_RETRY_COUNT, error: String(errorMessage || '색인 실패'), claim_id: claimId,
    }).changes;
  } finally { database.close(); }
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function assertWithinDeadline(deadline) {
  if (remainingMs(deadline) <= 0) {
    const error = new Error('색인 작업의 최대 실행 시간을 초과했습니다.');
    error.code = 'ERR_INDEXING_TIMEOUT';
    throw error;
  }
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('사용자 요청으로 색인 작업을 중지했습니다.');
  error.code = 'ERR_INDEXING_CANCELLED_BY_USER';
  throw error;
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function formatKstApplyDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}`;
}

function normalizeRow(row) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (Object.hasOwn(normalized, 'exhibition_themes')) {
    try {
      const value = normalized.exhibition_themes;
      const themes = typeof value === 'string' ? JSON.parse(value) : value ?? [];
      if (!Array.isArray(themes) || themes.some((theme) => !theme || typeof theme !== 'object' || Array.isArray(theme))) {
        throw new Error('기획전 테마는 객체 배열이어야 합니다.');
      }
      normalized.exhibition_themes = themes;
    } catch (cause) {
      const error = new Error('EXHIBITION_THEMES를 기획전 테마 배열로 변환하지 못했습니다.', { cause });
      error.code = 'ERR_INDEXING_EXHIBITION_THEMES';
      throw error;
    }
  }
  return normalized;
}

async function sendBulk(client, operation, targetIndex, documentIdColumn, rows, deadline, signal) {
  assertWithinDeadline(deadline);
  assertNotAborted(signal);
  const operations = [];
  for (const rawRow of rows) {
    const row = normalizeRow(rawRow);
    const documentId = row[documentIdColumn];
    if (documentId === undefined || documentId === null || documentId === '') {
      const error = new Error('SQLite 조회 결과에 문서 ID 컬럼(' + documentIdColumn + ')이 없습니다.');
      error.code = 'ERR_INVALID_DOCUMENT';
      throw error;
    }
    delete row.tracking_dtm;
    delete row.es_action;
    delete row.geo_content;
    delete row.geo_payload;
    delete row.embedding_text;
    if (operation === 'delete') {
      operations.push({ delete: { _index: targetIndex, _id: String(documentId) } });
    } else if (operation === 'add') {
      // 증분 색인은 기존 임베딩 메타데이터를 보존해야 동일 문장 벡터를 재사용할 수 있다.
      operations.push({ update: { _index: targetIndex, _id: String(documentId) } });
      operations.push({ doc: row, doc_as_upsert: true });
    } else {
      operations.push({ index: { _index: targetIndex, _id: String(documentId) } });
      operations.push(row);
    }
  }
  if (operations.length === 0) return 0;

  const response = await client.bulk(
    { operations, refresh: false },
    { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal },
  );
  assertNotAborted(signal);
  let succeeded = 0;
  for (const item of response.items || []) {
    const result = item.index || item.update || item.delete;
    if (!result) continue;
    if (result.error && !(operation === 'delete' && result.status === 404)) {
      const error = new Error(
        `Elasticsearch Bulk 실패 (${result.status || 'unknown'}): ` +
          (result.error.reason || result.error.type || '원인 미상'),
      );
      error.code = 'ERR_ES_BULK';
      throw error;
    }
    succeeded += 1;
  }
  return succeeded;
}

const DEFAULT_EMBEDDING_CONFIG = {
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

const EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION || 'intfloat/multilingual-e5-small:v1';

async function ensureEmbeddingTextMapping(client, index, deadline, signal) {
  assertWithinDeadline(deadline);
  assertNotAborted(signal);
  const options = { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal };
  const mappings = await client.indices.getMapping({ index }, options);
  if (Object.values(mappings).some((entry) => entry.mappings?.properties?.embedding_text)) return;
  await client.indices.putMapping({ index, properties: { embedding_text: { type: 'text', index: false } } }, options);
}

async function vectorizeDocuments(client, targetIndex, documentIds, deadline, embeddingConfig, changedOnly = false, signal, onProgress, reuseSourceIndex, geoReader, force = false) {
  const batchController = new AbortController();
  signal = signal ? AbortSignal.any([signal, batchController.signal]) : batchController.signal;
  const embeddingNode = process.env.EMBEDDING_NODE || 'http://127.0.0.1:18080';
  const configuredTimeout = Number(process.env.EMBEDDING_REQUEST_TIMEOUT_MS || 30_000);
  const vectorField = getVectorField(targetIndex);
  let vectorizedCount = 0;
  let reusedVectorCount = 0;

  async function processBatch(offset) {
    assertWithinDeadline(deadline);
    assertNotAborted(signal);
    const ids = documentIds.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const documents = await client.mget(
      { index: targetIndex, docs: ids.map((_id) => ({ _id, _source: { includes: ['*', vectorField] } })) },
      { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal },
    );
    const config = embeddingConfig || DEFAULT_EMBEDDING_CONFIG;
    const geo = normalizeGeoConfig(config.geo, targetIndex);
    const found = documents.docs.filter((document) => document.found);
    const previousById = new Map(found.map((document) => [document._id, document._source || {}]));
    if (reuseSourceIndex && reuseSourceIndex !== targetIndex) {
      const previousDocuments = await client.mget(
        { index: reuseSourceIndex, docs: ids.map((_id) => ({ _id, _source: { includes: [vectorField, 'embedding_version', 'embedding_hash', 'embedding_text', 'embedding_source', 'embedding_geo_fingerprint', 'embedding_context_hash'] } })) },
        { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal },
      );
      for (const document of previousDocuments.docs.filter((document) => document.found)) previousById.set(document._id, document._source || {});
    }
    const validVector = (previous) => Array.isArray(previous?.[vectorField]) && previous[vectorField].length === 384 && previous[vectorField].every((value) => typeof value === 'number' && Number.isFinite(value)) && previous[vectorField].some((value) => value !== 0);
    const metadata = geoReader ? await geoReader.read(found.map((document) => document._id)) : new Map();
    const targets = found.map((document) => {
      const source = document._source || {};
      const previous = previousById.get(document._id);
      const row = metadata.get(document._id);
      const fingerprint = createGeoFingerprint(row);
      const contextHash = createEmbeddingContextHash(document._id, source, config, geo);
      const cached = !force && geo.enabled && previous?.embedding_version === EMBEDDING_MODEL_VERSION && validVector(previous)
        && previous.embedding_geo_fingerprint === fingerprint && previous.embedding_context_hash === contextHash
        && previous.embedding_source === (row ? 'geo' : 'keywords')
        && typeof previous.embedding_text === 'string' && Boolean(previous.embedding_text.trim())
        && createEmbeddingHash(previous.embedding_text, EMBEDDING_MODEL_VERSION) === previous.embedding_hash;
      return { id: document._id, source, previous, row, fingerprint, contextHash, cached };
    });
    const bodyIds = targets.filter((document) => document.row && !document.cached).map((document) => document.id);
    const bodies = geoReader ? await geoReader.read(bodyIds, true) : new Map();
    for (const document of targets) {
      if (document.cached) {
        document.hash = document.previous.embedding_hash;
        document.text = document.previous.embedding_text;
        document.provenance = { embedding_source: document.previous.embedding_source, embedding_geo_fingerprint: document.fingerprint, embedding_context_hash: document.contextHash };
        continue;
      }
      const body = bodies.get(document.id);
      document.text = body ? createGeoEmbeddingText(body.GEO_CONTENT, document.id, document.source, geo) : createEmbeddingText(document.source, config);
      document.hash = document.text ? createEmbeddingHash(document.text, EMBEDDING_MODEL_VERSION) : '';
      document.provenance = isGoodsGeoIndex(targetIndex) ? { embedding_source: body ? 'geo' : 'keywords', embedding_geo_fingerprint: createGeoFingerprint(body), embedding_context_hash: document.contextHash } : {};
    }
    const emptyIds = targets.filter((document) => !document.cached && !document.text).map((document) => document.id);
    if (emptyIds.length) {
      const emptyBulk = await client.bulk({ operations: emptyIds.flatMap((id) => [
        { update: { _index: targetIndex, _id: id } },
        { script: { lang: 'painless', source: "ctx._source.remove(params.vector_field); ctx._source.remove('embedding_version'); ctx._source.remove('embedding_hash'); ctx._source.remove('embedding_text'); ctx._source.remove('embedding_source'); ctx._source.remove('embedding_geo_fingerprint'); ctx._source.remove('embedding_context_hash');", params: { vector_field: vectorField } } },
      ]) }, { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal });
      if (emptyBulk.errors) throw Object.assign(new Error('빈 문장 메타데이터 제거 실패'), { code: 'ERR_ES_VECTOR_BULK' });
    }
    const reusableTargets = targets.filter((document) => !force && (document.cached || document.text) && validVector(document.previous)
      && document.previous.embedding_version === EMBEDDING_MODEL_VERSION && document.previous.embedding_hash === document.hash
      && (changedOnly || reuseSourceIndex));
    const writableReusableTargets = reusableTargets.filter((document) => (reuseSourceIndex && reuseSourceIndex !== targetIndex) || document.previous.embedding_text !== document.text || Object.entries(document.provenance).some(([key, value]) => document.previous[key] !== value));
    if (writableReusableTargets.length) {
      const reusableBulk = await client.bulk({ operations: writableReusableTargets.flatMap((document) => [
        { update: { _index: targetIndex, _id: document.id } },
        { doc: { ...(reuseSourceIndex && reuseSourceIndex !== targetIndex ? { [vectorField]: document.previous[vectorField], embedding_version: EMBEDDING_MODEL_VERSION, embedding_hash: document.hash } : {}), embedding_text: document.text, ...document.provenance } },
      ]) }, { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal });
      if (reusableBulk.errors) throw Object.assign(new Error('기존 벡터 재사용 저장에 실패했습니다.'), { code: 'ERR_ES_VECTOR_REUSE_BULK' });
    }
    reusedVectorCount += reusableTargets.length;
    const reusableIds = new Set(reusableTargets.map((document) => document.id));
    const nonEmptyTargets = targets.filter((document) => document.text && !reusableIds.has(document.id));
    if (nonEmptyTargets.length === 0) {
      await onProgress?.(vectorizedCount + reusedVectorCount, documentIds.length, vectorizedCount, reusedVectorCount);
      return;
    }

    // ES 조회 단위와 무관하게 TEI 서버 제한에 맞춰 실제 임베딩 요청은 32건씩 나눈다.
    for (let requestOffset = 0; requestOffset < nonEmptyTargets.length; requestOffset += EMBEDDING_REQUEST_BATCH_SIZE) {
      assertWithinDeadline(deadline);
      assertNotAborted(signal);
      const requestTargets = nonEmptyTargets.slice(requestOffset, requestOffset + EMBEDDING_REQUEST_BATCH_SIZE);
      const response = await fetch(`${embeddingNode}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: requestTargets.map((document) => `passage: ${document.text}`),
          normalize: true,
        }),
        signal: requestSignal(signal, Math.min(remainingMs(deadline), configuredTimeout)),
      }).catch((cause) => {
        const code = cause?.cause?.code || cause?.code || cause?.name || 'UNKNOWN';
        const endpoint = new URL(embeddingNode);
        const error = new Error(`임베딩 연결 실패 (${code}): ${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/embed`, { cause });
        error.code = 'ERR_EMBEDDING_CONNECTION';
        throw error;
      });
      if (!response.ok) {
      const responseBody = requestTargets.some((document) => document.provenance.embedding_source === 'geo') ? '' : (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
        const error = new Error(`임베딩 요청에 실패했습니다. (HTTP ${response.status}${responseBody ? `: ${responseBody}` : ''})`);
        error.code = 'ERR_EMBEDDING_REQUEST';
        throw error;
      }
      const vectors = await response.json();
      if (!Array.isArray(vectors) || vectors.length !== requestTargets.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== 384 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
        const error = new Error('임베딩 응답 건수가 요청 건수와 일치하지 않습니다.');
        error.code = 'ERR_EMBEDDING_RESPONSE';
        throw error;
      }

      assertNotAborted(signal);
      const operations = requestTargets.flatMap((document, index) => [
        { update: { _index: targetIndex, _id: document.id } },
        { doc: { [vectorField]: vectors[index], embedding_version: EMBEDDING_MODEL_VERSION, embedding_hash: document.hash, embedding_text: document.text, ...document.provenance } },
      ]);
      const bulk = await client.bulk(
        { operations, refresh: false },
        { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal },
      );
      if (bulk.errors) {
        const failed = (bulk.items || []).find((item) => item.update?.error || item.index?.error);
        const error = new Error(`벡터 Elasticsearch Bulk 업데이트에 실패했습니다: ${failed?.update?.error?.reason || failed?.index?.error?.reason || '원인 미상'}`);
        error.code = 'ERR_ES_VECTOR_BULK';
        throw error;
      }
      vectorizedCount += requestTargets.length;
      await onProgress?.(vectorizedCount + reusedVectorCount, documentIds.length, vectorizedCount, reusedVectorCount);
    }
  }

  let nextOffset = 0;
  async function runWorker() {
    while (true) {
      const offset = nextOffset;
      nextOffset += EMBEDDING_BATCH_SIZE;
      if (offset >= documentIds.length) return;
      await processBatch(offset);
    }
  }
  let firstError;
  const workers = Array.from({ length: EMBEDDING_CONCURRENCY }, () => runWorker().catch((error) => {
    if (!firstError) firstError = error;
    geoReader?.abort(firstError);
    batchController.abort();
    throw error;
  }));
  await Promise.allSettled(workers);
  if (firstError) throw firstError;

  return { vectorizedCount, reusedVectorCount };
}

async function resolveTargetIndex(client, indexName) {
  try {
    const aliases = await client.indices.getAlias({ name: indexName });
    const entries = Object.entries(aliases);
    const writeIndices = entries.filter(([, value]) => value.aliases?.[indexName]?.is_write_index === true);
    if (writeIndices.length === 1) return writeIndices[0][0];
    if (entries.length === 1) return entries[0][0];
    throw new Error(`별칭 ${indexName}의 단일 쓰기 인덱스를 확인할 수 없습니다.`);
  } catch (error) {
    const status = error?.statusCode ?? error?.meta?.statusCode;
    if (status !== 404) throw error;
  }

  if (await client.indices.exists({ index: indexName })) return indexName;
  throw new Error(`임베딩 대상 인덱스를 찾을 수 없습니다: ${indexName}`);
}

export async function runEmbeddingIndexing({ targetIndex, mode = 'changed', config, esClient, timeoutMs, signal }) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const index = await resolveTargetIndex(esClient, targetIndex);
  const embeddingConfig = config?.embedding || DEFAULT_EMBEDDING_CONFIG;
  if (embeddingConfig.enabled === false) return { exitCode: 0, resultCount: 0, targetIndices: [index], timedOut: false, errorDescription: '' };
  let pitId;
  let searchAfter;
  let resultCount = 0;
  let geoReader;
  try {
    await ensureEmbeddingTextMapping(esClient, index, deadline, signal);
    const geo = normalizeGeoConfig(embeddingConfig.geo, config?.indexName || targetIndex);
    if (geo.enabled) geoReader = createGeoReader({ query: geo.query, deadline, signal });
    assertNotAborted(signal);
    const pit = await esClient.openPointInTime({ index, keep_alive: '5m' });
    pitId = pit.id;
    while (true) {
      assertWithinDeadline(deadline);
      assertNotAborted(signal);
      const response = await esClient.search({ size: 100, _source: false, pit: { id: pitId, keep_alive: '5m' }, sort: ['_shard_doc'], ...(searchAfter ? { search_after: searchAfter } : {}), query: { match_all: {} } }, { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal });
      if (!response.hits.hits.length) break;
      searchAfter = response.hits.hits.at(-1)?.sort;
      const ids = response.hits.hits.map((hit) => hit._id);
      const batchResult = await vectorizeDocuments(esClient, index, ids, deadline, embeddingConfig, mode === 'changed', signal, undefined, undefined, geoReader, mode === 'all');
      resultCount += batchResult.vectorizedCount;
    }
    assertNotAborted(signal);
    await esClient.indices.refresh({ index }, { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal });
    return { exitCode: 0, resultCount, targetIndices: [index], timedOut: false, errorDescription: '' };
  } catch (error) {
    const timedOut = error?.code === 'ERR_INDEXING_TIMEOUT' || remainingMs(deadline) <= 0;
    return { exitCode: 1, resultCount, targetIndices: [index], timedOut, errorCode: signal?.aborted ? 'ERR_INDEXING_CANCELLED_BY_USER' : (error?.code || 'ERR_EMBEDDING_FAILED'), errorDescription: error instanceof Error ? error.message : '임베딩 처리 중 오류가 발생했습니다.' };
  } finally {
    if (geoReader) await geoReader.close().catch(() => {});
    if (pitId) await esClient.closePointInTime({ id: pitId }).catch(() => {});
  }
}

export async function runDirectIndexing({
  environment,
  operation,
  jobId,
  timeoutMs,
  esClient,
  config,
  signal,
  onPhase,
  claimId,
}) {
  const phaseStart = new Date();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const baseIndexName = config?.indexName || getGoodsIndex(environment);
  const documentIdColumn = (config?.documentIdColumn || 'goods_id').toLowerCase();
  let targetIndex =
    operation === 'full'
      ? `${baseIndexName}-${formatKstApplyDate(phaseStart)}`
      : baseIndexName;
  let reuseSourceIndex = null;
  if (operation === 'full') {
    try {
      reuseSourceIndex = await resolveTargetIndex(esClient, baseIndexName);
    } catch (error) {
      const status = error?.statusCode ?? error?.meta?.statusCode;
      if (status !== 404 && !String(error?.message || '').startsWith('임베딩 대상 인덱스를 찾을 수 없습니다:')) throw error;
    }
  }
  if (!['full', 'add', 'delete'].includes(operation)) {
    throw new Error(`지원하지 않는 직접 색인 작업입니다: ${operation}`);
  }
  if (operation !== 'full') targetIndex = await resolveTargetIndex(esClient, baseIndexName);

  let connection;
  let geoReader;
  let resultSet;
  let resultCount = 0;
  const timings = {
    dbConnectDurationMs: 0,
    dbExecuteDurationMs: 0,
    dbFetchDurationMs: 0,
    esBulkDurationMs: 0,
    embeddingDurationMs: 0,
  };
  const phaseTimestamps = { dbStartedAt: phaseStart.toISOString() };
  let embeddingStartedMs = 0;
  try {
    const configuredSql =
      operation === 'full'
        ? config?.fullQuery
        : operation === 'add'
          ? config?.addQuery
          : config?.deleteQuery;
    if (!configuredSql?.trim()) {
      const error = new Error(`${operation} 색인 SQL 설정이 필요합니다.`);
      error.code = 'ERR_INDEXING_SQL_CONFIG';
      throw error;
    }
    const sql = configuredSql;
    assertWithinDeadline(deadline);
    assertNotAborted(signal);
    await onPhase?.('db', { dbStartedAt: phaseStart.toISOString() });
    const connectStartedAt = Date.now();
    try {
      connection = openDemoDatabase();
    } catch (cause) {
      const error = new Error('SQLite DB 연결에 실패했습니다.', { cause });
      error.code = 'ERR_DB_CONNECT';
      throw error;
    } finally {
      timings.dbConnectDurationMs += Date.now() - connectStartedAt;
    }

    const binds = {};
    if (/\:claim_id\b/i.test(sql)) binds.claim_id = claimId || jobId;

    if (operation === 'full') {
      try {
        const dictionaryStartedAt = Date.now();
        let words;
        try {
          words = config?.autoRegisterDictionary === false ? new Set() : await collectDictionaryWords(connection, sql, binds, () => {
            assertWithinDeadline(deadline);
            assertNotAborted(signal);
          });
        } finally { timings.dbExecuteDurationMs += Date.now() - dictionaryStartedAt; }
        const requestOptions = () => {
          assertWithinDeadline(deadline);
          assertNotAborted(signal);
          return { signal, requestTimeout: Math.min(remainingMs(deadline), 60_000) };
        };
        const added = await registerDictionaryWords(esClient, baseIndexName, words, requestOptions);
        // 사전 갱신 직후 새 인덱스를 생성해 이번 전체색인부터 분석기에 적용한다.
        await esClient.indices.create({ index: targetIndex, mappings: { properties: {
          embedding_text: { type: 'text', index: false },
          ...(isProtectedGoodsAlias(baseIndexName) ? { exhibition_themes: EXHIBITION_THEMES_MAPPING } : {}),
        } } }, requestOptions());
        console.log(`[INDEXING-DICTIONARY] ${baseIndexName}: 후보 ${words.size}개, 신규 등록 ${added}개`);
      } catch (cause) {
        const error = new Error(`사용자 사전 자동등록 실패: ${getIndexingErrorMessage(cause, '원인 미상')}`, { cause });
        error.code = cause?.code || 'ERR_INDEXING_DICTIONARY';
        throw error;
      }
    }

    const executeStartedAt = Date.now();
    try {
      assertWithinDeadline(deadline);
      assertNotAborted(signal);
      resultSet = connection.prepare(sql).iterate(binds);
    } catch (cause) {
      if (signal?.aborted) {
        const error = new Error('사용자 요청으로 SQLite 색인 쿼리를 중지했습니다.', { cause });
        error.code = 'ERR_INDEXING_CANCELLED_BY_USER';
        throw error;
      }
      if (remainingMs(deadline) <= 0) {
        const error = new Error('색인 작업의 최대 실행 시간을 초과했습니다.', { cause });
        error.code = 'ERR_INDEXING_TIMEOUT';
        throw error;
      }
      const error = new Error(
        getIndexingErrorMessage(cause, 'SQLite 색인 쿼리 실행에 실패했습니다.'),
        { cause },
      );
      error.code = 'ERR_DB_QUERY';
      throw error;
    } finally {
      timings.dbExecuteDurationMs += Date.now() - executeStartedAt;
    }

    const indexedDocumentIds = new Set();
    while (true) {
      assertWithinDeadline(deadline);
      assertNotAborted(signal);
      const fetchStartedAt = Date.now();
      const rows = [];
      while (rows.length < FETCH_SIZE) {
        const next = resultSet.next();
        if (next.done) break;
        rows.push(next.value);
      }
      timings.dbFetchDurationMs += Date.now() - fetchStartedAt;
      if (rows.length === 0) break;
      const bulkStartedAt = Date.now();
      resultCount += await sendBulk(
        esClient,
        operation,
        targetIndex,
        documentIdColumn,
        rows,
        deadline,
        signal,
      );
      timings.esBulkDurationMs += Date.now() - bulkStartedAt;
      if (operation !== 'delete') {
        for (const rawRow of rows) {
          const documentId = normalizeRow(rawRow)[documentIdColumn];
          if (documentId !== undefined && documentId !== null && documentId !== '') {
            indexedDocumentIds.add(String(documentId));
          }
        }
      }
    }

    resultSet.return?.();
    resultSet = null;
    connection.close();
    connection = null;

    if (operation === 'full' && resultCount === 0 && isProtectedGoodsAlias(config?.indexName || getGoodsIndex(environment))) {
      throw new Error('상품 전체색인 DB 조회가 0건이므로 별칭을 전환할 수 없습니다.');
    }

    // DB 상품 색인이 끝난 후 이번 작업에서 저장한 문서만 벡터화한다.
    const dbFinishedAt = new Date().toISOString();
    phaseTimestamps.dbFinishedAt = dbFinishedAt;
    const dbDurationMs = timings.dbConnectDurationMs + timings.dbExecuteDurationMs + timings.dbFetchDurationMs;
    const embeddingStartedAt = new Date().toISOString();
    phaseTimestamps.embeddingStartedAt = embeddingStartedAt;
    await onPhase?.('embedding', {
      dbFinishedAt,
      dbDurationMs,
      ...timings,
      embeddingStartedAt,
      resultCount,
    });
    embeddingStartedMs = Date.now();
    let lastEmbeddingProgressAt = 0;
    let embeddingProgressQueue = Promise.resolve();
    if (operation === 'add' && config?.embedding?.enabled !== false) await ensureEmbeddingTextMapping(esClient, targetIndex, deadline, signal);
    const geo = normalizeGeoConfig(config?.embedding?.geo, baseIndexName);
    if (operation !== 'delete' && config?.embedding?.enabled !== false && geo.enabled) {
      geoReader = createGeoReader({ query: geo.query, deadline, signal });
    }
    const embeddingResult = operation === 'delete' || config?.embedding?.enabled === false
      ? { vectorizedCount: 0, reusedVectorCount: 0 }
      : await vectorizeDocuments(
          esClient,
          targetIndex,
          [...indexedDocumentIds],
          deadline,
          config?.embedding,
          operation === 'add',
          signal,
          async (completed, total, generated, reused) => {
            if (Date.now() - lastEmbeddingProgressAt < 10_000 && completed < total) return;
            lastEmbeddingProgressAt = Date.now();
            embeddingProgressQueue = embeddingProgressQueue.then(() => onPhase?.('embedding', {
                embeddingProcessedCount: completed,
                vectorizedCount: generated,
                generatedVectorCount: generated,
                reusedVectorCount: reused,
                embeddingTargetCount: total,
                embeddingDurationMs: Date.now() - embeddingStartedMs,
              }));
            await embeddingProgressQueue;
          },
          reuseSourceIndex,
          geoReader,
        );
    const { vectorizedCount, reusedVectorCount } = embeddingResult;
    timings.embeddingDurationMs = Date.now() - embeddingStartedMs;
    const embeddingFinishedAt = new Date().toISOString();
    phaseTimestamps.embeddingFinishedAt = embeddingFinishedAt;

    assertNotAborted(signal);
    if (operation === 'full') {
      assertWithinDeadline(deadline);
      const refreshed = await esClient.indices.refresh({ index: targetIndex }, { requestTimeout: Math.min(remainingMs(deadline), 60_000), signal });
      if ((refreshed._shards?.failed || 0) > 0) throw new Error('전체색인 최종 refresh에 실패했습니다.');
    }
    return {
      exitCode: 0,
      resultCount,
      vectorizedCount,
      reusedVectorCount,
      embeddingProcessedCount: vectorizedCount + reusedVectorCount,
      embeddingTargetCount: indexedDocumentIds.size,
      timings: { ...timings, dbDurationMs },
      phaseTimestamps,
      targetIndices: [targetIndex],
      timedOut: false,
      errorDescription: '',
    };
  } catch (error) {
    if (embeddingStartedMs > 0 && timings.embeddingDurationMs === 0) {
      timings.embeddingDurationMs = Date.now() - embeddingStartedMs;
    }
    if (signal?.aborted && error?.code !== 'ERR_INDEXING_CANCELLED_BY_USER') {
      error = Object.assign(new Error('사용자 요청으로 색인 작업을 중지했습니다.'), {
        code: 'ERR_INDEXING_CANCELLED_BY_USER',
      });
    }
    const timedOut =
      error?.code === 'ERR_INDEXING_TIMEOUT' || remainingMs(deadline) <= 0;
    return {
      exitCode: 1,
      resultCount,
      timings: {
        ...timings,
        dbDurationMs: timings.dbConnectDurationMs + timings.dbExecuteDurationMs + timings.dbFetchDurationMs,
      },
      phaseTimestamps,
      targetIndices: [targetIndex],
      timedOut,
      errorCode: timedOut ? 'ERR_INDEXING_TIMEOUT' : error?.code || 'ERR_INDEXING_FAILED',
      errorDescription: error instanceof Error ? error.message : '직접 색인 중 알 수 없는 오류가 발생했습니다.',
    };
  } finally {
    if (geoReader) await geoReader.close().catch(() => {});
    if (resultSet) resultSet.return?.();
    if (connection) connection.close();
  }
}
