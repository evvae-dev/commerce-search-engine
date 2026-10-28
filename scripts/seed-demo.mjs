import { readFileSync } from 'node:fs';
import { Client } from '@elastic/elasticsearch';
import { DEMO_FULL_QUERY, DEMO_ADD_QUERY, DEMO_DELETE_QUERY, openDemoDatabase } from './demo-source.mjs';
import { seedDemoSource } from './seed-demo-source.mjs';
import { DEFAULT_GEO_QUERY } from './geo-embedding-config.mjs';
import { runDirectIndexing } from './direct-indexing.mjs';
import { switchIndexAlias } from './index-alias.mjs';
import { getVectorField } from '../constant/vector-field.constant.mjs';

const node = process.env.ELASTICSEARCH_NODE || 'http://127.0.0.1:19200';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(node).hostname)) {
  throw new Error('데모 초기화는 로컬 Elasticsearch에서만 실행할 수 있습니다.');
}
const client = new Client({ node, requestTimeout: 30000 });
try {
  const info = await client.info();
  if (info.cluster_name !== 'commerce-search-demo') throw new Error('commerce-search-demo 전용 클러스터가 아닙니다.');
  seedDemoSource();
  const textMapping = { type: 'text', analyzer: 'demo_nori', fields: { keyword: { type: 'keyword', normalizer: 'demo_uppercase' } } };
  const properties = Object.fromEntries([
    'goods_nm', 'onl_goods_nm', 'bnd_nm_ko', 'bnd_nm_en', 'disp_clsf_nm', 'up_disp_clsf_nm',
    'selling_point_txt', 'colors', 'season', 'product_type', 'recommended_gender',
    'title', 'sub_title', 'kwd', 'bdg_text', 'category',
  ].map((field) => [field, textMapping]));
  for (const field of ['goods_id', 'bnd_no', 'disp_clsf_no', 'up_disp_clsf_no', 'contents_id', 'img_path', 'link_url']) properties[field] = { type: 'keyword' };
  for (const field of ['sale_amt', 'normal_amt', 'hits', 'day_amt', 'day_ord_cnt', 'week_amt', 'week_ord_cnt', 'month_amt', 'month_ord_cnt', 'active']) properties[field] = { type: 'long' };
  properties.goods_reg_dtm = { type: 'date' };
  properties.embedding_text = { type: 'text', index: false };
  properties.exhibition_themes = { type: 'nested', properties: {
    exhbt_no: { type: 'keyword' }, thm_no: { type: 'keyword' },
    disp_prior_rank: { type: 'long' }, fix_disp_prior_rank: { type: 'long' }, main_disp_prior_rank: { type: 'long' },
  } };
  const configIndex = process.env.INDEXING_CONFIG_INDEX || '.commerce-indexing-config-v1';
  if (!await client.indices.exists({ index: configIndex })) {
    await client.indices.create({ index: configIndex, mappings: { properties: {
      docType: { type: 'keyword' }, id: { type: 'keyword' }, environment: { type: 'keyword' },
      indexName: { type: 'keyword' }, displayName: { type: 'keyword' },
      embedding: { type: 'object', enabled: false },
      fullQuery: { type: 'text', index: false }, addQuery: { type: 'text', index: false }, deleteQuery: { type: 'text', index: false },
      createdAt: { type: 'date' }, updatedAt: { type: 'date' },
    } } });
  }
  for (const environment of ['dev', 'prd']) for (const kind of ['goods', 'contents']) {
    const indexName = `${environment}-search-${kind}`;
    const id = `${environment}-${kind}`;
    const config = {
      docType: 'config', id, environment, displayName: `가상 ${kind === 'goods' ? '상품' : '콘텐츠'} (${environment})`, indexName,
      documentIdColumn: kind === 'goods' ? 'goods_id' : 'contents_id',
      fullQuery: kind === 'goods' ? DEMO_FULL_QUERY : 'SELECT * FROM DEMO_CONTENTS',
      fullSchedule: '0 3 * * *', fullEnabled: false, autoRegisterDictionary: true,
      ...(kind === 'goods' ? { addQuery: DEMO_ADD_QUERY, deleteQuery: DEMO_DELETE_QUERY, syncSchedule: '*/5 * * * *' } : {}),
      syncEnabled: false,
      embedding: { enabled: false, items: [{ label: '상품명', fields: [kind === 'goods' ? 'goods_nm' : 'title'] }, { label: '설명', fields: [kind === 'goods' ? 'selling_point_txt' : 'bdg_text'] }], geo: { enabled: false, query: DEFAULT_GEO_QUERY } },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    // 관리자에서 편집한 설정과 기존 인덱스는 재실행 시 유지한다.
    if (!await client.exists({ index: configIndex, id })) await client.create({ index: configIndex, id, document: config, refresh: 'wait_for' });
    if (await client.indices.existsAlias({ name: indexName })) continue;
    await client.indices.putIndexTemplate({ name: `demo-${id}`, index_patterns: [`${indexName}-*`], template: {
      settings: { number_of_shards: 1, number_of_replicas: 0, analysis: {
        normalizer: { demo_uppercase: { type: 'custom', filter: ['uppercase'] } },
        tokenizer: { demo_nori_tokenizer: { type: 'nori_tokenizer', decompound_mode: 'mixed', user_dictionary_rules: [] } },
        analyzer: { demo_nori: { type: 'custom', tokenizer: 'demo_nori_tokenizer', filter: ['uppercase'] } },
      } },
      mappings: { properties: { ...properties, [getVectorField(indexName)]: { type: 'dense_vector', dims: 384, similarity: 'cosine' } } },
    } });
    const result = await runDirectIndexing({ environment, operation: 'full', jobId: `seed-${id}`, config, esClient: client, timeoutMs: 120000 });
    if (result.exitCode !== 0) throw new Error(result.errorDescription);
    await switchIndexAlias(client, indexName, result.targetIndices[0]);
    console.log(`${indexName}: ${result.resultCount}건 색인 완료`);
  }
  const sortIndex = process.env.SORT_CONFIG_INDEX || '.commerce-sort-config-v1';
  if (!await client.indices.exists({ index: sortIndex })) await client.indices.create({ index: sortIndex, mappings: { properties: {
    docType: { type: 'keyword' }, id: { type: 'keyword' }, targetIndex: { type: 'keyword' }, sortName: { type: 'keyword' },
    sortOptions: { type: 'object', enabled: false }, referencedFields: { type: 'keyword' },
    createdAt: { type: 'date' }, updatedAt: { type: 'date' }, validatedAt: { type: 'date' },
  } } });
  for (const environment of ['dev', 'prd']) {
    const id = `demo-${environment}-day-order`;
    if (await client.exists({ index: sortIndex, id })) continue;
    const now = new Date().toISOString();
    await client.create({ index: sortIndex, id, document: {
      docType: 'sort-config', id, targetIndex: `${environment}-search-goods`, sortName: 'DAY_ORDER',
      description: '가상 일일 판매량순', sortOptions: [{ day_ord_cnt: { order: 'desc' } }, { hits: { order: 'desc' } }],
      referencedFields: ['day_ord_cnt', 'hits'], validatedAt: now,
      createdAt: now, createdBy: 'demo', updatedAt: now, updatedBy: 'demo',
    }, refresh: 'wait_for' });
  }
  const database = openDemoDatabase();
  try {
    const events = JSON.parse(readFileSync(new URL('../fixtures/events.json', import.meta.url), 'utf8'));
    for (const source of ['cart', 'recent', 'wish', 'order']) {
      const index = `demo-events-${source}`;
      if (!await client.indices.exists({ index })) await client.indices.create({ index, settings: { number_of_replicas: 0 }, mappings: { properties: {
        member_no: { type: 'keyword' }, goods_id: { type: 'keyword' }, bnd_no: { type: 'keyword' }, disp_clsf_no: { type: 'keyword' }, occurred_at: { type: 'date' },
      } } });
      for (const event of events.filter((entry) => entry.source === source)) {
        const product = database.prepare('SELECT * FROM DEMO_PRODUCTS WHERE GOODS_ID = ?').get(event.goodsId);
        await client.index({ index, id: `${event.memberNo}-${event.goodsId}`, document: {
          member_no: event.memberNo, goods_id: event.goodsId, bnd_no: product.BND_NO, disp_clsf_no: product.DISP_CLSF_NO, occurred_at: new Date().toISOString(),
        }, refresh: 'wait_for' });
      }
    }
  } finally { database.close(); }
  console.log('가상 회원 1001, 1002의 행동 예제가 준비되었습니다.');
} finally { await client.close(); }
