import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminPageActive, useAdminPagePath, useAdminWorkspace } from '../../../components/admin/admin-workspace';
import DashboardOverview from '../../../components/admin/dashboard-overview';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getVectorField } from '../../../constant/vector-field.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type {
  IndexingConfig,
  IndexingConfigInput,
} from '../../../service/indexing-config-service';
import type {
  AdminDashboardGetResponse,
  IndexingEnvironment,
  IndexingJobDoc,
  IndexingOperation,
} from '../../../service/indexing-job-service';
import type { ManagedIndexTemplate } from '../../../service/index-template-service';
import styles from './dashboard.module.css';

interface AdminDashboardPageProps {
  email: string;
}

export const getServerSideProps: GetServerSideProps<
  AdminDashboardPageProps
> = async (context) => {
  const admin = await getAdminPageSession(context);
  if (!admin) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  return { props: { email: admin.email } };
};

const HISTORY_PAGE_SIZE = 20;
const HISTORY_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'queued',
  'cancelled',
] as const;
type HistoryStatus = (typeof HISTORY_STATUSES)[number];

interface TemplateDraft {
  name: string;
  bodyText: string;
  exists: boolean;
  targetIndex: string;
  loading: boolean;
}

function adaptTemplateVectorField(
  body: Record<string, unknown>,
  indexName: string,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const template = cloned.template as Record<string, unknown> | undefined;
  const mappings = template?.mappings as Record<string, unknown> | undefined;
  const properties = mappings?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return cloned;
  const vectorField = getVectorField(indexName);
  const existingVector = Object.entries(properties).find(
    ([field, mapping]) => field.endsWith('_vector') || mapping.type === 'dense_vector',
  );
  if (existingVector && existingVector[0] !== vectorField) {
    delete properties[existingVector[0]];
    properties[vectorField] = existingVector[1];
  } else if (!existingVector) {
    properties[vectorField] = {
      type: 'dense_vector',
      dims: 384,
      index: true,
      similarity: 'cosine',
    };
  }
  return cloned;
}

const EMPTY_FORM: IndexingConfigInput = {
  environment: 'dev',
  displayName: '',
  indexName: 'dev-',
  documentIdColumn: '',
  fullQuery: '',
  fullSchedule: '0 9 * * *',
  fullEnabled: true,
  autoRegisterDictionary: true,
  addQuery: '',
  deleteQuery: '',
  syncSchedule: '*/5 * * * *',
  syncEnabled: false,
};

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatTableDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function formatDuration(start?: string, end?: string): string {
  if (!start || !end) return '-';
  const milliseconds = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}시간 ${minutes}분 ${seconds}초`;
}

function formatMilliseconds(value?: number): string {
  if (!Number.isFinite(value) || value === undefined) return '-';
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}시간` : '', minutes ? `${minutes}분` : '', `${seconds}초`]
    .filter(Boolean)
    .join(' ');
}

function getPhaseLabel(phase?: string): string {
  if (phase === 'db') return 'DB 조회·ES 저장';
  if (phase === 'embedding') return '임베딩 생성';
  if (phase === 'alias') return '알리아스 변경';
  if (phase === 'add') return '증분 색인';
  if (phase === 'delete') return '삭제 색인';
  return phase || '-';
}

function getPhaseButtonLabel(job: IndexingJobDoc): string {
  if (job.status === 'queued') return '대기';
  if (job.status === 'running') return getPhaseLabel(job.currentPhase);
  if (job.status === 'succeeded') return '완료';
  if (job.status === 'cancelled') return '중지';
  return job.currentPhase ? `${getPhaseLabel(job.currentPhase)} 실패` : '실패';
}

