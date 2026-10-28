export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startIndexingCronScheduler } = await import(
    './service/cron-scheduler'
  );
  const { startIndexingWatchdog } = await import(
    './service/indexing-watchdog'
  );
  await Promise.all([startIndexingCronScheduler(), startIndexingWatchdog()]);
}
