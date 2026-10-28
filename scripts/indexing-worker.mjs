/**
 * DEV/PRD 자동·수동 색인을 같은 one-shot 실행 경로로 처리한다.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { deleteOldDatedIndices, switchIndexAlias } from './index-alias.mjs';
import { Client } from '@elastic/elasticsearch';
import { normalizeGeoConfig } from './geo-embedding-config.mjs';

import {
  getGoodsIndex,
  getGoodsIndexingConfigId,
} from '../constant/goods-index.constant.mjs';
import {
  claimSyncQueue,
  completeSyncQueue,
  failSyncQueue,
  runDirectIndexing,
  runEmbeddingIndexing,
} from './direct-indexing.mjs';

const args = process.argv.slice(2);
let jobId = '';
let environment = '';
let operation = '';
let trigger = 'manual';
let configId = '';
let embeddingMode = 'changed';

for (let index = 0; index < args.length; index += 1) {
  const value = args[index + 1];
  if (args[index] === '--job-id' && value) {
    jobId = value;
    index += 1;
  } else if (args[index] === '--environment' && value) {
    environment = value;
    index += 1;
  } else if (args[index] === '--operation' && value) {
    operation = value;
    index += 1;
  } else if (args[index] === '--trigger' && value) {
    trigger = value;
    index += 1;
  } else if (args[index] === '--config-id' && value) {
    configId = value;
    index += 1;
  } else if (args[index] === '--embedding-mode' && value) {
    embeddingMode = value;
    index += 1;
  }
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
if (
  !['dev', 'prd'].includes(environment) ||
  !['full', 'add', 'delete', 'sync', 'embedding'].includes(operation) ||
  (operation === 'embedding' && !['all', 'changed'].includes(embeddingMode)) ||
  !['manual', 'auto'].includes(trigger) ||
  (jobId && !UUID_PATTERN.test(jobId)) ||
  (trigger === 'manual' && !jobId)
) {
  console.error(
    'Invalid arguments: --environment dev|prd --operation full|add|delete|sync|embedding ' +
      '--trigger manual|auto [--job-id <uuid>]',
  );
  process.exit(2);
}
if (!jobId) {
  jobId = crypto.randomUUID();
}
const defaultConfigId = getGoodsIndexingConfigId(environment);
const defaultTargetIndex = getGoodsIndex(environment);
if (!configId) configId = defaultConfigId;
if (!/^[a-zA-Z0-9_-]{1,100}$/.test(configId)) {
  console.error('Invalid --config-id');
  process.exit(2);
}

const JOBS_INDEX =
  process.env.INDEXING_JOBS_INDEX || '.commerce-indexing-jobs-v1';
const CONFIG_INDEX =
  process.env.INDEXING_CONFIG_INDEX || '.commerce-indexing-config-v1';
const TARGET_GROUP = configId;
const OPERATION_IDENTITY = ['add', 'delete', 'sync'].includes(operation)
  ? 'sync'
  : operation;
const LOCK_ID = `lock:indexing:${environment}:${TARGET_GROUP}`;
const LEGACY_LOCK_ID = 'lock:indexing';
const SLOT_ID = `slot:indexing:${environment}:${TARGET_GROUP}:${OPERATION_IDENTITY}`;
const STALE_LOCK_TIMEOUT_MS = (() => {
  const parsed = Number(
    process.env.INDEXING_LOCK_STALE_TIMEOUT_MS ||
      process.env.INDEXING_LOCK_TIMEOUT_MS ||
      15 * 60 * 1000,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
})();
const FULL_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const INCREMENTAL_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const client = new Client({
  node: process.env.ELASTICSEARCH_NODE || 'http://127.0.0.1:19200',
  requestTimeout: Number(
    process.env.ELASTICSEARCH_REQUEST_TIMEOUT_MS || 5000,
  ),
  ...(process.env.ELASTICSEARCH_USERNAME &&
  process.env.ELASTICSEARCH_PASSWORD
    ? {
        auth: {
          username: process.env.ELASTICSEARCH_USERNAME,
          password: process.env.ELASTICSEARCH_PASSWORD,
        },
      }
    : {}),
});

const cancellationController = new AbortController();
let cancelMonitorTimer;
let cancelMonitorInFlight = false;
let jobUpdateQueue = Promise.resolve();

function updateJobDocument(request) {
  const queuedUpdate = jobUpdateQueue.then(() =>
    client.update({
      index: JOBS_INDEX,
      id: jobId,
      retry_on_conflict: 3,
      ...request,
    }),
  );
  jobUpdateQueue = queuedUpdate.catch(() => {});
  return queuedUpdate;
}

function isCancellationError(error) {
  return cancellationController.signal.aborted || error?.code === 'ERR_INDEXING_CANCELLED_BY_USER' || error?.errorCode === 'ERR_INDEXING_CANCELLED_BY_USER';
}

async function observeCancellation() {
  if (cancelMonitorInFlight || cancellationController.signal.aborted) return;
  cancelMonitorInFlight = true;
  try {
    const response = await client.get({ index: JOBS_INDEX, id: jobId });
    if (response?._source?.cancelRequestedAt) {
      cancellationController.abort(new Error('사용자가 색인 작업 중지를 요청했습니다.'));
    }
  } catch (error) {
    if (getErrorStatus(error) !== 404) console.error('Cancel monitor notice:', error?.message || error);
  } finally {
    cancelMonitorInFlight = false;
  }
}

function startCancelMonitor() {
  void observeCancellation();
  cancelMonitorTimer = setInterval(() => void observeCancellation(), 1000);
  cancelMonitorTimer.unref?.();
}

function stopCancelMonitor() {
  if (cancelMonitorTimer) clearInterval(cancelMonitorTimer);
}

process.once('SIGTERM', () => cancellationController.abort(new Error('프로세스 종료 신호로 색인 작업이 중지되었습니다.')));
process.once('SIGINT', () => cancellationController.abort(new Error('프로세스 종료 신호로 색인 작업이 중지되었습니다.')));

function getErrorStatus(error) {
  return error?.statusCode ?? error?.meta?.statusCode;
}

async function loadIndexingConfig() {
  try {
    const response = await client.get({ index: CONFIG_INDEX, id: configId });
    return response._source || null;
  } catch (error) {
    if (getErrorStatus(error) === 404 && configId === defaultConfigId) {
      return null;
    }
    throw error;
  }
}

async function ensureJobsIndex() {
  const properties = {
    docType: { type: 'keyword' },
    id: { type: 'keyword' },
    jobId: { type: 'keyword' },
    environment: { type: 'keyword' },
    operation: { type: 'keyword' },
    trigger: { type: 'keyword' },
    status: { type: 'keyword' },
    requester: { type: 'keyword' },
    createdAt: { type: 'date' },
    startedAt: { type: 'date' },
    finishedAt: { type: 'date' },
    heartbeatAt: { type: 'date' },
    lockedAt: { type: 'date' },
    currentPhase: { type: 'keyword' },
    dbStartedAt: { type: 'date' },
    dbFinishedAt: { type: 'date' },
    embeddingStartedAt: { type: 'date' },
    embeddingFinishedAt: { type: 'date' },
    dbConnectDurationMs: { type: 'long' },
    dbExecuteDurationMs: { type: 'long' },
    dbFetchDurationMs: { type: 'long' },
    dbDurationMs: { type: 'long' },
    esBulkDurationMs: { type: 'long' },
    embeddingDurationMs: { type: 'long' },
    aliasDurationMs: { type: 'long' },
    vectorizedCount: { type: 'long' },
    generatedVectorCount: { type: 'long' },
    reusedVectorCount: { type: 'long' },
    embeddingProcessedCount: { type: 'long' },
    embeddingTargetCount: { type: 'long' },
    addResultCount: { type: 'long' },
    deleteResultCount: { type: 'long' },
    addDbConnectDurationMs: { type: 'long' },
    addDbExecuteDurationMs: { type: 'long' },
    addDbFetchDurationMs: { type: 'long' },
    addDbDurationMs: { type: 'long' },
    addEsBulkDurationMs: { type: 'long' },
    addEmbeddingDurationMs: { type: 'long' },
    addEmbeddingProcessedCount: { type: 'long' },
    addEmbeddingTargetCount: { type: 'long' },
    addReusedVectorCount: { type: 'long' },
    addGeneratedVectorCount: { type: 'long' },
    deleteDbConnectDurationMs: { type: 'long' },
    deleteDbExecuteDurationMs: { type: 'long' },
    deleteDbFetchDurationMs: { type: 'long' },
    deleteDbDurationMs: { type: 'long' },
    deleteEsBulkDurationMs: { type: 'long' },
    resultCount: { type: 'long' },
    targetIndices: { type: 'keyword' },
    errorCode: { type: 'keyword' },
    errorMessage: { type: 'text' },
    cancelRequestedAt: { type: 'date' },
    cancelRequestedBy: { type: 'keyword' },
    cancelAcknowledgedAt: { type: 'date' },
    cancelledAt: { type: 'date' },
  };
  const exists = await client.indices.exists({ index: JOBS_INDEX });
  if (!exists) {
    try {
      await client.indices.create({
        index: JOBS_INDEX,
        mappings: { properties },
      });
      return;
    } catch (error) {
      const type = error?.meta?.body?.error?.type;
      if (type !== 'resource_already_exists_exception') {
        throw error;
      }
    }
  }
  await client.indices.putMapping({
    index: JOBS_INDEX,
    properties,
  });
}

async function createAutomaticJob() {
  const now = new Date().toISOString();
  const config = await loadIndexingConfig();
  await client.create({
    index: JOBS_INDEX,
    id: jobId,
    document: {
      docType: 'job',
      id: jobId,
      environment,
      operation,
      trigger: 'auto',
      status: 'queued',
      requester: 'system:cron',
      createdAt: now,
      heartbeatAt: now,
      configId,
      ...(config
        ? { configName: config.displayName, indexName: config.indexName }
        : {}),
    },
  });
}

// 동일 작업 슬롯은 중복 실행과 중복 대기를 원자적으로 차단한다.
async function reserveOperationSlot() {
  const now = new Date().toISOString();
  try {
    await client.create({
      index: JOBS_INDEX,
      id: SLOT_ID,
      document: {
        docType: 'slot',
        jobId,
        environment,
        operation: OPERATION_IDENTITY,
        trigger,
        createdAt: now,
        heartbeatAt: now,
      },
    });
    return true;
  } catch (error) {
    if (getErrorStatus(error) !== 409) throw error;

    // 비정상 종료로 남은 슬롯은 heartbeat 기준으로 소유권을 확인해 회수한다.
    const existing = await client.get({ index: JOBS_INDEX, id: SLOT_ID });
    const heartbeat = new Date(
      existing._source?.heartbeatAt || existing._source?.createdAt || 0,
    ).getTime();
    if (
      Number.isFinite(heartbeat) &&
      Date.now() - heartbeat > STALE_LOCK_TIMEOUT_MS
    ) {
      try {
        await client.delete({
          index: JOBS_INDEX,
          id: SLOT_ID,
          if_seq_no: existing._seq_no,
          if_primary_term: existing._primary_term,
        });
        return reserveOperationSlot();
      } catch (reclaimError) {
        if (![404, 409].includes(getErrorStatus(reclaimError))) {
          throw reclaimError;
        }
      }
    }
    return false;
  }
}

async function releaseOperationSlotSafely() {
  try {
    const slot = await client.get({ index: JOBS_INDEX, id: SLOT_ID });
    if (slot?.found && slot._source?.jobId === jobId) {
      await client.delete({
        index: JOBS_INDEX,
        id: SLOT_ID,
        if_seq_no: slot._seq_no,
        if_primary_term: slot._primary_term,
      });
    }
  } catch (error) {
    if (![404, 409].includes(getErrorStatus(error))) {
      console.error('Slot release notice:', error?.message || error);
    }
  }
}

async function acquireTargetLock() {
  const now = new Date().toISOString();

  // 배포 전에 시작된 전역 잠금 작업과 새 대상별 작업이 겹치지 않도록 호환 대기한다.
  try {
    const legacyLock = await client.get({ index: JOBS_INDEX, id: LEGACY_LOCK_ID });
    const legacyHeartbeat = new Date(
      legacyLock._source?.heartbeatAt || legacyLock._source?.lockedAt || 0,
    ).getTime();
    if (
      legacyLock?.found &&
      Number.isFinite(legacyHeartbeat) &&
      Date.now() - legacyHeartbeat <= STALE_LOCK_TIMEOUT_MS
    ) {
      return false;
    }
  } catch (error) {
    if (getErrorStatus(error) !== 404) throw error;
  }

  try {
    await client.create({
      index: JOBS_INDEX,
      id: LOCK_ID,
      document: {
        docType: 'lock',
        jobId,
        environment,
        operation,
        trigger: 'auto',
        requester: 'system:cron',
        lockedAt: now,
        heartbeatAt: now,
      },
    });
    return true;
  } catch (error) {
    if (getErrorStatus(error) !== 409) {
      throw error;
    }
  }

  try {
    const existing = await client.get({
      index: JOBS_INDEX,
      id: LOCK_ID,
    });
    if (existing?.found && existing._source) {
      const rawTime =
        existing._source.heartbeatAt || existing._source.lockedAt;
      const lastHeartbeat = rawTime ? new Date(rawTime).getTime() : 0;
      const isStale =
        Number.isFinite(lastHeartbeat) &&
        Date.now() - lastHeartbeat > STALE_LOCK_TIMEOUT_MS;

      if (
        isStale &&
        typeof existing._seq_no === 'number' &&
        typeof existing._primary_term === 'number'
      ) {
        await client.index({
          index: JOBS_INDEX,
          id: LOCK_ID,
          if_seq_no: existing._seq_no,
          if_primary_term: existing._primary_term,
          document: {
            docType: 'lock',
            jobId,
            environment,
            operation,
            trigger: 'auto',
            requester: 'system:cron',
            lockedAt: now,
            heartbeatAt: now,
          },
        });
        return true;
      }
    }
    return false;
  } catch (error) {
    if (getErrorStatus(error) === 409 || getErrorStatus(error) === 404) {
      return false;
    }
    throw error;
  }
}

async function updateJobRunning() {
  const now = new Date().toISOString();
  await updateJobDocument({
    doc: {
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      configId,
    },
  });
  await updateLockHeartbeatSafely(now);
}

async function updateJobPhase(phase, extra = {}) {
  const now = new Date().toISOString();
  await updateJobDocument({
    doc: {
      currentPhase: phase,
      heartbeatAt: now,
      ...extra,
    },
  });
}

// stale 락이 다른 작업에 회수된 뒤 이전 워커가 새 락을 갱신하지 않도록
// 현재 jobId와 Elasticsearch 문서 버전이 모두 일치할 때만 heartbeat를 기록한다.
async function updateLockHeartbeatSafely(now) {
  try {
    const lock = await client.get({ index: JOBS_INDEX, id: LOCK_ID });
    if (!lock?.found || lock._source?.jobId !== jobId) return;

    await client.update({
      index: JOBS_INDEX,
      id: LOCK_ID,
      if_seq_no: lock._seq_no,
      if_primary_term: lock._primary_term,
      doc: { heartbeatAt: now },
    });
  } catch (error) {
    if (![404, 409].includes(getErrorStatus(error))) throw error;
  }
}

async function sendHeartbeat() {
  const now = new Date().toISOString();
  await Promise.all([
    updateJobDocument({
      doc: { heartbeatAt: now },
    }).catch(() => {}),
    updateLockHeartbeatSafely(now),
    client
      .update({
        index: JOBS_INDEX,
        id: SLOT_ID,
        doc: { heartbeatAt: now },
      })
      .catch(() => {}),
  ]);
}

async function releaseLockSafely() {
  try {
    const lock = await client.get({
      index: JOBS_INDEX,
      id: LOCK_ID,
    });
    if (lock?.found && lock._source?.jobId === jobId) {
      await client.delete({
        index: JOBS_INDEX,
        id: LOCK_ID,
        if_seq_no: lock._seq_no,
        if_primary_term: lock._primary_term,
      });
    }
  } catch (error) {
    if (getErrorStatus(error) !== 404) {
      console.error('Lock release notice:', error?.message || error);
    }
  }
}

async function markJobTerminal(
  status,
  resultCount,
  targetIndices,
  errorCode,
  errorMessage,
  extra = {},
) {
  const doc = {
    status,
    finishedAt: new Date().toISOString(),
    resultCount: Number.isFinite(resultCount) ? resultCount : 0,
    targetIndices,
    ...extra,
  };
  if (errorCode) doc.errorCode = errorCode;
  if (errorMessage) doc.errorMessage = errorMessage;
  await updateJobDocument({
    script: {
      lang: 'painless',
      source: `
        if (ctx._source.status != 'running' && ctx._source.status != 'queued') {
          ctx.op = 'none';
          return;
        }
        ctx._source.putAll(params.doc);
        if (params.requestedStatus == 'succeeded' && ctx._source.cancelRequestedAt != null) {
          ctx._source.status = 'cancelled';
          ctx._source.cancelledAt = params.finishedAt;
          ctx._source.cancelAcknowledgedAt = params.finishedAt;
          ctx._source.errorCode = 'ERR_INDEXING_CANCELLED_BY_USER';
          ctx._source.errorMessage = '사용자 요청으로 색인 작업을 중지했습니다. DB 조회 및 후속 처리가 중단되었습니다.';
        }
      `,
      params: {
        doc,
        requestedStatus: status,
        finishedAt: doc.finishedAt,
      },
    },
  });
}

async function markJobCancelled(resultCount, targetIndices, extra = {}) {
  const now = new Date().toISOString();
  await updateJobDocument({
    script: {
      lang: 'painless',
      source: `
        if (ctx._source.status != 'running' && ctx._source.status != 'queued') {
          ctx.op = 'none';
          return;
        }
        ctx._source.putAll(params.doc);
      `,
      params: {
        doc: {
          status: 'cancelled',
          finishedAt: now,
          cancelledAt: now,
          cancelAcknowledgedAt: now,
          resultCount: Number.isFinite(resultCount) ? resultCount : 0,
          targetIndices,
          errorCode: 'ERR_INDEXING_CANCELLED_BY_USER',
          errorMessage: '사용자 요청으로 색인 작업을 중지했습니다. DB 조회 및 후속 처리가 중단되었습니다.',
          ...extra,
        },
      },
    },
  });
}

async function runOneShot(targetOp, timeoutMs, executionConfig) {
  if (operation === 'embedding') {
    return runEmbeddingIndexing({
      environment,
      mode: embeddingMode,
      targetIndex: executionConfig?.indexName || defaultTargetIndex,
      config: executionConfig,
      esClient: client,
      timeoutMs,
      signal: cancellationController.signal,
    });
  }
  return runDirectIndexing({
    environment,
    operation: targetOp || operation,
    trigger,
    jobId,
    timeoutMs,
    esClient: client,
    jobsIndex: JOBS_INDEX,
    configId,
    config: executionConfig,
    signal: cancellationController.signal,
    onPhase:
      operation === 'full'
        ? async (phase, phaseMetrics) => {
            try {
              await updateJobPhase(phase, phaseMetrics);
            } catch (error) {
              if (!Number.isFinite(phaseMetrics?.embeddingProcessedCount))
                throw error;
              console.error(
                'Embedding progress update notice:',
                error?.message || error,
              );
            }
          }
        : undefined,
    claimId: jobId,
  });
}

function getTimingFields(result) {
  return {
    ...(result?.timings || {}),
    ...(result?.phaseTimestamps || {}),
    ...(Number.isFinite(result?.vectorizedCount) ? { vectorizedCount: result.vectorizedCount } : {}),
    ...(Number.isFinite(result?.vectorizedCount) ? { generatedVectorCount: result.vectorizedCount } : {}),
    ...(Number.isFinite(result?.reusedVectorCount) ? { reusedVectorCount: result.reusedVectorCount } : {}),
    ...(Number.isFinite(result?.embeddingProcessedCount) ? { embeddingProcessedCount: result.embeddingProcessedCount } : {}),
    ...(Number.isFinite(result?.embeddingTargetCount) ? { embeddingTargetCount: result.embeddingTargetCount } : {}),
  };
}

function getSyncTimingFields(prefix, result) {
  const timings = result?.timings || {};
  return {
    [`${prefix}DbConnectDurationMs`]: timings.dbConnectDurationMs || 0,
    [`${prefix}DbExecuteDurationMs`]: timings.dbExecuteDurationMs || 0,
    [`${prefix}DbFetchDurationMs`]: timings.dbFetchDurationMs || 0,
    [`${prefix}DbDurationMs`]: timings.dbDurationMs || 0,
    [`${prefix}EsBulkDurationMs`]: timings.esBulkDurationMs || 0,
    ...(prefix === 'add' ? {
      [`${prefix}EmbeddingDurationMs`]: timings.embeddingDurationMs || 0,
      [`${prefix}EmbeddingProcessedCount`]: result?.embeddingProcessedCount || 0,
      [`${prefix}EmbeddingTargetCount`]: result?.embeddingTargetCount || 0,
      [`${prefix}ReusedVectorCount`]: result?.reusedVectorCount || 0,
      [`${prefix}GeneratedVectorCount`]: result?.vectorizedCount || 0,
    } : {}),
  };
}

async function main() {
  let ownsLock = false;
  let ownsSlot = false;
  let queueClaimed = false;
  let queueFinalized = false;
  let heartbeatTimer = null;
  let resultCount = 0;
  let targetIndices = [
    operation === 'full'
      ? defaultTargetIndex + '-%{applydate}'
      : defaultTargetIndex,
  ];


  try {
    await ensureJobsIndex();
    startCancelMonitor();

    if (trigger === 'auto') {
      await createAutomaticJob();
    }

    ownsSlot = await reserveOperationSlot();
    if (!ownsSlot) {
      if (cancellationController.signal.aborted) {
        await markJobCancelled(resultCount, targetIndices);
        return;
      }
      await markJobTerminal(
        'skipped',
        0,
        targetIndices,
        'SAME_OPERATION_ACTIVE',
        '같은 인덱스의 동일한 색인 작업이 실행 또는 대기 중이므로 건너뛰었습니다.',
      );
      return;
    }

    // 다른 종류의 색인이 실행 중이면 queued 상태로 대상 락이 빌 때까지 기다린다.
    while (!ownsLock) {
      if (cancellationController.signal.aborted) {
        await markJobCancelled(resultCount, targetIndices);
        return;
      }
      ownsLock = await acquireTargetLock();
      if (!ownsLock) {
        const now = new Date().toISOString();
        await Promise.all([
          updateJobDocument({
            doc: { status: 'queued', heartbeatAt: now },
          }),
          client.update({
            index: JOBS_INDEX,
            id: SLOT_ID,
            doc: { heartbeatAt: now },
          }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (cancellationController.signal.aborted) {
      await markJobCancelled(resultCount, targetIndices);
      return;
    }

    await updateJobRunning();
    // 실행 도중 설정이 수정되더라도 현재 작업은 시작 시점의 동일한 SQL과 대상 인덱스를 끝까지 사용한다.
    const executionConfig = await loadIndexingConfig();
    // 증분/삭제 묶음은 전체 30분, 전체 색인은 2시간을 초과하지 않는다.
    const jobDeadline =
      Date.now() +
      (operation === 'full'
        ? FULL_JOB_TIMEOUT_MS
        : INCREMENTAL_JOB_TIMEOUT_MS);
    const remainingTimeout = () => Math.max(1, jobDeadline - Date.now());
    heartbeatTimer = setInterval(() => {
      sendHeartbeat().catch(() => {});
    }, 10000);

    if (operation === 'sync') {
      const runGeoSweep = async () => {
        const geo = normalizeGeoConfig(executionConfig?.embedding?.geo, executionConfig?.indexName || defaultTargetIndex);
        if (!geo.enabled || executionConfig?.embedding?.enabled === false) return { exitCode: 0, resultCount: 0 };
        await updateJobPhase('embedding');
        return runEmbeddingIndexing({ environment, targetIndex: executionConfig?.indexName || defaultTargetIndex, mode: 'changed', config: executionConfig, esClient: client, timeoutMs: remainingTimeout(), signal: cancellationController.signal });
      };
      // 한 번 선점한 큐 묶음은 추가·임베딩·삭제가 모두 성공한 뒤에만 완료 처리한다.
      const claimedCount = await claimSyncQueue(environment, jobId);
      if (claimedCount === 0) {
        const sweep = await runGeoSweep();
        if (isCancellationError(sweep)) {
          await markJobCancelled(sweep.resultCount, [executionConfig?.indexName || defaultTargetIndex]);
          return;
        }
        await markJobTerminal(
          sweep.exitCode === 0 ? 'succeeded' : 'failed',
          sweep.resultCount,
          [executionConfig?.indexName || defaultTargetIndex],
          sweep.errorCode || null,
          sweep.errorDescription || null,
          { addResultCount: 0, deleteResultCount: 0, queueClaimedCount: 0 },
        );
        return;
      }
      queueClaimed = true;
      const failClaim = async (message) => {
        await failSyncQueue(environment, jobId, message);
        queueFinalized = true;
      };
      await updateJobPhase('add');
      const addResult = await runOneShot('add', remainingTimeout(), executionConfig);
      const addCount = addResult.resultCount;
      const addTimingFields = getSyncTimingFields('add', addResult);

      if (isCancellationError(addResult)) {
        await failClaim('사용자 요청으로 증분 색인이 중지되었습니다.');
        await markJobCancelled(addCount, [defaultTargetIndex], { currentPhase: 'add', addResultCount: addCount, deleteResultCount: 0, ...addTimingFields });
        return;
      }

      if (addResult.timedOut) {
        await failClaim('증분 색인이 최대 실행 시간 30분을 초과했습니다.');
        await markJobTerminal(
          'failed',
          addCount,
          [defaultTargetIndex],
          'ERR_INDEXING_TIMEOUT',
          '증분/삭제 색인 작업이 최대 실행 시간 30분을 초과해 종료되었습니다.',
          { currentPhase: 'add', addResultCount: addCount, deleteResultCount: 0, ...addTimingFields },
        );
        return;
      }

      if (addResult.exitCode !== 0) {
        await failClaim(addResult.errorDescription);
        await markJobTerminal(
          'failed',
          addCount,
          [defaultTargetIndex],
          addResult.errorCode || 'ERR_INDEXING_ADD_FAILED',
          '증분 색인(Add) 단계 실패: ' + addResult.errorDescription,
          { currentPhase: 'add', addResultCount: addCount, deleteResultCount: 0, ...addTimingFields },
        );
        return;
      }

      await updateJobPhase('delete', { addResultCount: addCount, ...addTimingFields });
      const deleteResult = await runOneShot('delete', remainingTimeout(), executionConfig);
      const deleteCount = deleteResult.resultCount;
      const totalCount = addCount + deleteCount;
      const deleteTimingFields = getSyncTimingFields('delete', deleteResult);
      const syncTimingFields = { ...addTimingFields, ...deleteTimingFields };

      if (isCancellationError(deleteResult)) {
        await failClaim('사용자 요청으로 삭제 색인이 중지되었습니다.');
        await markJobCancelled(totalCount, [defaultTargetIndex], { currentPhase: 'delete', addResultCount: addCount, deleteResultCount: deleteCount, ...syncTimingFields });
        return;
      }

      if (deleteResult.timedOut) {
        await failClaim('삭제 색인이 최대 실행 시간 30분을 초과했습니다.');
        await markJobTerminal(
          'failed',
          totalCount,
          [defaultTargetIndex],
          'ERR_INDEXING_TIMEOUT',
          '증분/삭제 색인 작업이 최대 실행 시간 30분을 초과해 종료되었습니다.',
          { currentPhase: 'delete', addResultCount: addCount, deleteResultCount: deleteCount, ...syncTimingFields },
        );
        return;
      }

      if (deleteResult.exitCode !== 0) {
        await failClaim(deleteResult.errorDescription);
        await markJobTerminal(
          'failed',
          totalCount,
          [defaultTargetIndex],
          deleteResult.errorCode || 'ERR_INDEXING_DELETE_FAILED',
          '삭제 색인(Delete) 단계 실패: ' + deleteResult.errorDescription,
          { currentPhase: 'delete', addResultCount: addCount, deleteResultCount: deleteCount, ...syncTimingFields },
        );
        return;
      }

      const sweep = await runGeoSweep();
      if (sweep.exitCode !== 0) {
        await failClaim(sweep.errorDescription);
        if (isCancellationError(sweep)) await markJobCancelled(totalCount, [defaultTargetIndex], { currentPhase: 'embedding', ...syncTimingFields });
        else await markJobTerminal('failed', totalCount, [defaultTargetIndex], sweep.errorCode || 'ERR_EMBEDDING_FAILED', sweep.errorDescription, { currentPhase: 'embedding', ...syncTimingFields });
        return;
      }

      await observeCancellation();
      if (cancellationController.signal.aborted) {
        await failClaim('사용자 요청으로 증분/삭제 색인이 중지되었습니다.');
        await markJobCancelled(totalCount, [defaultTargetIndex], { currentPhase: 'delete', addResultCount: addCount, deleteResultCount: deleteCount, ...syncTimingFields });
      } else {
        const completedQueueCount = await completeSyncQueue(environment, jobId);
        queueFinalized = true;
        await markJobTerminal(
          'succeeded',
          totalCount,
          [defaultTargetIndex],
          null,
          null,
          { addResultCount: addCount, deleteResultCount: deleteCount, queueClaimedCount: claimedCount, queueCompletedCount: completedQueueCount, ...syncTimingFields },
        );
      }
    } else {
      const result = await runOneShot(operation, remainingTimeout(), executionConfig);
      resultCount = result.resultCount;
      targetIndices = result.targetIndices;
      await observeCancellation();
      if (isCancellationError(result)) {
        await markJobCancelled(resultCount, targetIndices, getTimingFields(result));
      } else if (result.timedOut) {
        await markJobTerminal(
          'failed',
          resultCount,
          targetIndices,
          'ERR_INDEXING_TIMEOUT',
          operation === 'full'
            ? '전체 색인 작업이 최대 실행 시간 2시간을 초과해 종료되었습니다.'
            : '증분/삭제 색인 작업이 최대 실행 시간 30분을 초과해 종료되었습니다.',
          getTimingFields(result),
        );
      } else if (result.exitCode === 0 && !cancellationController.signal.aborted) {
        let aliasMetrics = {};
        if (operation === 'full') {
          const aliasStartedAt = Date.now();
          await updateJobPhase('alias', {
            ...getTimingFields(result),
            embeddingFinishedAt: result.phaseTimestamps?.embeddingFinishedAt,
          });
          try {
            await switchIndexAlias(client, executionConfig?.indexName || defaultTargetIndex, targetIndices[0]);
          } catch (error) {
            await markJobTerminal(
              'failed',
              resultCount,
              targetIndices,
              'ERR_ALIAS_SWITCH_FAILED',
              `전체 색인은 완료됐지만 최신 인덱스로 별칭을 변경하지 못했습니다: ${error instanceof Error ? error.message : '원인 미상'}`,
              { ...getTimingFields(result), aliasDurationMs: Date.now() - aliasStartedAt },
            );
            return;
          }
          try {
            await deleteOldDatedIndices(client, executionConfig?.indexName || defaultTargetIndex, targetIndices[0]);
            aliasMetrics = { aliasDurationMs: Date.now() - aliasStartedAt };
          } catch (error) {
            await markJobTerminal(
              'failed',
              resultCount,
              targetIndices,
              'ERR_INDEX_RETENTION_FAILED',
              `최신 인덱스로 별칭은 변경했지만 과거 전체색인 정리에 실패했습니다: ${error instanceof Error ? error.message : '원인 미상'}`,
              { ...getTimingFields(result), aliasDurationMs: Date.now() - aliasStartedAt },
            );
            return;
          }
        }
        await markJobTerminal(
          'succeeded',
          resultCount,
          targetIndices,
          null,
          null,
          { ...getTimingFields(result), ...aliasMetrics },
        );
      } else {
        console.error(`[INDEXING-WORKER] ${jobId} ${result.errorCode || 'ERR_INDEXING_FAILED'}: ${result.errorDescription}`);
        await markJobTerminal(
          'failed',
          resultCount,
          targetIndices,
          result.errorCode || 'ERR_INDEXING_FAILED',
          '색인 작업 실패: ' + result.errorDescription,
          getTimingFields(result),
        );
      }
    }
  } catch (error) {
    console.error('Unexpected indexing worker error:', error?.message || error);
    if (queueClaimed && !queueFinalized) {
      await failSyncQueue(environment, jobId, error?.message || '워커 예외 발생').catch(() => {});
      queueFinalized = true;
    }
    if (isCancellationError(error)) {
      await markJobCancelled(resultCount, targetIndices).catch(() => {});
    } else {
      await markJobTerminal(
        'failed',
        resultCount,
        targetIndices,
        'ERR_INDEXING_FAILED',
        '워커 예외 발생: ' + (error?.message || '알 수 없는 오류'),
      ).catch(() => {});
    }
  } finally {
    stopCancelMonitor();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (ownsLock) await releaseLockSafely();
    if (ownsSlot) await releaseOperationSlotSafely();
  }
}

main().catch((error) => {
  console.error('Unhandled indexing worker rejection:', error);
});
