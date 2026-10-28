export const DEFAULT_GEO_QUERY = "SELECT GOODS_ID\n  FROM DEMO_PRODUCT_DESCRIPTIONS\n WHERE GEO_VERSION IS NOT NULL\n   AND GEO_CONTENT IS NOT NULL\n   AND DEL_YN = 'N'";

export const GEO_DB_FIELDS = [
  { id: 'brand', label: '브랜드명', fields: ['bnd_nm_ko', 'bnd_nm_en'] },
  { id: 'name', label: '상품명', fields: ['goods_nm', 'onl_goods_nm'] },
  { id: 'category', label: '카테고리', fields: ['up_disp_clsf_nm', 'disp_clsf_nm'] },
  { id: 'colors', label: '색상', fields: ['colors'] },
  { id: 'product_type', label: '상품유형', fields: ['product_type'] },
  { id: 'season', label: '계절', fields: ['season'] },
];

export const GEO_PROPERTY_FIELDS = [
  { id: 'mood', label: '무드', name: '스타일 무드' },
  { id: 'tpo', label: '착용 상황', name: 'TPO(착용 상황)' },
  { id: 'look', label: '룩', name: '룩(착장 유형)' },
  { id: 'fit', label: '핏', name: '핏(신체 대비 여유량)' },
  { id: 'season', label: '계절', name: '계절' },
  { id: 'length', label: '기장', name: '기장' },
  { id: 'detail', label: '디테일', name: '디테일' },
  { id: 'coordination', label: '코디', name: '코디 제안' },
  { id: 'material', label: '소재', name: '소재' },
];

function normalizeSelectedFields(value, registry) {
  if (value === undefined) return registry.map((item) => item.id);
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !registry.some((item) => item.id === id))) {
    throw new Error('GEO 설정에 허용되지 않는 항목이 포함되어 있습니다.');
  }
  return registry.filter((item) => value.includes(item.id)).map((item) => item.id);
}

export function isGoodsGeoIndex(indexName = '') {
  return /^(dev|prd)-(search-)?goods(?:-\d{12})?$/.test(indexName);
}

// 문자열과 주석을 토큰에서 제외하되 wrapper 밖으로 탈출할 수 있는 입력은 거부한다.
export function validateGeoQuery(query) {
  const sql = typeof query === 'string' ? query.trim() : '';
  const fail = () => { throw new Error('GEO SQL 설정은 바인드 없는 균형 잡힌 SELECT 또는 WITH 문이어야 합니다.'); };
  if (!sql) fail();
  if (/\b(?:n?q)'/i.test(sql)) fail();
  let tokens = '';
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      let closed = false;
      for (i += 1; i < sql.length; i += 1) {
        if (sql[i] !== quote) continue;
        if (sql[i + 1] === quote) { i += 1; continue; }
        closed = true;
        break;
      }
      if (!closed) fail();
      tokens += ' ';
    } else if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      tokens += ' ';
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) fail();
      i = end + 1;
      tokens += ' ';
    } else {
      if (char === '(') depth += 1;
      if (char === ')' && --depth < 0) fail();
      if (char === ';' || char === ':') fail();
      tokens += char;
    }
  }
  if (depth !== 0 || !/^\s*(select|with)\b/i.test(tokens)) fail();
  const checked = tokens.replace(/\bon\s+overflow\s+truncate\b/gi, ' ');
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|begin|declare|call|execute|commit|rollback|into)\b/i.test(checked)) fail();
  return sql;
}

export function normalizeGeoConfig(value, indexName) {
  if (value !== undefined && (!value || typeof value.enabled !== 'boolean' || typeof value.query !== 'string')) {
    throw new Error('GEO 설정 형식이 올바르지 않습니다.');
  }
  return {
    enabled: isGoodsGeoIndex(indexName) && (value?.enabled ?? true),
    query: validateGeoQuery(value?.query ?? DEFAULT_GEO_QUERY),
    dbFields: normalizeSelectedFields(value?.dbFields, GEO_DB_FIELDS),
    properties: normalizeSelectedFields(value?.properties, GEO_PROPERTY_FIELDS),
  };
}
