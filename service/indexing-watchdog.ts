import { INDEXING_JOBS_INDEX } from '../constant/api.constant';
import { getGoodsIndexingConfigId } from '../constant/goods-index.constant.mjs';
import { elasticClient } from './elastic-client';
import type { IndexingJobDoc } from './indexing-job-service';

const WATCHDOG_INTERVAL_MS = Number(process.env.INDEXING_WATCHDOG_INTERVAL_MS || 30_000);
const HEARTBEAT_STALE_MS = Number(process.env.INDEXING_WATCHDOG_STALE_MS || 2 * 60 * 1000);

interface WatchdogRuntime {
  timer: NodeJS.Timeout | null;
  running: boolean;
}

const globalWatchdog = globalThis as typeof globalThis & {
  __commerceIndexingWatchdog?: WatchdogRuntime;
};

function getRuntime(): WatchdogRuntime {
  if (!globalWatchdog.__commerceIndexingWatchdog) {
    globalWatchdog.__commerceIndexingWatchdog = { timer: null, running: false };
  }
  return globalWatchdog.__commerceIndexingWatchdog;
}

function isWatchdogOwner(): boolean {
  const instanceId = process.env.NODE_APP_INSTANCE;
  return instanceId === undefined || instanceId === '0';
}

function getOwnedDocumentIds(job: IndexingJobDoc): string[] {
  const targetGroup = job.configId || getGoodsIndexingConfigId(job.environment);
  const operationIdentity = ['add', 'delete', 'sync'].includes(job.operation)
    ? 'sync'
    : job.operation;
  return [
    `lock:indexing:${job.environment}:${targetGroup}`,
    `slot:indexing:${job.environment}:${targetGroup}:${operationIdentity}`,
    'lock:indexing',
  ];
}

async function releaseOwnedDocuments(jobId: string, job: IndexingJobDoc): Promise<void> {
  for (const id of getOwnedDocumentIds(job)) {
    try {
      const current = await elasticClient.get({ index: INDEXING_JOBS_INDEX, id });
      const source = current._source as { jobId?: string } | undefined;
      if (source?.jobId !== jobId) continue;
      await elasticClient.delete({
        index: INDEXING_JOBS_INDEX,
        id,
        if_seq_no: current._seq_no,
        if_primary_term: current._primary_term,
      });
    } catch (error) {
      const status = (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode
        ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404 && status !== 409) throw error;
    }
  }
}

async function finalizeStaleJob(
  id: string,
  job: IndexingJobDoc,
  seqNo: number,
  primaryTerm: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const cancelled = Boolean(job.cancelRequestedAt);
  try {
    await elasticClient.update({
      index: INDEXING_JOBS_INDEX,
      id,
      if_seq_no: seqNo,
      if_primary_term: primaryTerm,
      doc: {
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: now,
        ...(cancelled ? { cancelledAt: now, cancelAcknowledgedAt: now } : {}),
        errorCode: cancelled ? 'ERR_INDEXING_CANCELLED_BY_USER' : 'ERR_INDEXING_WORKER_STALE',
        errorMessage: cancelled
          ? '워커 하트비트가 중단된 고아 작업을 중지 요청에 따라 종료했습니다.'
          : '색인 워커의 하트비트가 중단되어 고아 작업으로 종료했습니다.',
      },
    });
  } catch (error) {
    const status = (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode
      ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (status === 404 || status === 409) return false;
    throw error;
  }
  await releaseOwnedDocuments(id, job);
  console.warn(`[INDEXING-WATCHDOG] 고아 작업 종료 ${id} (${job.operation})`);
  return true;
}

export async function reconcileIndexingWatchdog(): Promise<number> {
  if (!isWatchdogOwner()) return 0;
  const runtime = getRuntime();
  if (runtime.running) return 0;
  runtime.running = true;
  try {
    let response;
    try {
      response = await elasticClient.search<IndexingJobDoc>({
        index: INDEXING_JOBS_INDEX,
        size: 200,
        seq_no_primary_term: true,
        query: {
          bool: {
            filter: [
              { term: { docType: 'job' } },
              { terms: { status: ['running', 'queued'] } },
            ],
          },
        },
      });
    } catch (error) {
      const status = (error as { statusCode?: number; meta?: { statusCode?: number } }).statusCode
        ?? (error as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status === 404) return 0;
      throw error;
    }
    let finalizedCount = 0;
    for (const hit of response.hits.hits) {
      const job = hit._source;
      if (!hit._id || !job || typeof hit._seq_no !== 'number' || typeof hit._primary_term !== 'number') continue;
      const heartbeatAt = job.heartbeatAt || job.startedAt || job.createdAt;
      const heartbeatTime = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
      if (!Number.isFinite(heartbeatTime) || Date.now() - heartbeatTime <= HEARTBEAT_STALE_MS) continue;
      if (await finalizeStaleJob(hit._id, job, hit._seq_no, hit._primary_term)) finalizedCount += 1;
    }
    return finalizedCount;
  } finally {
    runtime.running = false;
  }
}

export async function startIndexingWatchdog(): Promise<void> {
  if (!isWatchdogOwner()) return;
  const runtime = getRuntime();
  await reconcileIndexingWatchdog();
  if (runtime.timer) return;
  runtime.timer = setInterval(() => {
    void reconcileIndexingWatchdog().catch((error) => {
      console.error('[INDEXING-WATCHDOG] 감시 실패:', error instanceof Error ? error.message : error);
    });
  }, WATCHDOG_INTERVAL_MS);
  runtime.timer.unref();
}
