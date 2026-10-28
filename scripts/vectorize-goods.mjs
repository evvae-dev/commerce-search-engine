import { Client } from '@elastic/elasticsearch';
import { getGoodsIndex } from '../constant/goods-index.constant.mjs';
import { createEmbeddingHash, createEmbeddingText } from './embedding-text.mjs';

const DEFAULT_LIMIT = 1000;
const DEFAULT_BATCH_SIZE = 32;
function getOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function getPositiveInteger(name, fallback) {
  const value = Number(getOption(name, fallback));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION || 'intfloat/multilingual-e5-small:v1';
const EMBEDDING_CONFIG = { enabled: true, items: [
  { label: '브랜드명', fields: ['bnd_nm_ko', 'bnd_nm_en'] }, { label: '상품명', fields: ['onl_goods_nm', 'goods_nm'] },
  { label: '카테고리', fields: ['up_disp_clsf_nm', 'disp_clsf_nm'] }, { label: '색상', fields: ['colors'] },
  { label: '상품유형', fields: ['product_type'] }, { label: '시즌', fields: ['season'] },
  { label: '성별', fields: ['recommended_gender'] }, { label: '특징', fields: ['selling_point_txt', 'selling_point'] },
] };

async function embed(texts, embeddingNode) {
  const response = await fetch(`${embeddingNode}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: texts.map((text) => `passage: ${text}`),
      normalize: true,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}.`);
  }
  return response.json();
}

const sourceIndex = getOption(
  '--source-index',
  process.env.ELASTICSEARCH_GOODS_INDEX ?? getGoodsIndex('dev'),
);
const targetIndex = getOption('--target-index', sourceIndex);
const batchSize = getPositiveInteger('--batch-size', DEFAULT_BATCH_SIZE);
const limit = process.argv.includes('--all')
  ? Number.POSITIVE_INFINITY
  : getPositiveInteger('--limit', DEFAULT_LIMIT);
const embeddingNode = process.env.EMBEDDING_NODE ?? 'http://127.0.0.1:18080';
const client = new Client({
  node: process.env.ELASTICSEARCH_NODE ?? 'http://127.0.0.1:19200',
  requestTimeout: 60000,
  ...(process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD ? {
    auth: { username: process.env.ELASTICSEARCH_USERNAME, password: process.env.ELASTICSEARCH_PASSWORD },
  } : {}),
});

let pitId;
let searchAfter;
let processed = 0;
let scanned = 0;

try {
  if (sourceIndex !== targetIndex) {
    const targetExists = await client.indices.exists({ index: targetIndex });
    if (!targetExists) await client.indices.create({ index: targetIndex, mappings: { properties: { embedding_text: { type: 'text', index: false } } } });
  }
  const mappings = await client.indices.getMapping({ index: targetIndex });
  if (!Object.values(mappings).some((entry) => entry.mappings?.properties?.embedding_text)) {
    await client.indices.putMapping({ index: targetIndex, properties: { embedding_text: { type: 'text', index: false } } });
  }

  const pit = await client.openPointInTime({
    index: sourceIndex,
    keep_alive: '5m',
  });
  pitId = pit.id;

  while (processed < limit) {
    const size =
      sourceIndex === targetIndex
        ? Math.min(batchSize, limit - processed)
        : batchSize;
    const result = await client.search({
      size,
      pit: { id: pitId, keep_alive: '5m' },
      sort: ['_shard_doc'],
      ...(searchAfter ? { search_after: searchAfter } : {}),
      _source: { excludes: ['goods_vector'] },
      query:
        sourceIndex === targetIndex
          ? { bool: { must_not: [{ exists: { field: 'goods_vector' } }] } }
          : { match_all: {} },
    });

    if (result.hits.hits.length === 0) break;

    searchAfter = result.hits.hits.at(-1)?.sort;
    scanned += result.hits.hits.length;

    let documents = result.hits.hits.map((hit) => ({
      id: hit._id,
      source: hit._source ?? {},
      embeddingText: createEmbeddingText(hit._source ?? {}, EMBEDDING_CONFIG),
    }));
    if (sourceIndex !== targetIndex) {
      const existing = await client.mget({
        index: targetIndex,
        ids: documents.map((document) => document.id),
        _source: false,
      });
      const existingIds = new Set(
        existing.docs
          .filter((document) => document.found)
          .map((document) => document._id),
      );
      documents = documents.filter(
        (document) => !existingIds.has(document.id),
      );
      documents = documents.slice(0, limit - processed);
    }
    if (documents.length === 0) continue;

    const vectors = await embed(
      documents.map((document) => document.embeddingText),
      embeddingNode,
    );
    const operations = documents.flatMap((document, index) => {
      const vectorFields = {
        goods_vector: vectors[index],
        embedding_version: EMBEDDING_MODEL_VERSION,
        embedding_hash: createEmbeddingHash(document.embeddingText, EMBEDDING_MODEL_VERSION),
        embedding_text: document.embeddingText,
        embedding_source: 'keywords',
        embedding_geo_fingerprint: null,
        embedding_context_hash: null,
      };
      delete document.source.geo_content;
      delete document.source.geo_payload;
      delete document.source.embedding_text;
      return sourceIndex === targetIndex
        ? [
            { update: { _index: targetIndex, _id: document.id } },
            { doc: vectorFields },
          ]
        : [
            { index: { _index: targetIndex, _id: document.id } },
            { ...document.source, ...vectorFields },
          ];
    });
    const bulk = await client.bulk({ operations });
    if (bulk.errors) throw new Error('Elasticsearch bulk request failed.');

    processed += documents.length;
    console.log(`scanned=${scanned} vectorized=${processed}`);
  }

  await client.indices.refresh({ index: targetIndex });
  console.log(
    JSON.stringify({
      sourceIndex,
      targetIndex,
      scanned,
      processed,
      dimensions: 384,
    }),
  );
} finally {
  if (pitId) await client.closePointInTime({ id: pitId });
  await client.close();
}
