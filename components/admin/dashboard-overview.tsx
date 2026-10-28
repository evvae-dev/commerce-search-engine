 
import { useAdminWorkspace } from './admin-workspace';
import type { IndexingConfig } from '../../service/indexing-config-service';
import type { AdminDashboardGetResponse, IndexingJobDoc } from '../../service/indexing-job-service';
import styles from './dashboard-overview.module.css';

interface DashboardOverviewProps {
  data: AdminDashboardGetResponse | null;
  configs: IndexingConfig[];
  loading: boolean;
  errorMessage: string | null;
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function belongsToConfig(job: IndexingJobDoc, config: IndexingConfig): boolean {
  return job.configId === config.id || (!job.configId && job.environment === config.environment &&
    (job.targetIndices || []).some((name) => name === config.indexName || name.startsWith(`${config.indexName}-`)));
}

function statusOf(jobs: IndexingJobDoc[]): { label: string; tone: string } {
  const active = jobs.find((job) => job.status === 'running' || job.status === 'queued');
  if (active?.status === 'running') return { label: '색인 중', tone: styles.running };
  if (active?.status === 'queued') return { label: '대기', tone: styles.queued };
  const latest = jobs.find((job) => ['succeeded', 'failed', 'cancelled'].includes(job.status));
  if (latest?.status === 'failed') return { label: '실패', tone: styles.failed };
  if (latest?.status === 'cancelled') return { label: '중지됨', tone: styles.cancelled };
  return { label: '정상', tone: styles.success };
}

function formatChange(rate: number | null): { text: string; tone: string } {
  if (rate === null) return { text: '신규', tone: styles.up };
  if (rate > 0) return { text: `▲ ${rate.toFixed(1)}%`, tone: styles.up };
  if (rate < 0) return { text: `▼ ${Math.abs(rate).toFixed(1)}%`, tone: styles.down };
  return { text: '-', tone: styles.flat };
}

function hourLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' }).format(date);
}

export default function DashboardOverview({ data, configs, loading, errorMessage }: DashboardOverviewProps) {
  const { environment } = useAdminWorkspace();
  const jobs = data?.recentJobs || [];
  const stats = data?.searchStats;
  const maxHourly = Math.max(1, ...(stats?.hourly || []).map((item) => item.count));

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1>검색엔진 대시보드</h1>
          <p>색인 상태와 사이트 검색 흐름을 한눈에 확인합니다.</p>
        </div>
        {loading && <span className={styles.loading}>데이터를 불러오는 중입니다.</span>}
      </header>

      {errorMessage && <div className={styles.error}>{errorMessage}</div>}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div><h2>인덱스 현황</h2><p>등록된 검색 인덱스의 현재 상태입니다.</p></div>
        </div>
        <div id="dashboard-index-grid" className={styles.indexGrid}>
          {configs.filter((config) => config.environment === environment).map((config) => {
            const summary = data?.environments?.[config.environment];
            const physical = (summary?.indices || []).filter((item) => item.aliases.includes(config.indexName));
            const configJobs = jobs.filter((job) => belongsToConfig(job, config));
            const full = configJobs.find((job) => job.operation === 'full' && job.status === 'succeeded');
            const sync = configJobs.find((job) => job.operation === 'sync' && job.status === 'succeeded');
            const status = statusOf(configJobs);
            return (
              <article className={styles.indexCard} key={config.id}>
                <div className={styles.indexTitle}>
                  <div><span>{config.environment === 'prd' ? '운영' : '개발'}</span><h3>{config.indexName}{config.displayName ? ` (${config.displayName})` : ''}</h3></div>
                  <strong className={`${styles.status} ${status.tone}`}>{status.label}</strong>
                </div>
                <div className={styles.documentCount}><span>문서 수</span><strong>{physical.reduce((sum, item) => sum + item.docsCount, 0).toLocaleString()}</strong></div>
                <dl className={styles.completionTimes}>
                  <div><dt>전체색인 최근 완료</dt><dd>{formatDateTime(full?.finishedAt)}</dd></div>
                  <div><dt>추가색인 최근 완료</dt><dd>{formatDateTime(sync?.finishedAt)}</dd></div>
                </dl>
              </article>
            );
          })}
          {!loading && configs.filter((config) => config.environment === environment).length === 0 && <div className={styles.empty}>등록된 인덱스가 없습니다.</div>}
        </div>
      </section>

      <section className={styles.chartCard}>
        <div className={styles.sectionHeader}>
          <div><h2>시간대별 검색 요청 추이</h2><p>최근 24시간 동안 검색 API로 들어온 요청 수입니다.</p></div>
          <span>최근 24시간</span>
        </div>
        {stats?.error ? <div className={styles.cardError}>{stats.error}</div> : (stats?.hourly?.length || 0) === 0 ? <div className={styles.empty}>집계된 검색 요청이 없습니다.</div> : (
          <div className={styles.chart} aria-label="최근 24시간 검색 요청 막대 차트">
            {stats?.hourly.map((item) => (
              <div className={styles.barItem} key={item.hour}>
                <span className={styles.barValue}>{item.count.toLocaleString()}</span>
                <div className={styles.barTrack}><i style={{ height: `${Math.max(item.count ? 8 : 0, (item.count / maxHourly) * 100)}%` }} /></div>
                <span className={styles.barLabel}>{hourLabel(item.hour)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className={styles.rankGrid}>
        <section className={styles.rankCard}>
          <div className={styles.sectionHeader}><div><h2>사이트 내 검색어 TOP 10</h2><p>최근 24시간 검색 횟수와 전주 동일 구간 대비입니다.</p></div></div>
          <table><thead><tr><th>순위</th><th>검색어</th><th>검색수</th><th>전주 대비</th></tr></thead>
            <tbody>{stats?.topQueries?.map((item, index) => { const change = formatChange(item.changeRate); return <tr key={item.query}><td>{index + 1}</td><td>{item.query}</td><td>{item.count.toLocaleString()}</td><td className={change.tone}>{change.text}</td></tr>; })}</tbody>
          </table>
          {!stats?.error && (stats?.topQueries?.length || 0) === 0 && <div className={styles.empty}>집계된 검색어가 없습니다.</div>}
        </section>

        <section className={styles.rankCard}>
          <div className={styles.sectionHeader}><div><h2>실시간 급등 검색어 TOP 10</h2><p>최근 1시간을 직전 24시간의 시간당 평균과 비교합니다.</p></div></div>
          <table><thead><tr><th>순위</th><th>검색어</th><th>최근 1시간</th><th>상승</th></tr></thead>
            <tbody>{stats?.risingQueries?.map((item, index) => <tr key={item.query}><td>{index + 1}</td><td>{item.query}</td><td>{item.count.toLocaleString()}</td><td className={styles.up}>{item.ratio === null ? '신규' : `${item.ratio.toFixed(1)}배`}</td></tr>)}</tbody>
          </table>
          {!stats?.error && (stats?.risingQueries?.length || 0) === 0 && <div className={styles.empty}>급등 조건을 충족한 검색어가 없습니다.</div>}
        </section>
      </div>
    </div>
  );
}
