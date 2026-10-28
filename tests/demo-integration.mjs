import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openDemoDatabase } from '../scripts/demo-source.mjs';
import { queueDemoChanges } from '../scripts/seed-demo-source.mjs';

const base = 'http://127.0.0.1:3200';
const es = process.env.ELASTICSEARCH_NODE || 'http://127.0.0.1:19200';
assert.equal(new URL(es).hostname, '127.0.0.1');
assert.equal((await (await fetch(es)).json()).cluster_name, 'commerce-search-demo');
const cookies = new Map();
async function request(path, options = {}, status = 200) {
  const response = await fetch(`${base}${path}`, {
    ...options, redirect: 'manual', headers: {
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      ...options.headers,
    },
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const body = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}
const post = (body) => ({ method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await request('/api/v1/admin/index-configs', {}, 401);
const csrf = await request('/api/auth/csrf');
await request('/api/auth/callback/demo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
  csrfToken: csrf.csrfToken, password: process.env.DEMO_ADMIN_PASSWORD || '', callbackUrl: `${base}/admin/dashboard`, json: 'true',
}) });
assert.equal((await request('/api/auth/session')).user.email, 'demo@example.test');
assert.equal((await request('/api/v1/admin/index-configs')).configs.length, 4);
console.log('인증: 익명 관리자 접근 차단, 로컬 데모 로그인과 설정 조회 통과');

const search = await request(`/api/v1/search?q=${encodeURIComponent('재킷')}&size=10`);
assert.ok(search.total >= 4);
assert.ok(search.items.every((item) => item.goods_id.startsWith('DEMO')));
assert.ok(search.items.every((item) => item.img_path === '/demo/product.svg'));
const contents = await request(`/api/v1/contents/search?q=${encodeURIComponent('여름')}`);
assert.ok(contents.total >= 1);
const themes = await request('/api/v1/goods?exhbtNo=1&thmNo=1&page=1&size=10');
assert.ok(themes.result.length > 0);
const baseline = await request('/api/v1/admin/search-compare/legacy', post({ q: '재킷', environment: 'dev', size: 10, page: 1 }));
assert.ok(baseline.items.length >= 4);
console.log('검색: 상품·콘텐츠·기획전·기본 키워드 비교 통과');

const personalization = { enabled: true, sources: {
  cart: { days: 30, weight: 0.2 }, recent: { days: 30, weight: 0.1 }, wish: { days: 180, weight: 0.3 }, order: { days: 365, weight: 0.4 },
}, dimensions: { product: 0.6, brand: 0.25, category: 0.15 }, maxBoost: 0.3, cacheTtlMs: 600000 };
const simulation = await request('/api/v1/admin/search-ranking/simulate', post({ q: '재킷', targetIndex: 'dev-search-goods', testMemberNo: '1001', personalization }));
assert.notEqual(simulation.timings.personalizationCacheStatus, 'failed');
assert.ok(simulation.items.some((item) => item.scores.personalization?.boost > 0));
console.log('개인화: 가상 회원 행동 조회와 상품 점수 보정 통과');

async function runJob(operation) {
  const { jobId } = await request('/api/v1/admin/dashboard', post({ configId: 'dev-goods', operation }), 202);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`${es}/.commerce-indexing-jobs-v1/_doc/${jobId}`);
    const job = (await response.json())._source;
    if (!['running', 'queued'].includes(job.status)) {
      assert.equal(job.status, 'succeeded', JSON.stringify({ status: job.status, error: job.errorMessage }));
      return job;
    }
    await delay(500);
  }
  throw new Error('색인 워커가 제한 시간 내에 완료되지 않았습니다.');
}
queueDemoChanges();
try {
  const job = await runJob('sync');
  const mappings = await (await fetch(`${es}/.commerce-indexing-jobs-v1/_mapping`)).json();
  assert.equal(mappings['.commerce-indexing-jobs-v1'].mappings.properties.id.type, 'keyword');
  assert.equal(job.addResultCount, 1);
  assert.equal(job.deleteResultCount, 1);
  const product = await request('/api/v1/goods/DEMO0001');
  assert.equal(product.item.sale_amt, 88000);
  assert.equal((await fetch(`${es}/dev-search-goods/_doc/DEMO0002`)).status, 404);
  console.log('추가색인: 분리 워커의 가격 변경·판매 중지 삭제 통과');
} finally {
  const database = openDemoDatabase({ readOnly: false });
  try {
    database.prepare('UPDATE DEMO_PRODUCTS SET SALE_AMT = 89000 WHERE GOODS_ID = ?').run('DEMO0001');
    database.prepare('UPDATE DEMO_PRODUCTS SET ACTIVE = 1 WHERE GOODS_ID = ?').run('DEMO0002');
  } finally { database.close(); }
  const full = await runJob('full');
  assert.equal(full.resultCount, 24);
  assert.equal((await (await fetch(`${es}/dev-search-goods/_count`)).json()).count, 24);
  console.log('전체색인: 새 인덱스 생성·검증·별칭 전환과 원본 24건 복원 통과');
}
