/* eslint-disable @typescript-eslint/no-explicit-any -- Elasticsearch aggregation response is dynamically shaped. */

import { elasticClient } from './elastic-client';

const indexName = process.env.ELASTICSEARCH_STAT_INDEX || '.commerce-search-stat-v1';
const HOUR_MS = 60 * 60 * 1000;

export interface SearchStatSummary {
  hourly: Array<{ hour: string; count: number }>;
  topQueries: Array<{ query: string; count: number; previousCount: number; changeRate: number | null }>;
  risingQueries: Array<{ query: string; count: number; baseline: number; ratio: number | null; delta: number }>;
  error?: string;
}

let indexReady: Promise<void> | null = null;

function getErrorType(error: unknown): string | undefined {
  return (error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
}

function normalizeQueryText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

async function ensureSearchStatIndex(): Promise<void> {
  if (!indexReady) {
    indexReady = (async () => {
      try {
        await elasticClient.indices.create({ index: indexName, mappings: { properties: {
          timestamp: { type: 'date' }, queryText: { type: 'keyword' }, targetIndex: { type: 'keyword' },
          resultCount: { type: 'long' }, durationMs: { type: 'long' }, success: { type: 'boolean' },
        } } });
      } catch (error) {
        if (getErrorType(error) !== 'resource_already_exists_exception') throw error;
      }
    })().catch((error) => {
      indexReady = null;
      throw error;
    });
  }
  return indexReady;
}

export async function recordSearchEvent(event: { queryText: string; targetIndex?: string; resultCount: number; durationMs: number; success: boolean }): Promise<void> {
  const queryText = normalizeQueryText(event.queryText);
  if (!queryText) return;
  try {
    await ensureSearchStatIndex();
    await elasticClient.index({ index: indexName, document: { timestamp: new Date().toISOString(), ...event, queryText } });
  } catch (error) {
    // 검색 응답은 유지하되 운영에서 권한·연결 문제를 확인할 수 있도록 민감정보 없는 오류만 기록한다.
    console.error('search statistics event recording failed:', error instanceof Error ? error.message : 'unknown error');
  }
}

export async function getSearchStatSummary(now = new Date()): Promise<SearchStatSummary> {
  await ensureSearchStatIndex();
  const end = now.getTime(); const start = end - 24 * HOUR_MS; const previousStart = end - 8 * 24 * HOUR_MS;
  const hourlyStart = Math.floor(end / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const result = await elasticClient.search<{ queryText: string; timestamp: string }>({ index: indexName, size: 0, query: { range: { timestamp: { gte: new Date(previousStart).toISOString(), lte: now.toISOString() } } }, aggs: {
    hourly: { filter: { range: { timestamp: { gte: new Date(hourlyStart).toISOString() } } }, aggs: { slots: { date_histogram: { field: 'timestamp', fixed_interval: '1h', time_zone: 'Asia/Seoul', min_doc_count: 0, extended_bounds: { min: new Date(hourlyStart).toISOString(), max: now.toISOString() } } } } },
    current: { filter: { range: { timestamp: { gte: new Date(start).toISOString() } } }, aggs: { queries: { terms: { field: 'queryText', size: 10 } } } },
    previous: { filter: { range: { timestamp: { gte: new Date(previousStart).toISOString(), lt: new Date(previousStart + 24 * HOUR_MS).toISOString() } } }, aggs: { queries: { terms: { field: 'queryText', size: 1000 } } } },
    recent: { filter: { range: { timestamp: { gte: new Date(end - HOUR_MS).toISOString() } } }, aggs: { queries: { terms: { field: 'queryText', size: 100, min_doc_count: 2 } } } },
    baseline: { filter: { range: { timestamp: { gte: new Date(end - 25 * HOUR_MS).toISOString(), lt: new Date(end - HOUR_MS).toISOString() } } }, aggs: { queries: { terms: { field: 'queryText', size: 1000 } } } },
  } });
  const aggs = result.aggregations as any; const buckets = (name: string) => aggs?.[name]?.queries?.buckets || [];
  const previous = new Map<string, number>(buckets('previous').map((b: any) => [String(b.key), Number(b.doc_count)] as [string, number])); const baseline = new Map<string, number>(buckets('baseline').map((b: any) => [String(b.key), Number(b.doc_count) / 24] as [string, number]));
  const risingQueries = buckets('recent')
    .map((b: any) => { const avg = baseline.get(String(b.key)) || 0; return { query: String(b.key), count: Number(b.doc_count), baseline: avg, ratio: avg ? Number(b.doc_count) / avg : null, delta: Number(b.doc_count) - avg }; })
    .filter((item: { count: number; baseline: number; ratio: number | null; delta: number }) => item.count >= 2 && (item.baseline === 0 || ((item.ratio || 0) >= 1.5 && item.delta >= 1)))
    .sort((a: { count: number; ratio: number | null; delta: number }, b: { count: number; ratio: number | null; delta: number }) => ((b.ratio === null ? Number.POSITIVE_INFINITY : b.ratio) - (a.ratio === null ? Number.POSITIVE_INFINITY : a.ratio)) || b.delta - a.delta || b.count - a.count)
    .slice(0, 10);
  return { hourly: (aggs?.hourly?.slots?.buckets || []).slice(-24).map((b: any) => ({ hour: b.key_as_string, count: Number(b.doc_count) })), topQueries: buckets('current').map((b: any) => { const oldCount = previous.get(String(b.key)) || 0; return { query: String(b.key), count: Number(b.doc_count), previousCount: oldCount, changeRate: oldCount ? Number((((Number(b.doc_count) - oldCount) / oldCount) * 100).toFixed(1)) : null }; }), risingQueries };
}
