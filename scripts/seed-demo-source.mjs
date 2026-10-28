import { existsSync, readFileSync } from 'node:fs';
import { demoDatabasePath, openDemoDatabase } from './demo-source.mjs';

export function demoProducts() {
  const catalog = JSON.parse(readFileSync(new URL('../fixtures/products.json', import.meta.url), 'utf8'));
  return catalog.products.map((product, index) => {
    const brand = catalog.brands.find((item) => item.id === product.brand);
    return {
      GOODS_ID: product.id, GOODS_NM: product.name, ONL_GOODS_NM: product.name,
      BND_NO: brand.id, BND_NM_KO: brand.name, BND_NM_EN: brand.english,
      DISP_CLSF_NO: product.categoryId, DISP_CLSF_NM: product.category,
      UP_DISP_CLSF_NO: '100', UP_DISP_CLSF_NM: '여성의류',
      SALE_AMT: product.price, NORMAL_AMT: product.price + 20000, COLORS: product.color,
      SEASON: product.season, PRODUCT_TYPE: product.category, RECOMMENDED_GENDER: '여성',
      SELLING_POINT_TXT: product.description, IMG_PATH: '/demo/product.svg',
      GOODS_REG_DTM: '2026-01-01T00:00:00Z', HITS: 100 + index * 37,
      DAY_AMT: product.price * (index % 7 + 1), DAY_ORD_CNT: index % 7 + 1,
      WEEK_AMT: product.price * (index % 13 + 5), WEEK_ORD_CNT: index % 13 + 5,
      MONTH_AMT: product.price * (index % 19 + 20), MONTH_ORD_CNT: index % 19 + 20,
      EXHIBITION_THEMES: JSON.stringify([{ exhbt_no: '1', thm_no: index % 2 ? '2' : '1', disp_prior_rank: index + 1, fix_disp_prior_rank: index + 1, main_disp_prior_rank: index + 1 }]),
      ACTIVE: 1,
    };
  });
}

export function seedDemoSource() {
  if (existsSync(demoDatabasePath())) return;
  const database = openDemoDatabase({ readOnly: false });
  try {
    database.exec('PRAGMA journal_mode = WAL');
    const products = demoProducts();
    const columns = Object.entries(products[0]).map(([key, value]) => `${key} ${typeof value === 'number' ? 'INTEGER' : 'TEXT'}${key === 'GOODS_ID' ? ' PRIMARY KEY' : ''}`);
    database.exec(`CREATE TABLE DEMO_PRODUCTS (${columns.join(', ')})`);
    database.exec(`CREATE TABLE DEMO_SYNC_QUEUE (
      QUEUE_ID INTEGER PRIMARY KEY, GOODS_ID TEXT NOT NULL UNIQUE,
      UPDATE_STATE TEXT NOT NULL DEFAULT 'WAIT', CLAIM_ID TEXT, CLAIMED_AT INTEGER,
      RETRY_COUNT INTEGER NOT NULL DEFAULT 0, LAST_ERROR TEXT
    )`);
    database.exec(`CREATE TABLE DEMO_PRODUCT_DESCRIPTIONS (
      GOODS_ID TEXT PRIMARY KEY, GEO_VERSION INTEGER, GEO_RECV_DTM TEXT,
      GEO_CONTENT TEXT, DEL_YN TEXT NOT NULL DEFAULT 'N'
    )`);
    database.exec(`CREATE TABLE DEMO_CONTENTS (
      CONTENTS_ID TEXT PRIMARY KEY, TITLE TEXT, SUB_TITLE TEXT, KWD TEXT,
      BDG_TEXT TEXT, CATEGORY TEXT, LINK_URL TEXT, IMG_PATH TEXT
    )`);
    database.exec('BEGIN');
    const insert = database.prepare(`INSERT INTO DEMO_PRODUCTS VALUES (${Object.keys(products[0]).map(() => '?').join(', ')})`);
    const description = database.prepare('INSERT INTO DEMO_PRODUCT_DESCRIPTIONS VALUES (?, 1, ?, ?, ?)');
    for (const product of products) {
      insert.run(...Object.values(product));
      description.run(product.GOODS_ID, '2026-01-01 00:00:00', JSON.stringify({ sku: product.GOODS_ID, jsonld: { '@graph': [{ '@type': 'Product', sku: product.GOODS_ID, additionalProperty: [
        { name: '스타일 무드', value: product.SELLING_POINT_TXT },
        { name: '계절', value: product.SEASON },
      ] }] } }), 'N');
    }
    const content = database.prepare('INSERT INTO DEMO_CONTENTS VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [index, title] of ['출근룩 재킷 스타일 가이드', '여름 원피스와 휴가룩', '겨울 니트와 코트 고르기'].entries()) {
      content.run(`ARTICLE${index + 1}`, title, '가상 스타일 가이드', title, '가상 상품으로 구성한 데모 콘텐츠', '스타일', '/demo/product.svg', '/demo/product.svg');
    }
    database.exec('COMMIT');
  } finally { database.close(); }
}

export function queueDemoChanges() {
  const database = openDemoDatabase({ readOnly: false });
  try {
    database.exec('BEGIN IMMEDIATE');
    if (database.prepare("SELECT 1 FROM DEMO_SYNC_QUEUE WHERE UPDATE_STATE = 'RUNNING'").get()) throw new Error('실행 중인 추가색인이 끝난 뒤 변경 예제를 생성하세요.');
    database.prepare('UPDATE DEMO_PRODUCTS SET SALE_AMT = 88000 WHERE GOODS_ID = ?').run('DEMO0001');
    database.prepare('UPDATE DEMO_PRODUCTS SET ACTIVE = 0 WHERE GOODS_ID = ?').run('DEMO0002');
    const enqueue = database.prepare(`INSERT INTO DEMO_SYNC_QUEUE (GOODS_ID) VALUES (?)
      ON CONFLICT(GOODS_ID) DO UPDATE SET UPDATE_STATE = 'WAIT', CLAIM_ID = NULL,
        CLAIMED_AT = NULL, RETRY_COUNT = 0, LAST_ERROR = NULL`);
    enqueue.run('DEMO0001');
    enqueue.run('DEMO0002');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}
