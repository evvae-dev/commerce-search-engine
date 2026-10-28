export function getVectorField(indexName) {
  const logicalName = String(indexName || '')
    .replace(/-\d{12}$/, '')
    .replace(/^(dev|prd)-/, '')
    .replace(/^search-/, '');
  const normalized = logicalName
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) throw new Error(`벡터 필드명을 만들 수 없는 인덱스명입니다: ${indexName}`);
  return `${normalized}_vector`;
}
