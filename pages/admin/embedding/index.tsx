import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminPageActive, useAdminWorkspace } from '../../../components/admin/admin-workspace';
import { getAdminPageSession } from '../../../service/admin-auth';
import { getVectorField } from '../../../constant/vector-field.constant.mjs';
import { DEFAULT_GEO_QUERY, GEO_DB_FIELDS, GEO_PROPERTY_FIELDS, isGoodsGeoIndex } from '../../../scripts/geo-embedding-config.mjs';
import type {
  EmbeddingConfig,
  EmbeddingItem,
  IndexingConfig,
} from '../../../service/indexing-config-service';
import type { IndexingJobDoc } from '../../../service/indexing-job-service';
import styles from './embedding.module.css';

interface Props {
  email: string;
}
export const getServerSideProps: GetServerSideProps<Props> = async (
  context,
) => {
  const admin = await getAdminPageSession(context);
  if (!admin) return { redirect: { destination: '/login', permanent: false } };
  return { props: { email: admin.email } };
};

const emptyItem = (): EmbeddingItem => ({ label: '', fields: [] });
const geoItems = [
  ...GEO_DB_FIELDS.map((item) => ({ ...item, source: 'DB', field: item.fields.join(' / '), selection: 'dbFields' as const })),
  ...GEO_PROPERTY_FIELDS.map((item) => ({ ...item, source: 'GEO', field: item.name, selection: 'properties' as const })),
];

