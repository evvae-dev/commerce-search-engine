import crypto from 'node:crypto';
import cron, { type ScheduledTask } from 'node-cron';

import {
  listIndexingConfigs,
  type IndexingConfig,
} from './indexing-config-service';
import {
  type IndexingOperation,
  spawnIndexingWorker,
} from './indexing-job-service';

const CRON_TIMEZONE = 'Asia/Seoul';
const RECONCILE_INTERVAL_MS = Number(
  process.env.INDEXING_CRON_RECONCILE_INTERVAL_MS || 5000,
);

interface SchedulerRuntime {
  tasks: Map<string, ScheduledTask>;
  fingerprints: Map<string, string>;
  timer: NodeJS.Timeout | null;
  reconcilePromise: Promise<void> | null;
}

const globalScheduler = globalThis as typeof globalThis & {
  __commerceIndexingCronScheduler?: SchedulerRuntime;
};

function getRuntime(): SchedulerRuntime {
  if (!globalScheduler.__commerceIndexingCronScheduler) {
    globalScheduler.__commerceIndexingCronScheduler = {
      tasks: new Map(),
      fingerprints: new Map(),
      timer: null,
      reconcilePromise: null,
    };
  }
  return globalScheduler.__commerceIndexingCronScheduler;
}

function isCronOwner(): boolean {
  const instanceId = process.env.NODE_APP_INSTANCE;
  return instanceId === undefined || instanceId === '0';
}

async function runScheduledJob(
  config: IndexingConfig,
  operation: IndexingOperation,
): Promise<void> {
  try {
    await spawnIndexingWorker(
      crypto.randomUUID(),
      config.environment,
      operation,
      'auto',
      config.id,
    );
  } catch (error) {
    console.error(
      `[INDEXING-CRON] 워커 시작 실패 ${config.indexName}:${operation}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function registerTask(
  runtime: SchedulerRuntime,
  key: string,
  schedule: string,
  config: IndexingConfig,
  operation: IndexingOperation,
): void {
  const task = cron.schedule(
    schedule,
    () => {
      void runScheduledJob(config, operation);
    },
    { timezone: CRON_TIMEZONE },
  );
  runtime.tasks.set(key, task);
}

function stopTask(runtime: SchedulerRuntime, key: string): void {
  const task = runtime.tasks.get(key);
  if (task) {
    task.stop();
    task.destroy();
    runtime.tasks.delete(key);
  }
  runtime.fingerprints.delete(key);
}

function applyConfigs(configs: IndexingConfig[]): void {
  const runtime = getRuntime();
  const desired = new Set<string>();

  for (const config of configs) {
    const definitions: Array<{
      operation: IndexingOperation;
      schedule?: string;
      enabled: boolean;
    }> = [
      {
        operation: 'full',
        schedule: config.fullSchedule,
        enabled: config.fullEnabled,
      },
      {
        operation: 'sync',
        schedule: config.syncSchedule,
        enabled:
          config.syncEnabled && Boolean(config.addQuery && config.deleteQuery),
      },
    ];

    for (const definition of definitions) {
      const key = `${config.id}:${definition.operation}`;
      desired.add(key);
      const fingerprint = definition.enabled
        ? `enabled:${definition.schedule}:${config.updatedAt}`
        : `disabled:${config.updatedAt}`;
      if (runtime.fingerprints.get(key) === fingerprint) continue;
      stopTask(runtime, key);
      if (definition.enabled && definition.schedule) {
        registerTask(
          runtime,
          key,
          definition.schedule,
          config,
          definition.operation,
        );
        console.log(`[INDEXING-CRON] 등록 ${config.indexName}:${definition.operation} (${definition.schedule})`);
      } else {
        console.log(`[INDEXING-CRON] 중지 ${config.indexName}:${definition.operation}`);
      }
      runtime.fingerprints.set(key, fingerprint);
    }
  }

  for (const key of [...runtime.fingerprints.keys()]) {
    if (!desired.has(key)) stopTask(runtime, key);
  }
}

export async function reconcileIndexingCron(): Promise<void> {
  if (!isCronOwner()) return;
  const runtime = getRuntime();
  if (runtime.reconcilePromise) return runtime.reconcilePromise;

  runtime.reconcilePromise = (async () => {
    const configs = await listIndexingConfigs();
    applyConfigs(configs);
  })().finally(() => {
    runtime.reconcilePromise = null;
  });
  return runtime.reconcilePromise;
}

export async function startIndexingCronScheduler(): Promise<void> {
  if (!isCronOwner()) {
    console.log(
      '[INDEXING-CRON] PM2 instance ' +
        process.env.NODE_APP_INSTANCE +
        '에서는 등록하지 않습니다.',
    );
    return;
  }

  const runtime = getRuntime();
  await reconcileIndexingCron();
  if (runtime.timer) return;

  runtime.timer = setInterval(() => {
    void reconcileIndexingCron().catch((error) => {
      console.error(
        '[INDEXING-CRON] 설정 동기화 실패:',
        error instanceof Error ? error.message : error,
      );
    });
  }, RECONCILE_INTERVAL_MS);
  runtime.timer.unref();
}
