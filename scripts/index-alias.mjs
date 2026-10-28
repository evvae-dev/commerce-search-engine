export function isDatedIndexName(aliasName, indexName) {
  const escaped = aliasName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-\\d{12}$`).test(indexName);
}

export function isProtectedGoodsAlias(aliasName) {
  return /^(dev|prd)-(search-)?goods$/.test(aliasName);
}

function assertComplete(response, label) {
  if (response.timed_out || (response._shards?.failed || 0) > 0) throw new Error(`${label} 결과가 불완전하여 별칭을 유지합니다.`);
}

async function validateAliasTarget(client, aliasName, targetIndex, currentIndices) {
  const refresh = await client.indices.refresh({ index: targetIndex });
  assertComplete(refresh, '최종 refresh');
  const target = await client.count({ index: targetIndex });
  assertComplete(target, '신규 인덱스 count');
  if (!Number.isSafeInteger(target.count) || target.count < 0) throw new Error('신규 인덱스 문서 수를 확인할 수 없습니다.');
  if (isProtectedGoodsAlias(aliasName)) {
    if (target.count === 0) throw new Error('상품 인덱스가 0건이므로 별칭을 유지합니다.');
    if (currentIndices.length) {
      const previous = await client.count({ index: currentIndices });
      assertComplete(previous, '기존 인덱스 count');
      if (!Number.isSafeInteger(previous.count) || previous.count < 0) throw new Error('기존 인덱스 문서 수를 확인할 수 없습니다.');
      const configured = Number(process.env.INDEX_ALIAS_MIN_GOODS_COUNT_RATIO);
      const ratio = Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : 0.5;
      if (target.count < previous.count * ratio) throw new Error(`상품 문서 수가 기존 대비 ${Math.round(ratio * 100)}% 미만이므로 별칭을 유지합니다.`);
    }
  }
  const searchable = await client.search({ index: targetIndex, size: 1, _source: false, query: { match_all: {} }, allow_partial_search_results: false });
  assertComplete(searchable, '신규 인덱스 검색');
  if (!searchable.hits?.hits || (target.count > 0 && !searchable.hits.hits.length)) throw new Error('신규 인덱스의 검색 가능한 문서를 확인할 수 없습니다.');
}

export async function deleteOldDatedIndices(client, aliasName, currentIndex, keepCount = 3) {
  const response = await client.indices.get({ index: `${aliasName}-*` });
  const datedIndices = Object.keys(response)
    .filter(indexName => isDatedIndexName(aliasName, indexName));
  const previousIndices = datedIndices
    .filter(indexName => indexName !== currentIndex)
    .sort((left, right) => right.localeCompare(left));
  const keepIndices = new Set([currentIndex, ...previousIndices.slice(0, Math.max(0, keepCount - 1))]);
  const deletedIndices = datedIndices.filter(indexName => !keepIndices.has(indexName));
  if (deletedIndices.length) await client.indices.delete({ index: deletedIndices });
  return deletedIndices;
}

export async function switchIndexAlias(client, aliasName, targetIndex) {
  if (!isDatedIndexName(aliasName, targetIndex)) {
    throw new Error(`별칭 대상 인덱스명이 올바르지 않습니다: ${targetIndex}`);
  }
  if (!await client.indices.exists({ index: targetIndex })) {
    throw new Error(`별칭 대상 인덱스를 찾을 수 없습니다: ${targetIndex}`);
  }
  let currentIndices = [];
  try {
    currentIndices = Object.keys(await client.indices.getAlias({ name: aliasName }));
  } catch (error) {
    if ((error?.statusCode ?? error?.meta?.statusCode) !== 404) throw error;
  }
  if (currentIndices.length === 1 && currentIndices[0] === targetIndex) return;
  if (!currentIndices.length && await client.indices.exists({ index: aliasName })) {
    throw new Error(`${aliasName}이 별칭이 아닌 실제 인덱스로 존재하여 자동 전환할 수 없습니다.`);
  }
  await validateAliasTarget(client, aliasName, targetIndex, currentIndices);
  const updated = await client.indices.updateAliases({ actions: [
    ...currentIndices.map(index => ({ remove: { index, alias: aliasName, must_exist: true } })),
    { add: { index: targetIndex, alias: aliasName, is_write_index: true } },
  ] });
  if (updated.errors || updated.acknowledged === false) throw new Error('별칭 전환 성공을 확인할 수 없습니다.');
}
