import { openDemoDatabase } from './demo-source.mjs';
import { validateGeoQuery } from './geo-embedding-config.mjs';

export function createGeoSql(query, ids, includeContent = false) {
  const candidate = validateGeoQuery(query);
  return `SELECT GS.GOODS_ID, GS.GEO_VERSION,
       GS.GEO_RECV_DTM${includeContent ? ', GS.GEO_CONTENT' : ''}
  FROM DEMO_PRODUCT_DESCRIPTIONS GS
 WHERE GS.GEO_VERSION IS NOT NULL
   AND GS.GEO_CONTENT IS NOT NULL
   AND GS.DEL_YN = 'N'
   AND GS.GOODS_ID IN (${ids.map((_, index) => `:goods_id_${index}`).join(', ')})
   AND EXISTS (SELECT 1 FROM (
${candidate}
) CANDIDATE WHERE CANDIDATE.GOODS_ID = GS.GOODS_ID)`;
}

export function createGeoReader({ query, deadline, signal }) {
  let connection;
  let pending = Promise.resolve();
  let stoppedError;
  const check = () => {
    if (stoppedError) throw stoppedError;
    if (signal?.aborted) throw Object.assign(new Error('GEO 조회를 중지했습니다.'), { code: 'ERR_INDEXING_CANCELLED_BY_USER' });
    if (Date.now() >= deadline) throw Object.assign(new Error('GEO 조회 제한 시간을 초과했습니다.'), { code: 'ERR_INDEXING_TIMEOUT' });
  };
  async function read(ids, includeContent) {
    check();
    if (!ids.length) return new Map();
    connection ||= openDemoDatabase();
    check();
    const binds = Object.fromEntries(ids.map((id, index) => [`goods_id_${index}`, id]));
    let result;
    try {
      result = connection.prepare(createGeoSql(query, ids, includeContent)).all(binds);
    } catch {
      check();
      throw Object.assign(new Error('GEO SQL 조회에 실패했습니다. GOODS_ID 출력 계약과 SQL 설정을 확인해 주세요.'), { code: 'ERR_GEO_DB_QUERY' });
    }
    check();
    const allowed = new Set(ids.map(String));
    const rows = new Map();
    for (const row of result) {
      const id = String(row.GOODS_ID ?? '');
      if (!allowed.has(id) || row.GEO_VERSION === null || row.GEO_VERSION === undefined || (includeContent && row.GEO_CONTENT == null)) {
        throw Object.assign(new Error('GEO 조회 결과의 상품 ID 또는 필수 컬럼이 올바르지 않습니다.'), { code: 'ERR_GEO_DB_CONTRACT' });
      }
      rows.set(id, row);
    }
    return rows;
  }
  return {
    abort(reason) {
      if (stoppedError) return;
      stoppedError = reason || Object.assign(new Error('GEO 조회를 중지했습니다.'), { code: 'ERR_GEO_DB_QUERY' });
    },
    read(ids, includeContent = false) {
      const next = pending.then(() => read(ids, includeContent));
      pending = next.catch(() => {});
      return next;
    },
    async close() {
      await pending;
      if (connection) connection.close();
    },
  };
}