export default function EmbeddingPage({ email }: Props) {
  const [configs, setConfigs] = useState<IndexingConfig[]>([]);
  const { environment } = useAdminWorkspace();
  const pageActive = useAdminPageActive();
  const [configId, setConfigId] = useState('');
  const [loadedConfigId, setLoadedConfigId] = useState('');
  const loadRevision = useRef(0);
  const [form, setForm] = useState<EmbeddingConfig>({
    enabled: true,
    items: [],
  });
  const [fields, setFields] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [embeddingJob, setEmbeddingJob] = useState<IndexingJobDoc | null>(null);
  const [executionCapability, setExecutionCapability] = useState<{
    enabled: boolean;
    reason?: string;
  }>({ enabled: true });
  const environmentConfigs = configs.filter(
    (config) => config.environment === environment,
  );
  const selectedConfig =
    environmentConfigs.find((config) => config.id === configId) ||
    environmentConfigs.find((config) => isGoodsGeoIndex(config.indexName)) ||
    environmentConfigs[0];
  const formLoaded = Boolean(selectedConfig && loadedConfigId === selectedConfig.id);
  const loadConfig = useCallback(async (id: string) => {
    const revision = ++loadRevision.current;
    setLoadedConfigId('');
    setError('');
    try {
      const [configResponse, fieldsResponse] = await Promise.all([
        fetch(
          `/api/v1/admin/embedding/config?configId=${encodeURIComponent(id)}`,
        ),
        fetch(
          `/api/v1/admin/embedding/fields?configId=${encodeURIComponent(id)}`,
        ),
      ]);
      const configResult = await configResponse.json();
      const fieldsResult = await fieldsResponse.json();
      if (revision !== loadRevision.current) return;
      if (!configResponse.ok) throw new Error(configResult.errorMessage);
      setForm(configResult.embedding);
      setFields(fieldsResult.fields || []);
      setLoadedConfigId(id);
    } catch (e) {
      if (revision !== loadRevision.current) return;
      setError(
        e instanceof Error ? e.message : '임베딩 설정 조회에 실패했습니다.',
      );
    }
  }, []);
  useEffect(() => {
    fetch('/api/v1/admin/index-configs')
      .then((r) => r.json())
      .then((result) => setConfigs(result.configs || []))
      .catch(() => setError('인덱스 설정 조회에 실패했습니다.'));
  }, []);
  useEffect(() => {
    if (!selectedConfig) return undefined;
    const timer = window.setTimeout(() => {
      void loadConfig(selectedConfig.id);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      loadRevision.current += 1;
    };
  }, [loadConfig, selectedConfig]);
  useEffect(() => {
    if (!selectedConfig) return undefined;
    let cancelled = false;
    const refreshJob = async () => {
      if (!pageActive) return;
      const response = await fetch('/api/v1/admin/dashboard', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!cancelled) {
        setEmbeddingJob(
          (result.recentJobs || []).find(
            (job: IndexingJobDoc) =>
              job.configId === selectedConfig.id &&
              job.operation === 'embedding',
          ) || null,
        );
        setExecutionCapability(
          result.environments?.[selectedConfig.environment]?.capabilities
            ?.embedding || { enabled: true },
        );
      }
    };
    void refreshJob();
    const timer = window.setInterval(() => {
      void refreshJob();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pageActive, selectedConfig]);
  const preview = useMemo(
    () =>
      form.items
        .filter((item) => item.label && item.fields.length)
        .map((item) => `${item.label}: ${item.fields.join(' ')}`)
        .join('. ') + (form.items.length ? '.' : ''),
    [form.items],
  );
  const updateItem = (index: number, item: EmbeddingItem) =>
    setForm({
      ...form,
      items: form.items.map((current, currentIndex) =>
        currentIndex === index ? item : current,
      ),
    });
  const save = async () => {
    if (!selectedConfig || !formLoaded) return;
    const revision = loadRevision.current;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/admin/embedding/config?configId=${encodeURIComponent(selectedConfig.id)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(form),
        },
      );
      const result = await response.json();
      if (revision !== loadRevision.current) return;
      if (!response.ok) throw new Error(result.errorMessage);
      setForm(result.embedding);
      setMessage('임베딩 설정을 저장했습니다.');
    } catch (e) {
      if (revision !== loadRevision.current) return;
      setError(e instanceof Error ? e.message : '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };
  const run = async (mode: 'all' | 'changed') => {
    if (!selectedConfig || !formLoaded) return;
    if (
      mode === 'all' &&
      !window.confirm('전체 문서의 벡터를 다시 생성하시겠습니까?')
    )
      return;
    setRunning(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/v1/admin/dashboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          configId: selectedConfig.id,
          operation: 'embedding',
          embeddingMode: mode,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.errorMessage);
      setMessage(`임베딩 작업을 요청했습니다. (작업 ID: ${result.jobId})`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '임베딩 작업 요청에 실패했습니다.',
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <AdminLayout email={email}>
      <Head>
        <title>임베딩 관리</title>
      </Head>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1>임베딩 관리</h1>
            <p>인덱스별 임베딩 항목과 벡터 재생성 작업을 관리합니다.</p>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              disabled={saving || !formLoaded}
              onClick={() => void save()}
            >
              저장
            </button>
          </div>
        </header>
        {message && <div className={styles.notice}>{message}</div>}
        {error && (
          <div className={`${styles.notice} ${styles.error}`}>{error}</div>
        )}
        <section id="embedding-config-panel" className={styles.card}>
          <div className={styles.cardHeader}>
            <h2>임베딩 필드 설정</h2>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />{' '}
              임베딩 사용
            </label>
          </div>
          <label>
            대상 인덱스{' '}
            <select
              className={styles.select}
              value={selectedConfig?.id || ''}
              onChange={(e) => {
                setConfigId(e.target.value);
              }}
            >
              {environmentConfigs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.displayName} ({config.indexName})
                </option>
              ))}
            </select>
          </label>
          {isGoodsGeoIndex(selectedConfig?.indexName) ? (
            <div className={styles.geoConfig}>
              <label className={styles.toggle}>
                <input type="checkbox" checked={form.geo?.enabled ?? true} onChange={(e) => setForm({ ...form, geo: { ...form.geo, enabled: e.target.checked, query: form.geo?.query || DEFAULT_GEO_QUERY } })} />
                GEO 상품 속성 사용
              </label>
              <label htmlFor="geo-query">GEO 대상 상품 SQL (출력: GOODS_ID)</label>
              <textarea id="geo-query" value={form.geo?.query || DEFAULT_GEO_QUERY} onChange={(e) => setForm({ ...form, geo: { ...form.geo, enabled: form.geo?.enabled ?? true, query: e.target.value } })} />
              <p>GEO_VERSION IS NOT NULL, GEO_CONTENT IS NOT NULL, DEL_YN = &apos;N&apos; 조건은 실제 원본 조회에 항상 적용됩니다. SELECT 또는 WITH 문만 허용하며 바인드는 사용할 수 없습니다.</p>
              <p>GEO가 있는 상품은 아래에서 선택한 항목으로 조립합니다. GEO가 없거나 사용을 끄면 별도의 키워드 항목 설정을 사용합니다.</p>
              <p>설정을 바꾼 뒤 기존 문서에도 반영하려면 변경 문서 벡터화를 실행하세요.</p>
              <table className={styles.table}>
                <thead><tr><th>출처</th><th>항목명</th><th>원본 필드·속성</th><th>사용</th></tr></thead>
                <tbody>{geoItems.map((item) => {
                  const selected = form.geo?.[item.selection] ?? geoItems.filter((value) => value.selection === item.selection).map((value) => value.id);
                  return <tr key={`${item.source}-${item.id}`}>
                    <td>{item.source}</td><td>{item.label}</td><td>{item.field}</td>
                    <td><input type="checkbox" aria-label={`${item.source} ${item.label} 사용`} disabled={!formLoaded || saving} checked={selected.includes(item.id)} onChange={(e) => setForm({ ...form, geo: { ...form.geo, enabled: form.geo?.enabled ?? true, query: form.geo?.query || DEFAULT_GEO_QUERY, [item.selection]: e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id) } })} /></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          ) : <p>콘텐츠 인덱스에는 GEO 설정이 적용되지 않습니다.</p>}
          <h3>{isGoodsGeoIndex(selectedConfig?.indexName) ? 'GEO 부재·비활성 시 키워드 항목' : '키워드 임베딩 항목'}</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>항목명</th>
                <th>원본 필드(순서대로 결합)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.items.map((item, index) => (
                <tr key={index}>
                  <td>
                    <input
                      className={styles.labelInput}
                      value={item.label}
                      onChange={(e) =>
                        updateItem(index, { ...item, label: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <div className={styles.fieldList}>
                      {item.fields.map((field) => (
                        <span className={styles.field} key={field}>
                          {field}
                          <button
                            type="button"
                            className={styles.remove}
                            onClick={() =>
                              updateItem(index, {
                                ...item,
                                fields: item.fields.filter(
                                  (value) => value !== field,
                                ),
                              })
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <select
                      className={styles.select}
                      value=""
                      onChange={(e) => {
                        if (
                          e.target.value &&
                          !item.fields.includes(e.target.value)
                        )
                          updateItem(index, {
                            ...item,
                            fields: [...item.fields, e.target.value],
                          });
                      }}
                    >
                      <option value="">필드 추가</option>
                      {fields
                        .filter((field) => !item.fields.includes(field))
                        .map((field) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.deleteButton}
                      onClick={() =>
                        setForm({
                          ...form,
                          items: form.items.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className={styles.add}
            onClick={() =>
              setForm({ ...form, items: [...form.items, emptyItem()] })
            }
          >
            ＋ 항목 추가
          </button>
          {preview && <div className={styles.preview}>키워드 fallback 문장 미리보기: {preview}</div>}
        </section>
        <section className={styles.card} style={{ marginTop: 18 }}>
          <div className={styles.cardHeader}>
            <div>
              <h2>임베딩 수동 실행</h2>
              <p>현재 대상 인덱스의 문서에 {selectedConfig ? getVectorField(selectedConfig.indexName) : '벡터 필드'}를 생성합니다.</p>
              {!executionCapability.enabled && (
                <p className={styles.disabledReason}>
                  {executionCapability.reason}
                </p>
              )}
              {embeddingJob && (
                <p>
                  최근 상태:{' '}
                  <strong>
                    {embeddingJob.status === 'running'
                      ? '실행 중'
                      : embeddingJob.status === 'queued'
                        ? '대기'
                        : embeddingJob.status === 'succeeded'
                          ? '성공'
                          : embeddingJob.status === 'failed'
                            ? '실패'
                            : embeddingJob.status === 'cancelled'
                              ? '중지됨'
                              : '건너뜀'}
                  </strong>
                  {embeddingJob.resultCount !== undefined
                    ? ` · ${embeddingJob.resultCount.toLocaleString()}건`
                    : ''}
                  {embeddingJob.errorMessage
                    ? ` · ${embeddingJob.errorMessage}`
                    : ''}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <button
                disabled={
                  running || !formLoaded || !executionCapability.enabled
                }
                onClick={() => void run('changed')}
              >
                변경 문서 벡터화
              </button>
              <button
                className={styles.primary}
                disabled={
                  running || !formLoaded || !executionCapability.enabled
                }
                onClick={() => void run('all')}
              >
                전체 벡터 재생성
              </button>
            </div>
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
