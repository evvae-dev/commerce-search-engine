import crypto from 'node:crypto';
import { GEO_DB_FIELDS, GEO_PROPERTY_FIELDS, normalizeGeoConfig } from './geo-embedding-config.mjs';

function flattenValues(value) {
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  if (value === null || value === undefined || typeof value === 'object') return [];
  const text = String(value).trim();
  return text ? [text] : [];
}

export function createEmbeddingText(source, config) {
  return config.items.map((item) => {
    const values = [...new Set(item.fields.flatMap((field) => flattenValues(source[field])))];
    return values.length ? `${item.label}: ${values.join(' ')}` : '';
  }).filter(Boolean).map((line) => `${line}.`).join(' ');
}

export function createEmbeddingHash(text, version) {
  return crypto.createHash('sha256').update(`${version}\n${text}`).digest('hex');
}

const GEO_RULE_VERSION = 'geo:v3';

function normalizeGeoValues(value) {
  return [...new Set(flattenValues(value).flatMap((text) => text.split(',').map((part) => part.trim()).filter(Boolean)))].join(', ');
}

function createGeoDbLines(source, selected) {
  return GEO_DB_FIELDS.filter((item) => selected.includes(item.id)).map((item) => {
    const value = item.fields.map((field) => normalizeGeoValues(source[field])).find(Boolean);
    return value ? `${item.label}: ${value}` : '';
  }).filter(Boolean);
}

export function createGeoFingerprint(row) {
  return createEmbeddingHash(JSON.stringify(row ? [String(row.GEO_VERSION), row.GEO_RECV_DTM ?? null] : ['none']), GEO_RULE_VERSION);
}

export function createEmbeddingContextHash(id, source, config, geo) {
  const normalized = normalizeGeoConfig(geo, 'dev-search-goods');
  return createEmbeddingHash(JSON.stringify([id, createEmbeddingText(source, config), createGeoDbLines(source, normalized.dbFields).join('\n'), normalized.enabled, normalized.query, normalized.dbFields, normalized.properties]), GEO_RULE_VERSION);
}

export function createGeoEmbeddingText(content, goodsId, source, geo) {
  const normalized = normalizeGeoConfig(geo, 'dev-search-goods');
  const fail = (kind) => { throw Object.assign(new Error(`GEO 임베딩 데이터 오류 (${kind}): 상품 ${goodsId}`), { code: 'ERR_GEO_EMBEDDING_PAYLOAD' }); };
  let data;
  try { data = JSON.parse(content); } catch { fail('JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('구조');
  const payload = data.payload || data;
  for (const sku of [data.sku, payload.sku]) {
    if (sku !== undefined && sku !== null && String(sku) !== String(goodsId)) fail('SKU');
  }
  const graph = payload.jsonld?.['@graph'];
  const products = (Array.isArray(graph) ? graph : []).filter((node) => node && (node['@type'] === 'Product' || (Array.isArray(node['@type']) && node['@type'].includes('Product'))));
  const product = products.find((node) => String(node.sku) === String(goodsId));
  if (products.length && !product) fail('SKU');
  const properties = Array.isArray(product?.additionalProperty) ? product.additionalProperty : [];
  const recognized = GEO_PROPERTY_FIELDS.map(({ id, label, name }) => {
    const value = normalizeGeoValues(properties.filter((property) => property?.name === name).map((property) => property.value));
    return { id, label, value };
  }).filter((item) => item.value);
  if (!recognized.length) fail('빈 본문');
  const dbSeason = normalized.dbFields.includes('season') && Boolean(normalizeGeoValues(source.season));
  const lines = recognized.filter((item) => normalized.properties.includes(item.id) && !(item.id === 'season' && dbSeason)).map((item) => `${item.label}: ${item.value}`);
  return [...createGeoDbLines(source, normalized.dbFields), ...lines].join('\n');
}

