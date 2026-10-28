/** @typedef {'dev' | 'prd'} GoodsIndexEnvironment */

/** @type {Readonly<Record<GoodsIndexEnvironment, string>>} */
export const GOODS_INDEX_BY_ENVIRONMENT = Object.freeze({
  dev: 'dev-search-goods',
  prd: 'prd-search-goods',
});

/** @type {Readonly<Record<GoodsIndexEnvironment, string>>} */
export const GOODS_INDEXING_CONFIG_ID_BY_ENVIRONMENT = Object.freeze({
  dev: 'dev-goods',
  prd: 'prd-goods',
});

export const GOODS_INDEX_NAMES = Object.freeze(
  Object.values(GOODS_INDEX_BY_ENVIRONMENT),
);

/** @param {GoodsIndexEnvironment} environment */
export function getGoodsIndex(environment) {
  return GOODS_INDEX_BY_ENVIRONMENT[environment];
}

/** @param {GoodsIndexEnvironment} environment */
export function getGoodsIndexingConfigId(environment) {
  return GOODS_INDEXING_CONFIG_ID_BY_ENVIRONMENT[environment];
}

/** @param {unknown} value */
export function isGoodsIndex(value) {
  return typeof value === 'string' && GOODS_INDEX_NAMES.includes(value);
}

/**
 * @param {string} indexName
 * @param {GoodsIndexEnvironment} environment
 */
export function isGoodsIndexFamily(indexName, environment) {
  const baseIndex = getGoodsIndex(environment);
  return indexName === baseIndex || indexName.startsWith(`${baseIndex}-`);
}

/** @param {string} indexName */
export function getLegacyGoodsIndex(indexName) {
  const environment = /** @type {GoodsIndexEnvironment | undefined} */ (
    Object.entries(GOODS_INDEX_BY_ENVIRONMENT).find(([, current]) => current === indexName)?.[0]
  );
  return environment ? getGoodsIndexingConfigId(environment) : null;
}