function getKoreanDateKey(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getOperationLabel(operation: IndexingOperation): string {
  if (operation === 'full') return '전체 색인';
  if (operation === 'add') return '증분 색인';
  if (operation === 'delete') return '삭제 색인';
  if (operation === 'embedding') return '임베딩';
  return '증분/삭제';
}

function getAliasTargetIndices(
  indices: NonNullable<AdminDashboardGetResponse['environments']['dev']>['indices'],
  aliasName: string,
) {
  return indices.filter((index) => index.aliases.includes(aliasName));
}

function getStatusLabel(status: HistoryStatus): string {
  if (status === 'running') return '색인 중';
  if (status === 'succeeded') return '성공';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '중지됨';
  return '대기';
}

function getEnvironmentLabel(environment: IndexingEnvironment): string {
  return environment === 'prd' ? '운영' : '개발';
}

export default function AdminDashboardPage({ email }: AdminDashboardPageProps) {
  const pageActive = useAdminPageActive();
  const isIndexManagementPage = useAdminPagePath() === '/admin/indexing';
  const historyPageSize = isIndexManagementPage ? 10 : HISTORY_PAGE_SIZE;
  const [data, setData] = useState<AdminDashboardGetResponse | null>(null);
  const [configs, setConfigs] = useState<IndexingConfig[]>([]);
  const { environment: selectedEnv } = useAdminWorkspace();
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [historyDate, setHistoryDate] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'' | HistoryStatus>('');
  const [historyTrigger, setHistoryTrigger] = useState<'' | 'auto' | 'manual'>(
    '',
  );
  const [historyTarget, setHistoryTarget] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [timingJob, setTimingJob] = useState<IndexingJobDoc | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<IndexingConfigInput>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const [formErrorMessage, setFormErrorMessage] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft | null>(null);
  const templateBodyRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    configId: string;
    indexName: string;
    environment: IndexingEnvironment;
    operation: 'full' | 'sync';
  } | null>(null);
  const [cancelPendingJobId, setCancelPendingJobId] = useState<string | null>(
    null,
  );
  const pollingRef = useRef(false);

  const fetchData = useCallback(async () => {
    const [dashboardResponse, configResponse] = await Promise.all([
      fetch('/api/v1/admin/dashboard', {
        headers: { Accept: 'application/json' },
      }),
      fetch('/api/v1/admin/index-configs', {
        headers: { Accept: 'application/json' },
      }),
    ]);
    if (!dashboardResponse.ok)
      throw new Error(`상태 조회 실패 (${dashboardResponse.status})`);
    if (!configResponse.ok)
      throw new Error(`인덱스 설정 조회 실패 (${configResponse.status})`);
    const dashboard =
      (await dashboardResponse.json()) as AdminDashboardGetResponse;
    const configResult = (await configResponse.json()) as {
      success: boolean;
      configs: IndexingConfig[];
    };
    setData(dashboard);
    setConfigs(configResult.configs || []);
    setLastRefreshedAt(
      new Date().toLocaleTimeString('ko-KR', { hour12: false }),
    );
    setErrorMessage(null);
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await fetchData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : '조회 중 오류가 발생했습니다.',
      );
    } finally {
      setLoading(false);
    }
  };

  const activeJobs = useMemo(
    () =>
      (data?.recentJobs || []).filter(
        (job) => job.status === 'running' || job.status === 'queued',
      ),
    [data?.recentJobs],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchData().catch((error) => {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : '조회 중 오류가 발생했습니다.',
        );
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchData]);

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (!pageActive) return;
        if (pollingRef.current) return;
        pollingRef.current = true;
        fetchData()
          .catch(() => {})
          .finally(() => {
            pollingRef.current = false;
          });
      },
      activeJobs.length > 0 ? 5000 : 30000,
    );
    return () => window.clearInterval(timer);
  }, [activeJobs.length, fetchData, pageActive]);

  const filteredHistory = useMemo(() => {
    const target = historyTarget.trim().toLowerCase();
    return (data?.recentJobs || []).filter((job) => {
      if (job.environment !== selectedEnv) return false;
      if (!HISTORY_STATUSES.includes(job.status as HistoryStatus)) return false;
      if (historyDate && getKoreanDateKey(job.createdAt) !== historyDate)
        return false;
      if (historyStatus && job.status !== historyStatus) return false;
      if (historyTrigger && job.trigger !== historyTrigger) return false;
      if (
        target &&
        !(job.targetIndices || []).join(' ').toLowerCase().includes(target)
      )
        return false;
      return true;
    });
  }, [
    data?.recentJobs,
    historyDate,
    historyStatus,
    historyTarget,
    historyTrigger,
    selectedEnv,
  ]);

  const historyPages = Math.max(
    1,
    Math.ceil(filteredHistory.length / historyPageSize),
  );
  const currentHistoryPage = Math.min(historyPage, historyPages);
  const pagedHistory = filteredHistory.slice(
    (currentHistoryPage - 1) * historyPageSize,
    currentHistoryPage * historyPageSize,
  );

  const openCreateForm = () => {
    setFormErrorMessage(null);
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      environment: selectedEnv,
      indexName: `${selectedEnv}-`,
    });
    void loadTemplate(`${selectedEnv}-`, selectedEnv);
    setFormOpen(true);
  };

  const openEditForm = (config: IndexingConfig) => {
    setFormErrorMessage(null);
    setEditingId(config.id);
    setForm({
      environment: config.environment,
      displayName: config.displayName,
      indexName: config.indexName,
      documentIdColumn: config.documentIdColumn,
      fullQuery: config.fullQuery,
      fullSchedule: config.fullSchedule,
      fullEnabled: config.fullEnabled,
      autoRegisterDictionary: config.autoRegisterDictionary !== false,
      addQuery: config.addQuery || '',
      deleteQuery: config.deleteQuery || '',
      syncSchedule: config.syncSchedule || '*/5 * * * *',
      syncEnabled: config.syncEnabled,
    });
    void loadTemplate(config.indexName, config.environment);
    setFormOpen(true);
  };

  const loadTemplate = async (indexName: string, environment: IndexingEnvironment) => {
    setTemplateDraft({ name: `${indexName}-template`, bodyText: '', exists: false, targetIndex: indexName, loading: true });
    try {
      const response = await fetch('/api/v1/admin/index-templates', { headers: { Accept: 'application/json' } });
      const result = await response.json() as { success: boolean; templates?: ManagedIndexTemplate[]; errorMessage?: string };
      if (!response.ok || !result.success) throw new Error(result.errorMessage || '템플릿을 불러오지 못했습니다.');
      const templates = result.templates || [];
      const exactPattern = `${indexName}-*`;
      const existing = templates.find((template) => template.indexPatterns.includes(exactPattern));
      if (existing) {
        setTemplateDraft({ name: existing.name, bodyText: JSON.stringify(adaptTemplateVectorField(existing.body, indexName), null, 2), exists: true, targetIndex: indexName, loading: false });
        return;
      }
      const base = templates.find((template) => template.indexPatterns.includes(`${getGoodsIndex(environment)}-*`));
      const body = adaptTemplateVectorField(base ? { ...base.body, index_patterns: [exactPattern] } : {
        index_patterns: [exactPattern],
        priority: 100,
        template: { settings: {}, mappings: { properties: {} } },
      }, indexName);
      setTemplateDraft({ name: `${indexName}-template`, bodyText: JSON.stringify(body, null, 2), exists: false, targetIndex: indexName, loading: false });
    } catch (error) {
      setTemplateDraft(null);
      setErrorMessage(error instanceof Error ? error.message : '템플릿 조회 중 오류가 발생했습니다.');
    }
  };

  const saveConfig = async () => {
    setFormSaving(true);
    setFormErrorMessage(null);
    try {
      const response = await fetch(
        editingId
          ? `/api/v1/admin/index-configs/${editingId}`
          : '/api/v1/admin/index-configs',
        {
          method: editingId ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(form),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.errorMessage || '설정 저장에 실패했습니다.');
      if (!editingId && result.config?.id) setEditingId(result.config.id);

      if (!templateDraft || templateDraft.loading) throw new Error('인덱스 설정은 저장됐지만 템플릿을 준비하지 못했습니다. 다시 저장해 주세요.');
      if (templateDraft.targetIndex !== form.indexName) throw new Error('인덱스 설정은 저장됐지만 템플릿 대상이 현재 인덱스명과 다릅니다. 인덱스명 입력을 마친 후 템플릿을 다시 불러와 주세요.');
      const templateResponse = await fetch(
        templateDraft.exists
          ? `/api/v1/admin/index-templates/${encodeURIComponent(templateDraft.name)}`
          : '/api/v1/admin/index-templates',
        {
          method: templateDraft.exists ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ name: templateDraft.name, bodyText: templateBodyRef.current?.value || templateDraft.bodyText }),
        },
      );
      const templateResult = await templateResponse.json();
      if (!templateResponse.ok || !templateResult.success) throw new Error(`인덱스 설정은 저장됐지만 템플릿 저장에 실패했습니다: ${templateResult.errorMessage || '원인 미상'}`);
      setFormOpen(false);
      await fetchData();
    } catch (error) {
      setFormErrorMessage(
        error instanceof Error
          ? error.message
          : '설정 저장 중 오류가 발생했습니다.',
      );
    } finally {
      setFormSaving(false);
    }
  };

  const deleteConfig = async (config: IndexingConfig) => {
    if (
      !window.confirm(
        `${config.displayName}(${config.indexName}) 설정을 삭제하시겠습니까? 인덱스 데이터는 삭제되지 않습니다.`,
      )
    )
      return;
    setActionLoading(true);
    try {
      const response = await fetch(`/api/v1/admin/index-configs/${config.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.errorMessage || '설정 삭제에 실패했습니다.');
      await fetchData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '설정 삭제 중 오류가 발생했습니다.',
      );
    } finally {
      setActionLoading(false);
    }
  };

  const executeConfirmedJob = async () => {
    if (!confirmDialog) return;
    const request = confirmDialog;
    setActionLoading(true);
    try {
      const response = await fetch('/api/v1/admin/dashboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          configId: request.configId,
          operation: request.operation,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.errorMessage || '색인 요청에 실패했습니다.');
      setConfirmDialog(null);
      await fetchData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '색인 요청 중 오류가 발생했습니다.',
      );
    } finally {
      setActionLoading(false);
    }
  };

  const cancelJob = async (job: IndexingJobDoc) => {
    const operationLabel = getOperationLabel(job.operation);
    const message =
      job.operation === 'embedding'
        ? `${operationLabel} 작업을 강제중지하시겠습니까? 진행 중인 임베딩 요청을 중단합니다.`
        : `${operationLabel} 작업을 강제중지하시겠습니까? DB 작업은 SQLite 조회를 중단하며, 이미 Elasticsearch에 반영된 일부 데이터는 유지됩니다.`;
    if (!window.confirm(message)) return;
    setCancelPendingJobId(job.id);
    setErrorMessage(null);
    try {
      const response = await fetch(
        `/api/v1/admin/indexing-jobs/${encodeURIComponent(job.id)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: '{}',
        },
      );
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.errorMessage || '중지 요청에 실패했습니다.');
      await fetchData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '중지 요청 중 오류가 발생했습니다.',
      );
    } finally {
      setCancelPendingJobId(null);
    }
  };

  const switchLatestAlias = async (config: IndexingConfig) => {
    if (
      !window.confirm(
        `${config.indexName} 별칭을 최근 성공한 전체 색인 인덱스로 변경하시겠습니까?`,
      )
    )
      return;
    setActionLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(
        `/api/v1/admin/index-configs/${encodeURIComponent(config.id)}/alias`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: '{}',
        },
      );
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(
          result.errorMessage || '최신 인덱스로 별칭을 변경하지 못했습니다.',
        );
      window.alert(
        `${result.alias} 별칭을 ${result.targetIndex}(으)로 변경했습니다.`,
      );
      await fetchData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '별칭 변경 중 오류가 발생했습니다.',
      );
    } finally {
      setActionLoading(false);
    }
  };

  const environmentConfigs = configs.filter(
    (config) => config.environment === selectedEnv,
  );
  const envSummary = data?.environments?.[selectedEnv];

  if (!isIndexManagementPage) {
    return (
      <AdminLayout email={email}>
        <Head><title>검색엔진 대시보드</title></Head>
        <DashboardOverview
          data={data}
          configs={configs}
          loading={loading}
          errorMessage={errorMessage}
        />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout email={email}>
      <div className={styles.container}>
        <Head>
          <title>
            {isIndexManagementPage ? '색인관리' : '검색엔진 대시보드'}
          </title>
        </Head>
        {isIndexManagementPage ? (
          <>
            <header className={styles.indexManagementHeader}>
              <div>
                <h1 className={styles.indexManagementTitle}>인덱스 관리</h1>
                <p className={styles.indexManagementSubtitle}>
                  Elasticsearch 인덱스의 생성, 수정 및 동기화 스케줄을
                  관리합니다.
                </p>
              </div>
            </header>
            {errorMessage && (
              <div className={styles.errorBanner} role="alert">
                {errorMessage}
              </div>
            )}
            <div className={styles.indexManagementToolbar}>
              <span>
                총{' '}
                <strong>{environmentConfigs.length.toLocaleString()}개</strong>
                의 인덱스가 연동되어 있습니다.
              </span>
              <div className={styles.indexToolbarActions}>
                <span>마지막 조회 {lastRefreshedAt || '-'}</span>
                <button
                  type="button"
                  className={styles.indexAddButton}
                  onClick={openCreateForm}
                >
                  ＋ 인덱스 추가
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className={styles.header}>
              <div className={styles.titleRow}>
                <h1 className={styles.title}>검색엔진 대시보드</h1>
                <div className={styles.metaActions}>
                  <button
                    type="button"
                    className={styles.refreshButton}
                    onClick={openCreateForm}
                  >
                    인덱스 설정 추가
                  </button>
                  <button
                    type="button"
                    className={styles.refreshButton}
                    onClick={handleRefresh}
                    disabled={loading}
                  >
                    {loading ? '조회 중...' : '새로고침'}
                  </button>
                </div>
              </div>
              <p className={styles.subtitle}>
                SQLite 직접 조회 및 Elasticsearch 색인 상태를 관리합니다.
              </p>
              <div className={styles.metaRow}>
                <span>마지막 새로고침: {lastRefreshedAt || '-'}</span>
              </div>
            </header>
            {errorMessage && (
              <div className={styles.errorBanner} role="alert">
                {errorMessage}
              </div>
            )}
          </>
        )}
        {isIndexManagementPage ? (
          <section
            id="index-management-panel"
            className={styles.indexManagementCard}
          >
            <div className={styles.indexManagementTableWrapper}>
              <table className={styles.indexManagementTable}>
                <thead>
                  <tr>
                    <th>인덱스명 / 대상</th>
                    <th>문서수</th>
                    <th>주기 (CRONTAB)</th>
                    <th>상태</th>
                    <th>수동색인</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {environmentConfigs.length === 0 && (
                    <tr>
                      <td colSpan={6} className={styles.empty}>
                        등록된 인덱스 설정이 없습니다.
                      </td>
                    </tr>
                  )}
                  {environmentConfigs.map((config) => {
                    const indices = getAliasTargetIndices(
                      envSummary?.indices || [],
                      config.indexName,
                    );
                    const docs = indices.reduce(
                      (sum, index) => sum + index.docsCount,
                      0,
                    );
                    const configJobs = (data?.recentJobs || []).filter(
                      (job) =>
                        job.configId === config.id ||
                        (!job.configId &&
                          job.environment === config.environment &&
                          (job.targetIndices || []).some(
                            (indexName) =>
                              indexName === config.indexName ||
                              indexName.startsWith(`${config.indexName}-`),
                          )),
                    );
                    const activeJob = activeJobs.find(
                      (job) =>
                        job.configId === config.id ||
                        (!job.configId &&
                          job.environment === config.environment),
                    );
                    const completedJob = configJobs.find(
                      (job) =>
                        (job.status === 'succeeded' ||
                          job.status === 'failed' ||
                          job.status === 'cancelled') &&
                        job.finishedAt,
                    );
                    const capability = envSummary?.capabilities;
                    return (
                      <tr key={config.id}>
                        <td>
                          <div className={styles.managedIndexIdentity}>
                            <strong>{config.indexName}{config.displayName ? ` (${config.displayName})` : ''}</strong>
                            <span>{config.displayName} 검색용 인덱스</span>
                          </div>
                        </td>
                        <td className={styles.managedIndexDocs}>
                          {docs.toLocaleString()}
                        </td>
                        <td>
                          <div className={styles.managedSchedules}>
                            <span>
                              전체 <code>{config.fullSchedule}</code>
                              <small>
                                {config.fullEnabled ? '실행' : '중지'}
                              </small>
                            </span>
                            <span>
                              증분 <code>{config.syncSchedule || '-'}</code>
                              <small>
                                {config.syncEnabled ? '실행' : '중지'}
                              </small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className={styles.managedStatus}>
                            <span
                              className={`${styles.indexStatus} ${activeJob?.status === 'running' ? styles.indexStatusRunning : activeJob?.status === 'queued' ? styles.indexStatusQueued : completedJob?.status === 'failed' ? styles.indexStatusFailed : completedJob?.status === 'cancelled' ? styles.indexStatusCancelled : styles.indexStatusCompleted}`}
                            >
                              {activeJob?.status === 'running'
                                ? '색인 중'
                                : activeJob?.status === 'queued'
                                  ? '대기'
                                  : completedJob?.status === 'failed'
                                    ? '실패'
                                    : completedJob?.status === 'cancelled'
                                      ? '중지됨'
                                      : '완료'}
                            </span>
                            {activeJob?.status === 'running' && (
                              <small>
                                {formatTableDateTime(
                                  activeJob.startedAt || activeJob.createdAt,
                                )}{' '}
                                ~
                              </small>
                            )}
                            {activeJob && (
                              <button
                                type="button"
                                className={styles.cancelJobButton}
                                disabled={
                                  cancelPendingJobId === activeJob.id ||
                                  Boolean(activeJob.cancelRequestedAt)
                                }
                                onClick={() => void cancelJob(activeJob)}
                              >
                                {cancelPendingJobId === activeJob.id ||
                                activeJob.cancelRequestedAt
                                  ? '중지 요청 중...'
                                  : activeJob.status === 'running'
                                    ? '강제중지'
                                    : '대기취소'}
                              </button>
                            )}
                            {!activeJob && completedJob && (
                              <small>
                                {formatTableDateTime(
                                  completedJob.startedAt ||
                                    completedJob.createdAt,
                                )}{' '}
                                ~ {formatTableDateTime(completedJob.finishedAt)}
                                <br />
                                (총{' '}
                                {formatDuration(
                                  completedJob.startedAt ||
                                    completedJob.createdAt,
                                  completedJob.finishedAt,
                                )}{' '}
                                소요)
                              </small>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className={styles.managedManualActions}>
                            <button
                              type="button"
                              disabled={
                                Boolean(activeJob) ||
                                actionLoading ||
                                !capability?.full.enabled
                              }
                              onClick={() =>
                                setConfirmDialog({
                                  configId: config.id,
                                  indexName: config.indexName,
                                  environment: config.environment,
                                  operation: 'full',
                                })
                              }
                            >
                              전체
                            </button>
                            <button
                              type="button"
                              disabled={
                                Boolean(activeJob) ||
                                actionLoading ||
                                !config.addQuery ||
                                !config.deleteQuery ||
                                !capability?.sync.enabled
                              }
                              onClick={() =>
                                setConfirmDialog({
                                  configId: config.id,
                                  indexName: config.indexName,
                                  environment: config.environment,
                                  operation: 'sync',
                                })
                              }
                            >
                              증분
                            </button>
                            <button
                              type="button"
                              className={styles.managedAliasButton}
                              disabled={Boolean(activeJob) || actionLoading}
                              onClick={() => void switchLatestAlias(config)}
                            >
                              최신 알리아스
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className={styles.managedChangeActions}>
                            <button
                              type="button"
                              title="수정"
                              aria-label={`${config.indexName} 수정`}
                              onClick={() => openEditForm(config)}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="m14.69 6.32 3 3L8.5 18.5H5.5v-3l9.19-9.18ZM17 4l3 3-1.31 1.31-3-3L17 4ZM4 20h16v2H4v-2Z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              title="삭제"
                              aria-label={`${config.indexName} 삭제`}
                              onClick={() => void deleteConfig(config)}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M7 21a2 2 0 0 1-2-2V6h14v13a2 2 0 0 1-2 2H7Zm10-13H7v11h10V8Zm-7 2h2v7h-2v-7Zm4 0h2v7h-2v-7ZM8 3h8l1 1h3v2H4V4h3l1-1Z" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className={styles.tabPanel}>
            <div className={styles.indexGroupList}>
              {environmentConfigs.length === 0 && (
                <div className={styles.empty}>
                  등록된 인덱스 설정이 없습니다.
                </div>
              )}
              {environmentConfigs.map((config) => {
                const indices = getAliasTargetIndices(
                  envSummary?.indices || [],
                  config.indexName,
                );
                const docs = indices.reduce(
                  (sum, index) => sum + index.docsCount,
                  0,
                );
                const configJobs = (data?.recentJobs || []).filter(
                  (job) =>
                    job.configId === config.id ||
                    (!job.configId &&
                      job.environment === config.environment &&
                      (job.targetIndices || []).some(
                        (indexName) =>
                          indexName === config.indexName ||
                          indexName.startsWith(`${config.indexName}-`),
                      )),
                );
                const activeJob = activeJobs.find(
                  (job) =>
                    job.configId === config.id ||
                    (!job.configId && job.environment === config.environment),
                );
                const completedJob = configJobs.find(
                  (job) =>
                    (job.status === 'succeeded' ||
                      job.status === 'failed' ||
                      job.status === 'cancelled') &&
                    job.finishedAt,
                );
                const capability = envSummary?.capabilities;
                return (
                  <div key={config.id} className={styles.indexTableCard}>
                    <div className={styles.indexTableWrapper}>
                      <table className={styles.indexTable}>
                        <thead>
                          <tr>
                            <th>항목</th>
                            <th>인덱스</th>
                            <th>문서 수</th>
                            <th>용량</th>
                            <th>상태</th>
                            <th>수동색인</th>
                            <th>변경</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <th rowSpan={2} className={styles.indexItemCell}>
                              {config.displayName}
                            </th>
                            <td className={styles.indexNameCell}>
                              {config.indexName}
                            </td>
                            <td>{docs.toLocaleString()}</td>
                            <td>{indices[0]?.storeSize || '0 B'}</td>
                            <td>
                              <div className={styles.indexStatusCell}>
                                <span
                                  className={`${styles.indexStatus} ${activeJob?.status === 'running' ? styles.indexStatusRunning : activeJob?.status === 'queued' ? styles.indexStatusQueued : completedJob?.status === 'failed' ? styles.indexStatusFailed : completedJob?.status === 'cancelled' ? styles.indexStatusCancelled : styles.indexStatusCompleted}`}
                                >
                                  {activeJob?.status === 'running'
                                    ? '색인 중'
                                    : activeJob?.status === 'queued'
                                      ? '대기'
                                      : completedJob?.status === 'failed'
                                        ? '실패'
                                        : completedJob?.status === 'cancelled'
                                          ? '중지됨'
                                          : '완료'}
                                </span>
                                {activeJob?.status === 'running' && (
                                  <span className={styles.indexStatusTime}>
                                    (시작시간{' '}
                                    {formatTableDateTime(
                                      activeJob.startedAt ||
                                        activeJob.createdAt,
                                    )}{' '}
                                    ~)
                                  </span>
                                )}
                                {activeJob && (
                                  <button
                                    type="button"
                                    className={styles.cancelJobButton}
                                    disabled={
                                      cancelPendingJobId === activeJob.id ||
                                      Boolean(activeJob.cancelRequestedAt)
                                    }
                                    onClick={() => void cancelJob(activeJob)}
                                  >
                                    {cancelPendingJobId === activeJob.id ||
                                    activeJob.cancelRequestedAt
                                      ? '중지 요청 중...'
                                      : activeJob.status === 'running'
                                        ? '강제중지'
                                        : '대기취소'}
                                  </button>
                                )}
                                {!activeJob && completedJob && (
                                  <span className={styles.indexStatusTime}>
                                    (완료시간{' '}
                                    {formatTableDateTime(
                                      completedJob.startedAt ||
                                        completedJob.createdAt,
                                    )}{' '}
                                    ~{' '}
                                    {formatTableDateTime(
                                      completedJob.finishedAt,
                                    )}{' '}
                                    / 총{' '}
                                    {formatDuration(
                                      completedJob.startedAt ||
                                        completedJob.createdAt,
                                      completedJob.finishedAt,
                                    )}{' '}
                                    소요)
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <div className={styles.indexActionButtons}>
                                <button
                                  type="button"
                                  className={`${styles.actionButton} ${styles.btnFull}`}
                                  disabled={
                                    Boolean(activeJob) ||
                                    actionLoading ||
                                    !capability?.full.enabled
                                  }
                                  onClick={() =>
                                    setConfirmDialog({
                                      configId: config.id,
                                      indexName: config.indexName,
                                      environment: config.environment,
                                      operation: 'full',
                                    })
                                  }
                                >
                                  전체색인
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.actionButton} ${styles.btnAdd}`}
                                  disabled={
                                    Boolean(activeJob) ||
                                    actionLoading ||
                                    !config.addQuery ||
                                    !config.deleteQuery ||
                                    !capability?.sync.enabled
                                  }
                                  onClick={() =>
                                    setConfirmDialog({
                                      configId: config.id,
                                      indexName: config.indexName,
                                      environment: config.environment,
                                      operation: 'sync',
                                    })
                                  }
                                >
                                  추가색인
                                </button>
                              </div>
                            </td>
                            <td>
                              <div className={styles.indexChangeButtons}>
                                <button
                                  type="button"
                                  className={styles.refreshButton}
                                  onClick={() => openEditForm(config)}
                                >
                                  수정
                                </button>
                                <button
                                  type="button"
                                  className={styles.logoutButton}
                                  onClick={() => void deleteConfig(config)}
                                >
                                  삭제
                                </button>
                              </div>
                            </td>
                          </tr>
                          <tr>
                            <td
                              colSpan={6}
                              className={styles.indexScheduleCell}
                            >
                              전체 색인 <strong>{config.fullSchedule}</strong> (
                              {config.fullEnabled ? '실행' : '중지'}){' · '}
                              증분/삭제{' '}
                              <strong>{config.syncSchedule || '-'}</strong> (
                              {config.syncEnabled ? '실행' : '중지'})
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <section className={styles.section}>
          <div className={styles.historyHeader}>
            <div>
              <h2 className={styles.sectionTitle}>최근 색인 실행 이력</h2>
              <p className={styles.sectionSubtitle}>
                {getEnvironmentLabel(selectedEnv)} 환경의 최근 작업을{' '}
                {historyPageSize}건씩 조회합니다.
              </p>
            </div>
            <span className={styles.historyCount}>
              총 {filteredHistory.length.toLocaleString()}건
            </span>
          </div>
          <div className={styles.historyFilters}>
            <label className={styles.historyFilterField}>
              <span>날짜</span>
              <input
                type="date"
                value={historyDate}
                onChange={(event) => {
                  setHistoryDate(event.target.value);
                  setHistoryPage(1);
                }}
              />
            </label>
            <label className={styles.historyFilterField}>
              <span>상태</span>
              <select
                value={historyStatus}
                onChange={(event) => {
                  setHistoryStatus(event.target.value as '' | HistoryStatus);
                  setHistoryPage(1);
                }}
              >
                <option value="">전체</option>
                <option value="running">색인 중</option>
                <option value="succeeded">성공</option>
                <option value="failed">실패</option>
                <option value="queued">대기</option>
                <option value="cancelled">중지됨</option>
              </select>
            </label>
            <label className={styles.historyFilterField}>
              <span>자동/수동</span>
              <select
                value={historyTrigger}
                onChange={(event) => {
                  setHistoryTrigger(
                    event.target.value as '' | 'auto' | 'manual',
                  );
                  setHistoryPage(1);
                }}
              >
                <option value="">전체</option>
                <option value="auto">자동</option>
                <option value="manual">수동</option>
              </select>
            </label>
            <label
              className={`${styles.historyFilterField} ${styles.historyTargetFilter}`}
            >
              <span>대상 인덱스</span>
              <input
                type="search"
                value={historyTarget}
                onChange={(event) => {
                  setHistoryTarget(event.target.value);
                  setHistoryPage(1);
                }}
              />
            </label>
          </div>
          <div className={styles.tableWrapper}>
            <table className={`${styles.table} ${styles.historyGrid}`}>
              <thead>
                <tr>
                  <th>실행 시간</th>
                  <th>환경</th>
                  <th>작업</th>
                  <th>자동/수동</th>
                  <th>상태</th>
                  <th>요청자</th>
                  <th>처리 이벤트 수</th>
                  <th>대상 인덱스</th>
                  <th>단계</th>
                  <th className={styles.historyErrorColumn}>오류 / 비고</th>
                </tr>
              </thead>
              <tbody>
                {pagedHistory.length ? (
                  pagedHistory.map((job: IndexingJobDoc) => (
                    <tr key={job.id}>
                      <td className={styles.historyTimeCell}>
                        <span className={styles.historyTimeLine}>
                          <span className={styles.historyTimeLabel}>시작</span>
                          {formatDateTime(job.startedAt)}
                        </span>
                        <span className={styles.historyTimeLine}>
                          <span className={styles.historyTimeLabel}>종료</span>
                          {formatDateTime(job.finishedAt)}
                        </span>
                      </td>
                      <td>{getEnvironmentLabel(job.environment)}</td>
                      <td>{getOperationLabel(job.operation)}</td>
                      <td>{job.trigger === 'auto' ? '자동' : '수동'}</td>
                      <td>
                        <span
                          className={`${styles.badge} ${styles[`status_${job.status}`]}`}
                        >
                          {getStatusLabel(job.status as HistoryStatus)}
                        </span>
                      </td>
                      <td>{job.requester}</td>
                      <td>
                        {job.operation === 'sync' &&
                        job.resultCount !== undefined
                          ? `${job.resultCount.toLocaleString()}건 (증분 ${(job.addResultCount || 0).toLocaleString()} / 삭제 ${(job.deleteResultCount || 0).toLocaleString()})`
                          : job.resultCount !== undefined
                            ? `${job.resultCount.toLocaleString()}건`
                            : '-'}
                      </td>
                      <td>
                        {job.targetIndices?.join(', ') || job.indexName || '-'}
                      </td>
                      <td>
                        {job.operation === 'full' || job.operation === 'sync' ? (
                          <button
                            type="button"
                            className={styles.phaseButton}
                            onClick={() => setTimingJob(job)}
                          >
                            {getPhaseButtonLabel(job)}
                          </button>
                        ) : '-'}
                      </td>
                      <td
                        className={`${styles.historyErrorColumn} ${styles.errorCell}`}
                      >
                        {job.errorMessage || '-'}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className={styles.empty}>
                      검색 조건에 해당하는 이력이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <nav className={styles.pagination}>
            <button
              type="button"
              disabled={currentHistoryPage === 1}
              onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
            >
              이전
            </button>
            <span>
              {currentHistoryPage} / {historyPages}
            </span>
            <button
              type="button"
              disabled={currentHistoryPage === historyPages}
              onClick={() =>
                setHistoryPage((page) => Math.min(historyPages, page + 1))
              }
            >
              다음
            </button>
          </nav>
        </section>

        {timingJob && (
          <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="phase-timing-title">
            <div className={`${styles.modalContent} ${styles.phaseTimingModal}`}>
              <header className={styles.phaseTimingHeader}>
                <div>
                  <h3 id="phase-timing-title">
                    {timingJob.operation === 'sync' ? '추가색인 단계별 소요 시간' : '전체 색인 단계별 소요 시간'}
                  </h3>
                  <p>{timingJob.targetIndices?.join(', ') || timingJob.indexName || '-'}</p>
                </div>
                <button type="button" aria-label="닫기" onClick={() => setTimingJob(null)}>×</button>
              </header>
              <div className={styles.phaseTimingList}>
                <div><strong>현재 상태</strong><span>{getPhaseButtonLabel(timingJob)}</span></div>
                {timingJob.operation === 'sync' ? (
                  <>
                    <div><strong>추가 DB 조회</strong><span>{formatMilliseconds(timingJob.addDbDurationMs)}</span></div>
                    <div className={styles.phaseTimingSub}><strong>추가 DB 상세</strong><span>연결 {formatMilliseconds(timingJob.addDbConnectDurationMs)} · 실행 {formatMilliseconds(timingJob.addDbExecuteDurationMs)} · Fetch {formatMilliseconds(timingJob.addDbFetchDurationMs)}</span></div>
                    <div><strong>추가 Elasticsearch 저장</strong><span>{formatMilliseconds(timingJob.addEsBulkDurationMs)}</span></div>
                    <div><strong>추가 임베딩</strong><span>{formatMilliseconds(timingJob.addEmbeddingDurationMs)} · {(timingJob.addEmbeddingProcessedCount || 0).toLocaleString()}/{(timingJob.addEmbeddingTargetCount || 0).toLocaleString()}건 처리</span></div>
                    <div className={styles.phaseTimingSub}><strong>벡터 처리</strong><span>재사용 {(timingJob.addReusedVectorCount || 0).toLocaleString()}건 · 신규 생성 {(timingJob.addGeneratedVectorCount || 0).toLocaleString()}건</span></div>
                    <div><strong>삭제 DB 조회</strong><span>{formatMilliseconds(timingJob.deleteDbDurationMs)}</span></div>
                    <div className={styles.phaseTimingSub}><strong>삭제 DB 상세</strong><span>연결 {formatMilliseconds(timingJob.deleteDbConnectDurationMs)} · 실행 {formatMilliseconds(timingJob.deleteDbExecuteDurationMs)} · Fetch {formatMilliseconds(timingJob.deleteDbFetchDurationMs)}</span></div>
                    <div><strong>삭제 Elasticsearch 반영</strong><span>{formatMilliseconds(timingJob.deleteEsBulkDurationMs)}</span></div>
                  </>
                ) : (
                  <>
                    <div><strong>DB 조회</strong><span>{formatMilliseconds(timingJob.dbDurationMs)}</span></div>
                    <div className={styles.phaseTimingSub}><strong>DB 상세</strong><span>연결 {formatMilliseconds(timingJob.dbConnectDurationMs)} · 실행 {formatMilliseconds(timingJob.dbExecuteDurationMs)} · Fetch {formatMilliseconds(timingJob.dbFetchDurationMs)}</span></div>
                    <div><strong>Elasticsearch 저장</strong><span>{formatMilliseconds(timingJob.esBulkDurationMs)}</span></div>
                    <div><strong>임베딩</strong><span>{formatMilliseconds(timingJob.embeddingDurationMs)}{timingJob.embeddingProcessedCount !== undefined ? ` · ${timingJob.embeddingProcessedCount.toLocaleString()}${timingJob.embeddingTargetCount ? `/${timingJob.embeddingTargetCount.toLocaleString()}` : ''}건 처리` : ''}</span></div>
                    <div className={styles.phaseTimingSub}><strong>벡터 처리</strong><span>재사용 {(timingJob.reusedVectorCount || 0).toLocaleString()}건 · 신규 생성 {(timingJob.generatedVectorCount ?? timingJob.vectorizedCount ?? 0).toLocaleString()}건</span></div>
                    <div><strong>알리아스 변경</strong><span>{formatMilliseconds(timingJob.aliasDurationMs)}</span></div>
                  </>
                )}
              </div>
              <footer className={styles.phaseTimingActions}>
                <button type="button" onClick={() => setTimingJob(null)}>닫기</button>
              </footer>
            </div>
          </div>
        )}

        {formOpen && (
          <div className={styles.modalOverlay} role="dialog" aria-modal="true">
            <div className={`${styles.modalContent} ${styles.configModal}`}>
              <header className={styles.configModalHeader}>
                <div>
                  <h3>{editingId ? '인덱스 설정 수정' : '인덱스 설정 추가'}</h3>
                  <p>
                    색인 대상, 실행 주기, SQLite 조회 SQL과 Elasticsearch 템플릿을 관리합니다.
                  </p>
                  {formErrorMessage && (
                    <div className={styles.configModalError} role="alert">
                      {formErrorMessage}
                    </div>
                  )}
                </div>
                <div className={styles.modalFixedActions}>
                  <button
                    type="button"
                    className={styles.modalCancelButton}
                    onClick={() => setFormOpen(false)}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    className={styles.modalSaveButton}
                    disabled={formSaving}
                    onClick={() => void saveConfig()}
                  >
                    {formSaving ? '저장 중...' : '저장'}
                  </button>
                </div>
              </header>

              <section className={styles.configSection}>
                <div className={styles.configSectionHeader}>
                  <span className={styles.configSectionNumber}>1</span>
                  <div>
                    <h4>기본 정보</h4>
                    <p>인덱스와 문서를 식별하는 기본값입니다.</p>
                  </div>
                </div>
                <div className={styles.configFieldGrid}>
                  <label className={styles.configField}>
                    <span>환경</span>
                    <select
                      value={form.environment}
                      disabled={Boolean(editingId)}
                      onChange={(event) =>
                        (() => {
                          const environment = event.target.value as IndexingEnvironment;
                          const indexName = `${environment}-`;
                          setForm({ ...form, environment, indexName });
                          void loadTemplate(indexName, environment);
                        })()
                      }
                    >
                      <option value="prd">운영</option>
                      <option value="dev">개발</option>
                    </select>
                  </label>
                  <label className={styles.configField}>
                    <span>항목명</span>
                    <input
                      value={form.displayName}
                      onChange={(event) =>
                        setForm({ ...form, displayName: event.target.value })
                      }
                    />
                  </label>
                  <label className={styles.configField}>
                    <span>인덱스명</span>
                    <input
                      value={form.indexName}
                      onChange={(event) =>
                        setForm({ ...form, indexName: event.target.value })
                      }
                      onBlur={() => {
                        if (form.indexName && templateDraft?.targetIndex !== form.indexName) {
                          void loadTemplate(form.indexName, form.environment);
                        }
                      }}
                    />
                  </label>
                  <label className={styles.configField}>
                    <span>문서 ID 컬럼</span>
                    <input
                      value={form.documentIdColumn}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          documentIdColumn: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              </section>

              <section className={styles.configSection}>
                <div className={styles.configSectionHeader}>
                  <span className={styles.configSectionNumber}>2</span>
                  <div>
                    <h4>전체 색인</h4>
                    <p>전체 데이터를 새 인덱스로 생성하는 작업입니다.</p>
                  </div>
                </div>
                <div className={styles.scheduleSettingRow}>
                  <label className={styles.configField}>
                    <span>실행 주기</span>
                    <input
                      value={form.fullSchedule}
                      onChange={(event) =>
                        setForm({ ...form, fullSchedule: event.target.value })
                      }
                    />
                  </label>
                  <label className={styles.toggleField}>
                    <input
                      type="checkbox"
                      checked={form.fullEnabled}
                      onChange={(event) =>
                        setForm({ ...form, fullEnabled: event.target.checked })
                      }
                    />
                    <span>전체 자동 색인 실행</span>
                  </label>
                </div>
                <label className={styles.toggleField}>
                  <input
                    type="checkbox"
                    checked={form.autoRegisterDictionary !== false}
                    onChange={(event) => setForm({ ...form, autoRegisterDictionary: event.target.checked })}
                  />
                  <span>브랜드/카테고리명 사전 자동등록</span>
                </label>
                <p>전체색인 전 원본 SQL의 브랜드·카테고리를 조회해 사용자 사전에 추가합니다. 수동 등록 단어와 분해 규칙은 유지됩니다.</p>
                <label className={styles.sqlField}>
                  <span>전체 색인 SQL</span>
                  <textarea
                    value={form.fullQuery}
                    onChange={(event) =>
                      setForm({ ...form, fullQuery: event.target.value })
                    }
                  />
                </label>
              </section>

              <section className={styles.configSection}>
                <div className={styles.configSectionHeader}>
                  <span className={styles.configSectionNumber}>3</span>
                  <div>
                    <h4>추가 색인</h4>
                    <p>
                      변경 상품을 추가하고 색인 제외 상품을 삭제하는 작업입니다.
                    </p>
                  </div>
                </div>
                <div className={styles.scheduleSettingRow}>
                  <label className={styles.configField}>
                    <span>실행 주기</span>
                    <input
                      value={form.syncSchedule || ''}
                      onChange={(event) =>
                        setForm({ ...form, syncSchedule: event.target.value })
                      }
                    />
                  </label>
                  <label className={styles.toggleField}>
                    <input
                      type="checkbox"
                      checked={form.syncEnabled}
                      onChange={(event) =>
                        setForm({ ...form, syncEnabled: event.target.checked })
                      }
                    />
                    <span>추가 자동 색인 실행</span>
                  </label>
                </div>
                <label className={styles.sqlField}>
                  <span>증분 색인 SQL</span>
                  <textarea
                    value={form.addQuery || ''}
                    onChange={(event) =>
                      setForm({ ...form, addQuery: event.target.value })
                    }
                  />
                </label>
                <label className={styles.sqlField}>
                  <span>삭제 색인 SQL</span>
                  <textarea
                    value={form.deleteQuery || ''}
                    onChange={(event) =>
                      setForm({ ...form, deleteQuery: event.target.value })
                    }
                  />
                </label>
              </section>

              <section className={styles.configSection}>
                <div className={styles.configSectionHeader}>
                  <span className={styles.configSectionNumber}>4</span>
                  <div>
                    <h4>템플릿</h4>
                    <p>전체색인으로 새 인덱스를 만들 때 적용할 Elasticsearch 설정과 매핑입니다.</p>
                  </div>
                </div>
                {templateDraft?.loading && <p className={styles.templateStatus}>연결된 템플릿을 불러오는 중입니다.</p>}
                {!templateDraft?.loading && templateDraft && <>
                  <div className={styles.configFieldGrid}>
                    <label className={styles.configField}>
                      <span>템플릿명</span>
                      <input value={templateDraft.name} readOnly />
                    </label>
                    <label className={styles.configField}>
                      <span>적용 패턴</span>
                      <input value={`${templateDraft.targetIndex}-*`} readOnly />
                    </label>
                  </div>
                  <label className={styles.templateField}>
                    <span>템플릿 JSON</span>
                    <textarea
                      key={`${templateDraft.name}-${templateDraft.targetIndex}`}
                      ref={templateBodyRef}
                      defaultValue={templateDraft.bodyText}
                      spellCheck={false}
                    />
                  </label>
                  <p className={styles.templateHelp}>저장 시 Elasticsearch 시뮬레이션 검증을 통과해야 반영됩니다. 템플릿 변경은 기존 인덱스가 아니라 이후 생성되는 날짜 인덱스부터 적용됩니다.</p>
                </>}
                {!templateDraft && <p className={styles.templateStatus}>템플릿 정보를 불러오지 못했습니다.</p>}
              </section>
            </div>
          </div>
        )}

        {confirmDialog && (
          <div className={styles.modalOverlay} role="dialog" aria-modal="true">
            <div className={styles.modalContent}>
              <h3>{getOperationLabel(confirmDialog.operation)} 실행 확인</h3>
              <p>
                {getEnvironmentLabel(confirmDialog.environment)} 인덱스{' '}
                <strong>{confirmDialog.indexName}</strong>의 색인을
                실행하시겠습니까?
              </p>
              <div
                style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
              >
                <button
                  type="button"
                  className={styles.refreshButton}
                  disabled={actionLoading}
                  onClick={() => setConfirmDialog(null)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className={styles.confirmPrimaryButton}
                  disabled={actionLoading}
                  onClick={() => void executeConfirmedJob()}
                >
                  {actionLoading ? '실행 중...' : '실행'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
