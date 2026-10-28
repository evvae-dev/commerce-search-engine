import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  INDEXING_JOBS_INDEX,
  INDEXING_LOCK_ID,
  INDEXING_PRD_INCREMENTAL_ENABLED,
  INDEXING_PRD_MANUAL_ENABLED,
} from '../constant/api.constant';
import { isGoodsIndexFamily } from '../constant/goods-index.constant.mjs';
import { elasticClient } from './elastic-client';

const STALE_LOCK_TIMEOUT_MS = (() => {
  const parsed = Number(
    process.env.INDEXING_LOCK_STALE_TIMEOUT_MS ||
      process.env.INDEXING_LOCK_TIMEOUT_MS ||
      15 * 60 * 1000,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
})();

export type IndexingEnvironment = 'dev' | 'prd';
export type IndexingOperation = 'full' | 'add' | 'delete' | 'sync' | 'embedding';
export type IndexingManualOperation = 'full' | 'add' | 'delete' | 'sync' | 'embedding';
export type IndexingTrigger = 'manual' | 'auto';
export type IndexingJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface IndexingJobDoc {
  docType: 'job';
  id: string;
  configId?: string;
  configName?: string;
  indexName?: string;
  environment: IndexingEnvironment;
  operation: IndexingOperation;
  trigger: IndexingTrigger;
  status: IndexingJobStatus;
  requester: string;
  scheduledFor?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
  cancelRequestedBy?: string;
  cancelAcknowledgedAt?: string;
  cancelledAt?: string;
  currentPhase?: 'add' | 'delete' | string;
  dbStartedAt?: string;
  dbFinishedAt?: string;
  embeddingStartedAt?: string;
  embeddingFinishedAt?: string;
  dbConnectDurationMs?: number;
  dbExecuteDurationMs?: number;
  dbFetchDurationMs?: number;
  dbDurationMs?: number;
  esBulkDurationMs?: number;
  embeddingDurationMs?: number;
  aliasDurationMs?: number;
  vectorizedCount?: number;
  generatedVectorCount?: number;
  reusedVectorCount?: number;
  embeddingProcessedCount?: number;
  embeddingTargetCount?: number;
  resultCount?: number;
  addResultCount?: number;
  deleteResultCount?: number;
  addDbConnectDurationMs?: number;
  addDbExecuteDurationMs?: number;
  addDbFetchDurationMs?: number;
  addDbDurationMs?: number;
  addEsBulkDurationMs?: number;
  addEmbeddingDurationMs?: number;
  addEmbeddingProcessedCount?: number;
  addEmbeddingTargetCount?: number;
  addReusedVectorCount?: number;
  addGeneratedVectorCount?: number;
  deleteDbConnectDurationMs?: number;
  deleteDbExecuteDurationMs?: number;
  deleteDbFetchDurationMs?: number;
  deleteDbDurationMs?: number;
  deleteEsBulkDurationMs?: number;
  targetIndices?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export interface IndexingLockDoc {
  docType: 'lock';
  jobId: string;
  environment: IndexingEnvironment;
  operation: IndexingOperation;
  trigger: IndexingTrigger;
  requester: string;
  lockedAt: string;
  heartbeatAt: string;
}

export interface IndexInfo {
  name: string;
  aliases: string[];
  docsCount: number;
  docsDeleted: number;
  storeSize: string;
  status: string;
}

interface OperationCapability {
  enabled: boolean;
  reason?: string;
}

export interface EnvironmentSummary {
  environment: IndexingEnvironment;
  indexCount: number;
  totalDocs: number;
  totalDeleted: number;
  totalSizeBytes: number;
  totalSizeFormatted: string;
  indices: IndexInfo[];
  latestSuccessJob: IndexingJobDoc | null;
  capabilities: Record<IndexingManualOperation, OperationCapability>;
}

export interface AdminDashboardGetResponse {
  success: boolean;
  environments: Record<IndexingEnvironment, EnvironmentSummary>;
  currentLock: IndexingLockDoc | null;
  currentJob: IndexingJobDoc | null;
  recentJobs: IndexingJobDoc[];
  searchStats?: {
    hourly: Array<{ hour: string; count: number }>;
    topQueries: Array<{ query: string; count: number; previousCount: number; changeRate: number | null }>;
    risingQueries: Array<{ query: string; count: number; baseline: number; ratio: number | null; delta: number }>;
    error?: string;
  };
}

function getErrorStatus(error: unknown): number | undefined {
  const typed = error as {
    statusCode?: number;
    meta?: { statusCode?: number };
  };
  return typed?.statusCode ?? typed?.meta?.statusCode;
}

function normalizeJob(job: IndexingJobDoc): IndexingJobDoc {
  return {
    ...job,
    environment: job.environment || 'dev',
    trigger: job.trigger || 'manual',
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(unit)),
    sizes.length - 1,
  );
  return (bytes / Math.pow(unit, index)).toFixed(1) + ' ' + sizes[index];
}

export function getEnvironmentCapabilities(
  environment: IndexingEnvironment,
): Record<IndexingManualOperation, OperationCapability> {
  if (environment === 'dev') {
    return {
      full: { enabled: true },
      add: { enabled: true },
      delete: { enabled: true },
      sync: { enabled: true },
      embedding: { enabled: true },
    };
  }

  const manualReason =
    '운영 수동 색인이 비활성화되어 있습니다 (INDEXING_PRD_MANUAL_ENABLED=false)';
  const incrementalReason =
    '운영 증분 색인이 비활성화되어 있습니다 (INDEXING_PRD_INCREMENTAL_ENABLED=false)';
  return {
    full: INDEXING_PRD_MANUAL_ENABLED
      ? { enabled: true }
      : { enabled: false, reason: manualReason },
    add:
      INDEXING_PRD_MANUAL_ENABLED && INDEXING_PRD_INCREMENTAL_ENABLED
        ? { enabled: true }
        : {
            enabled: false,
            reason: INDEXING_PRD_MANUAL_ENABLED
              ? incrementalReason
              : manualReason,
          },
    delete:
      INDEXING_PRD_MANUAL_ENABLED && INDEXING_PRD_INCREMENTAL_ENABLED
        ? { enabled: true }
        : {
            enabled: false,
            reason: INDEXING_PRD_MANUAL_ENABLED
              ? incrementalReason
              : manualReason,
          },
    sync:
      INDEXING_PRD_MANUAL_ENABLED && INDEXING_PRD_INCREMENTAL_ENABLED
        ? { enabled: true }
        : {
            enabled: false,
            reason: INDEXING_PRD_MANUAL_ENABLED
              ? incrementalReason
              : manualReason,
          },
    embedding: INDEXING_PRD_MANUAL_ENABLED
      ? { enabled: true }
      : { enabled: false, reason: manualReason },
  };
}

export async function ensureIndexingIndexExists(): Promise<void> {
  const properties = {
    docType: { type: 'keyword' as const },
    id: { type: 'keyword' as const },
    configId: { type: 'keyword' as const },
    configName: { type: 'keyword' as const },
    indexName: { type: 'keyword' as const },
    jobId: { type: 'keyword' as const },
    environment: { type: 'keyword' as const },
    operation: { type: 'keyword' as const },
    trigger: { type: 'keyword' as const },
    status: { type: 'keyword' as const },
    requester: { type: 'keyword' as const },
    scheduledFor: { type: 'date' as const },
    createdAt: { type: 'date' as const },
    startedAt: { type: 'date' as const },
    finishedAt: { type: 'date' as const },
    heartbeatAt: { type: 'date' as const },
    cancelRequestedAt: { type: 'date' as const },
    cancelRequestedBy: { type: 'keyword' as const },
    cancelAcknowledgedAt: { type: 'date' as const },
    cancelledAt: { type: 'date' as const },
    lockedAt: { type: 'date' as const },
    currentPhase: { type: 'keyword' as const },
    dbStartedAt: { type: 'date' as const },
    dbFinishedAt: { type: 'date' as const },
    embeddingStartedAt: { type: 'date' as const },
    embeddingFinishedAt: { type: 'date' as const },
    dbConnectDurationMs: { type: 'long' as const },
    dbExecuteDurationMs: { type: 'long' as const },
    dbFetchDurationMs: { type: 'long' as const },
    dbDurationMs: { type: 'long' as const },
    esBulkDurationMs: { type: 'long' as const },
    embeddingDurationMs: { type: 'long' as const },
    aliasDurationMs: { type: 'long' as const },
    vectorizedCount: { type: 'long' as const },
    generatedVectorCount: { type: 'long' as const },
    reusedVectorCount: { type: 'long' as const },
    embeddingProcessedCount: { type: 'long' as const },
    embeddingTargetCount: { type: 'long' as const },
    resultCount: { type: 'long' as const },
    addResultCount: { type: 'long' as const },
    deleteResultCount: { type: 'long' as const },
    addDbConnectDurationMs: { type: 'long' as const },
    addDbExecuteDurationMs: { type: 'long' as const },
    addDbFetchDurationMs: { type: 'long' as const },
    addDbDurationMs: { type: 'long' as const },
    addEsBulkDurationMs: { type: 'long' as const },
    addEmbeddingDurationMs: { type: 'long' as const },
    addEmbeddingProcessedCount: { type: 'long' as const },
    addEmbeddingTargetCount: { type: 'long' as const },
    addReusedVectorCount: { type: 'long' as const },
    addGeneratedVectorCount: { type: 'long' as const },
    deleteDbConnectDurationMs: { type: 'long' as const },
    deleteDbExecuteDurationMs: { type: 'long' as const },
    deleteDbFetchDurationMs: { type: 'long' as const },
    deleteDbDurationMs: { type: 'long' as const },
    deleteEsBulkDurationMs: { type: 'long' as const },
    targetIndices: { type: 'keyword' as const },
    errorCode: { type: 'keyword' as const },
    errorMessage: { type: 'text' as const },
  };

  const exists = await elasticClient.indices.exists({
    index: INDEXING_JOBS_INDEX,
  });
  if (!exists) {
    try {
      await elasticClient.indices.create({
        index: INDEXING_JOBS_INDEX,
        mappings: { properties },
      });
      return;
    } catch (error: unknown) {
      const type = (
        error as {
          meta?: { body?: { error?: { type?: string } } };
        }
      )?.meta?.body?.error?.type;
      if (type !== 'resource_already_exists_exception') {
        throw error;
      }
    }
  }

  await elasticClient.indices.putMapping({
    index: INDEXING_JOBS_INDEX,
    properties,
  });
}

export async function acquireLock(
  jobId: string,
  environment: IndexingEnvironment,
  operation: IndexingOperation,
  trigger: IndexingTrigger,
  requester: string,
): Promise<{ acquired: boolean; currentLock?: IndexingLockDoc }> {
  await ensureIndexingIndexExists();
  const now = new Date().toISOString();

  try {
    await elasticClient.create({
      index: INDEXING_JOBS_INDEX,
      id: INDEXING_LOCK_ID,
      document: {
        docType: 'lock',
        jobId,
        environment,
        operation,
        trigger,
        requester,
        lockedAt: now,
        heartbeatAt: now,
      },
    });
    return { acquired: true };
  } catch (error: unknown) {
    if (getErrorStatus(error) !== 409) {
      throw error;
    }
    const existing = await elasticClient
      .get<IndexingLockDoc>({
        index: INDEXING_JOBS_INDEX,
        id: INDEXING_LOCK_ID,
      })
      .catch((getError: unknown) => {
        if (getErrorStatus(getError) === 404) return null;
        throw getError;
      });

    if (existing?.found && existing._source) {
      const lockDoc = existing._source;
      const rawTime = lockDoc.heartbeatAt || lockDoc.lockedAt;
      const lastHeartbeat = rawTime ? new Date(rawTime).getTime() : 0;
      const isStale =
        Number.isFinite(lastHeartbeat) &&
        Date.now() - lastHeartbeat > STALE_LOCK_TIMEOUT_MS;

      if (
        isStale &&
        typeof existing._seq_no === 'number' &&
        typeof existing._primary_term === 'number'
      ) {
        try {
          await elasticClient.index({
            index: INDEXING_JOBS_INDEX,
            id: INDEXING_LOCK_ID,
            if_seq_no: existing._seq_no,
            if_primary_term: existing._primary_term,
            document: {
              docType: 'lock',
              jobId,
              environment,
              operation,
              trigger,
              requester,
              lockedAt: now,
              heartbeatAt: now,
            },
          });
          return { acquired: true };
        } catch (reclaimError: unknown) {
          if (
            getErrorStatus(reclaimError) !== 409 &&
            getErrorStatus(reclaimError) !== 404
          ) {
            throw reclaimError;
          }
          const latest = await elasticClient
            .get<IndexingLockDoc>({
              index: INDEXING_JOBS_INDEX,
              id: INDEXING_LOCK_ID,
            })
            .catch((latestError: unknown) => {
              if (getErrorStatus(latestError) === 404) return null;
              throw latestError;
            });
          return {
            acquired: false,
            currentLock: latest?._source
              ? {
                  ...latest._source,
                  environment: latest._source.environment || 'dev',
                  trigger: latest._source.trigger || 'manual',
                }
              : undefined,
          };
        }
      }
    }

    return {
      acquired: false,
      currentLock: existing?._source
        ? {
            ...existing._source,
            environment: existing._source.environment || 'dev',
            trigger: existing._source.trigger || 'manual',
          }
        : undefined,
    };
  }
}

export async function createJobDoc(
  jobId: string,
  environment: IndexingEnvironment,
  operation: IndexingOperation,
  trigger: IndexingTrigger,
  requester: string,
  status: IndexingJobStatus = 'queued',
  config?: { id: string; displayName: string; indexName: string },
): Promise<void> {
  await ensureIndexingIndexExists();
  const now = new Date().toISOString();
  await elasticClient.create({
    index: INDEXING_JOBS_INDEX,
    id: jobId,
    refresh: 'wait_for',
    document: {
      docType: 'job',
      id: jobId,
      ...(config
        ? { configId: config.id, configName: config.displayName, indexName: config.indexName }
        : {}),
      environment,
      operation,
      trigger,
      status,
      requester,
      createdAt: now,
      heartbeatAt: now,
    },
  });
}

export async function markJobFailed(
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await elasticClient.update({
    index: INDEXING_JOBS_INDEX,
    id: jobId,
    doc: {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorCode,
      errorMessage,
    },
  });
}

export type CancelJobResult =
  | { kind: 'requested'; job: IndexingJobDoc }
  | { kind: 'already-cancelled'; job: IndexingJobDoc }
  | { kind: 'terminal'; job: IndexingJobDoc }
  | { kind: 'not-found' };

/** 워커가 확인할 취소 요청만 기록한다. 락·슬롯은 워커가 소유권을 확인한 뒤 해제한다. */
export async function requestJobCancellation(
  jobId: string,
  requester: string,
): Promise<CancelJobResult> {
  await ensureIndexingIndexExists();
  let current;
  try {
    current = await elasticClient.get<IndexingJobDoc>({
      index: INDEXING_JOBS_INDEX,
      id: jobId,
    });
  } catch (error: unknown) {
    if (getErrorStatus(error) === 404) return { kind: 'not-found' };
    throw error;
  }
  if (!current.found || !current._source) return { kind: 'not-found' };
  const job = normalizeJob(current._source);
  if (job.status === 'cancelled') return { kind: 'already-cancelled', job };
  if (job.status !== 'queued' && job.status !== 'running') {
    return { kind: 'terminal', job };
  }

  const requestedAt = job.cancelRequestedAt || new Date().toISOString();
  try {
    await elasticClient.update({
      index: INDEXING_JOBS_INDEX,
      id: jobId,
      if_seq_no: current._seq_no,
      if_primary_term: current._primary_term,
      doc: {
        cancelRequestedAt: requestedAt,
        cancelRequestedBy: job.cancelRequestedBy || requester,
      },
    });
  } catch (error: unknown) {
    if (getErrorStatus(error) === 409) {
      return requestJobCancellation(jobId, requester);
    }
    throw error;
  }
  return {
    kind: 'requested',
    job: {
      ...job,
      cancelRequestedAt: requestedAt,
      cancelRequestedBy: job.cancelRequestedBy || requester,
    },
  };
}

export function spawnIndexingWorker(
  jobId: string,
  environment: IndexingEnvironment,
  operation: IndexingOperation,
  trigger: IndexingTrigger,
  configId?: string,
  embeddingMode?: 'all' | 'changed',
): Promise<void> {
  const workerScript = path.resolve(
    process.cwd(),
    'scripts',
    'indexing-worker.mjs',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        workerScript,
        '--job-id',
        jobId,
        '--environment',
        environment,
        '--operation',
        operation,
        '--trigger',
        trigger,
        ...(configId ? ['--config-id', configId] : []),
        ...(embeddingMode ? ['--embedding-mode', embeddingMode] : []),
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: false,
        windowsHide: true,
      },
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

function buildEnvironmentSummary(
  environment: IndexingEnvironment,
  indices: IndexInfo[],
  sizeByIndex: Map<string, number>,
  recentJobs: IndexingJobDoc[],
): EnvironmentSummary {
  const totalSizeBytes = indices.reduce(
    (total, index) => total + (sizeByIndex.get(index.name) ?? 0),
    0,
  );
  return {
    environment,
    indexCount: indices.length,
    totalDocs: indices.reduce((total, index) => total + index.docsCount, 0),
    totalDeleted: indices.reduce(
      (total, index) => total + index.docsDeleted,
      0,
    ),
    totalSizeBytes,
    totalSizeFormatted: formatBytes(totalSizeBytes),
    indices,
    latestSuccessJob:
      recentJobs.find(
        (job) =>
          job.environment === environment && job.status === 'succeeded',
      ) ?? null,
    capabilities: getEnvironmentCapabilities(environment),
  };
}

export async function getDashboardData(): Promise<AdminDashboardGetResponse> {
  await ensureIndexingIndexExists();

  const [catRows, aliasResponse, lockResponse, jobsResponse, latestFullJobsResponse, latestSyncJobsResponse] = await Promise.all([
    elasticClient.cat.indices({
      index: 'dev-*,prd-*',
      format: 'json',
      bytes: 'b',
    }),
    elasticClient.indices.getAlias({ index: 'dev-*,prd-*' }),
    elasticClient
      .get<IndexingLockDoc>({
        index: INDEXING_JOBS_INDEX,
        id: INDEXING_LOCK_ID,
      })
      .catch((error: unknown) => {
        if (getErrorStatus(error) === 404) return null;
        throw error;
      }),
    elasticClient.search<IndexingJobDoc>({
      index: INDEXING_JOBS_INDEX,
      query: { term: { docType: 'job' } },
      sort: [{ createdAt: { order: 'desc' } }],
      size: 100,
    }),
    elasticClient.search<IndexingJobDoc>({
      index: INDEXING_JOBS_INDEX,
      query: { bool: { filter: [
        { term: { docType: 'job' } },
        { term: { status: 'succeeded' } },
        { term: { operation: 'full' } },
      ] } },
      collapse: { field: 'configId' },
      sort: [{ finishedAt: { order: 'desc', missing: '_last' } }],
      size: 100,
    }),
    elasticClient.search<IndexingJobDoc>({
      index: INDEXING_JOBS_INDEX,
      query: { bool: { filter: [
        { term: { docType: 'job' } },
        { term: { status: 'succeeded' } },
        { term: { operation: 'sync' } },
      ] } },
      collapse: { field: 'configId' },
      sort: [{ finishedAt: { order: 'desc', missing: '_last' } }],
      size: 100,
    }),
  ]);

  const sizeByIndex = new Map<string, number>();
  const allIndices: IndexInfo[] = catRows.map((row) => {
    const name = row.index ?? '';
    const sizeBytes = Number(row['store.size'] ?? 0);
    sizeByIndex.set(name, Number.isFinite(sizeBytes) ? sizeBytes : 0);
    return {
      name,
      aliases: Object.keys(aliasResponse[name]?.aliases || {}),
      docsCount: Number(row['docs.count'] ?? 0),
      docsDeleted: Number(row['docs.deleted'] ?? 0),
      storeSize: formatBytes(sizeBytes),
      status: row.status ?? 'open',
    };
  });

  const recentJobs = [
    ...jobsResponse.hits.hits,
    ...latestFullJobsResponse.hits.hits,
    ...latestSyncJobsResponse.hits.hits,
  ]
    .map((hit) => hit._source)
    .filter((job): job is IndexingJobDoc => Boolean(job))
    .map(normalizeJob)
    .filter((job, index, all) => all.findIndex((candidate) => candidate.id === job.id) === index)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentLock =
    lockResponse?.found && lockResponse._source
      ? {
          ...lockResponse._source,
          environment: lockResponse._source.environment || 'dev',
          trigger: lockResponse._source.trigger || 'manual',
        }
      : null;
  const currentJob = currentLock
    ? recentJobs.find((job) => job.id === currentLock.jobId) ?? null
    : null;

  const devIndices = allIndices
    .filter((index) => isGoodsIndexFamily(index.name, 'dev'))
    .sort((left, right) => right.name.localeCompare(left.name));
  const prdIndices = allIndices
    .filter((index) => isGoodsIndexFamily(index.name, 'prd'))
    .sort((left, right) => right.name.localeCompare(left.name));

  return {
    success: true,
    environments: {
      dev: buildEnvironmentSummary(
        'dev',
        devIndices,
        sizeByIndex,
        recentJobs,
      ),
      prd: buildEnvironmentSummary(
        'prd',
        prdIndices,
        sizeByIndex,
        recentJobs,
      ),
    },
    currentLock,
    currentJob,
    recentJobs,
  };
}

export async function releaseLock(jobId: string): Promise<boolean> {
  try {
    const lock = await elasticClient.get<IndexingLockDoc>({
      index: INDEXING_JOBS_INDEX,
      id: INDEXING_LOCK_ID,
    });
    if (!lock.found || !lock._source || lock._source.jobId !== jobId) {
      return false;
    }
    await elasticClient.delete({
      index: INDEXING_JOBS_INDEX,
      id: INDEXING_LOCK_ID,
      if_seq_no: lock._seq_no,
      if_primary_term: lock._primary_term,
    });
    return true;
  } catch (error: unknown) {
    if (getErrorStatus(error) === 404) {
      return true;
    }
    console.error('Failed to release indexing lock:', error);
    return false;
  }
}
