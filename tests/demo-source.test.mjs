import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDemoDatabase, DEMO_FULL_QUERY, DEMO_ADD_QUERY, DEMO_DELETE_QUERY } from '../scripts/demo-source.mjs';
import { seedDemoSource, queueDemoChanges } from '../scripts/seed-demo-source.mjs';
import { claimSyncQueue, completeSyncQueue, failSyncQueue, runDirectIndexing } from '../scripts/direct-indexing.mjs';
import { createGeoReader } from '../scripts/geo-embedding.mjs';
import { DEFAULT_GEO_QUERY } from '../scripts/geo-embedding-config.mjs';
import { createGeoEmbeddingText } from '../scripts/embedding-text.mjs';

let directory;
const previousPath = process.env.DEMO_DB_PATH;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'commerce-demo-test-'));
  process.env.DEMO_DB_PATH = join(directory, 'catalog.sqlite');
  seedDemoSource();
});
afterEach(() => {
  if (previousPath === undefined) delete process.env.DEMO_DB_PATH;
  else process.env.DEMO_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

test('가상 상품 24개·콘텐츠 3개를 읽고 읽기 연결의 변경을 차단한다', () => {
  const database = openDemoDatabase();
  try {
    assert.equal(database.prepare(DEMO_FULL_QUERY).all().length, 24);
    assert.equal(database.prepare('SELECT * FROM DEMO_CONTENTS').all().length, 3);
    assert.throws(() => database.prepare('DELETE FROM DEMO_PRODUCTS').run(), /readonly/i);
  } finally { database.close(); }
});

test('큐 선점은 중복되지 않고 실패는 재시도 가능 상태로 돌아간다', async () => {
  queueDemoChanges();
  assert.equal(await claimSyncQueue('dev', 'job-1'), 2);
  assert.equal(await claimSyncQueue('dev', 'job-2'), 0);
  assert.equal(await failSyncQueue('dev', 'job-1', '일시적 오류'), 2);
  assert.equal(await claimSyncQueue('dev', 'job-2'), 2);
  assert.equal(await completeSyncQueue('dev', 'job-1'), 0);
  assert.equal(await completeSyncQueue('dev', 'job-2'), 2);
});

test('실패 횟수 한도를 넘은 큐는 다시 선점하지 않는다', async () => {
  queueDemoChanges();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await claimSyncQueue('dev', `job-${index}`), 2);
    assert.equal(await failSyncQueue('dev', `job-${index}`, '실패'), 2);
  }
  assert.equal(await claimSyncQueue('dev', 'job-last'), 0);
  const database = openDemoDatabase();
  try { assert.equal(database.prepare("SELECT COUNT(*) AS N FROM DEMO_SYNC_QUEUE WHERE UPDATE_STATE = 'FAILED'").get().N, 2); }
  finally { database.close(); }
});

test('GEO 조회는 가상 설명을 반환하고 실제 임베딩 문장을 조립한다', async () => {
  const reader = createGeoReader({ query: DEFAULT_GEO_QUERY, deadline: Date.now() + 5000 });
  try {
    const rows = await reader.read(['DEMO0001'], true);
    assert.equal(rows.size, 1);
    const text = createGeoEmbeddingText(rows.get('DEMO0001').GEO_CONTENT, 'DEMO0001', { goods_nm: '가상 재킷' }, { enabled: true, query: DEFAULT_GEO_QUERY });
    assert.match(text, /출근룩/);
    assert.match(text, /가상 재킷/);
  } finally { await reader.close(); }
});

function fakeElasticsearch() {
  const documents = new Map();
  let indexName;
  const missing = () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
  const template = { index_patterns: ['dev-search-goods-*'], template: { settings: { analysis: {
    tokenizer: { demo_nori: { type: 'nori_tokenizer', user_dictionary_rules: [] } },
    analyzer: { demo: { tokenizer: 'demo_nori' } },
  } }, mappings: { properties: { goods_nm: { type: 'text', analyzer: 'demo' } } } } };
  return {
    documents,
    indices: {
      getAlias: async () => indexName ? { [indexName]: { aliases: { 'dev-search-goods': { is_write_index: true } } } } : missing(),
      exists: async () => false,
      getIndexTemplate: async () => ({ index_templates: [{ name: 'demo', index_template: structuredClone(template) }] }),
      create: async ({ index }) => { indexName = index; },
      refresh: async () => ({ _shards: { failed: 0 } }),
    },
    transport: { request: async ({ method, body }) => {
      if (method === 'PUT') Object.assign(template, body);
      return {};
    } },
    bulk: async ({ operations }) => {
      const items = [];
      for (let index = 0; index < operations.length; index += 1) {
        const action = operations[index];
        if (action.delete) {
          documents.delete(action.delete._id);
          items.push({ delete: { status: 200 } });
        } else {
          const type = action.index ? 'index' : 'update';
          const id = action[type]._id;
          const value = operations[++index];
          documents.set(id, type === 'index' ? value : { ...documents.get(id), ...value.doc });
          items.push({ [type]: { status: 200 } });
        }
      }
      return { items };
    },
  };
}

test('실제 SQLite 원본을 Bulk 문서로 변환하고 변경·삭제를 반영한다', async () => {
  const client = fakeElasticsearch();
  const config = { indexName: 'dev-search-goods', documentIdColumn: 'goods_id', fullQuery: DEMO_FULL_QUERY,
    addQuery: DEMO_ADD_QUERY, deleteQuery: DEMO_DELETE_QUERY, embedding: { enabled: false } };
  const run = (operation, extra = {}) => runDirectIndexing({ environment: 'dev', operation, config, esClient: client, timeoutMs: 10000, jobId: 'job', ...extra });
  const full = await run('full');
  assert.equal(full.exitCode, 0, full.errorDescription);
  assert.equal(full.resultCount, 24);
  assert.equal(client.documents.get('DEMO0001').sale_amt, 89000);
  assert.ok(Array.isArray(client.documents.get('DEMO0001').exhibition_themes));
  queueDemoChanges();
  await claimSyncQueue('dev', 'job');
  const add = await run('add');
  assert.equal(add.exitCode, 0, add.errorDescription);
  assert.equal(add.resultCount, 1);
  const deleted = await run('delete');
  assert.equal(deleted.exitCode, 0, deleted.errorDescription);
  assert.equal(deleted.resultCount, 1);
  assert.equal(client.documents.get('DEMO0001').sale_amt, 88000);
  assert.equal(client.documents.has('DEMO0002'), false);
  assert.equal(client.documents.size, 23);
  assert.equal(await completeSyncQueue('dev', 'job'), 2);
});

test('취소된 작업은 SQLite 처리와 Bulk 기록을 시작하지 않는다', async () => {
  const client = fakeElasticsearch();
  const result = await runDirectIndexing({ environment: 'dev', operation: 'full', jobId: 'cancelled', timeoutMs: 1000,
    esClient: client, config: { fullQuery: DEMO_FULL_QUERY }, signal: AbortSignal.abort() });
  assert.equal(result.errorCode, 'ERR_INDEXING_CANCELLED_BY_USER');
  assert.equal(client.documents.size, 0);
});
