import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import AdminLayout from '../../../components/layout/admin-layout';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type {
  SynonymConfig,
  SynonymRule,
} from '../../../service/search-dictionary-service';
import styles from '../dictionary.module.css';

interface Props {
  email: string;
}
interface Target {
  id: string;
  displayName: string;
  indexName: string;
  environment: 'prd' | 'dev';
}
export const getServerSideProps: GetServerSideProps<Props> = async (
  context,
) => {
  const admin = await getAdminPageSession(context);
  return admin
    ? { props: { email: admin.email } }
    : { redirect: { destination: '/login', permanent: false } };
};

function newRow(): SynonymRule {
  return {
    id: crypto.randomUUID(),
    mode: 'bidirectional',
    representative: '',
    terms: [],
    enabled: true,
  };
}
function configRows(config: SynonymConfig): SynonymRule[] {
  return config.rules.length ? config.rules : [newRow()];
}

export default function SynonymManagementPage({ email }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const { environment } = useAdminWorkspace();
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTargetIndex, setTargetIndex] = useState<string | null>(null);
  const [rows, setRows] = useState<SynonymRule[]>([newRow()]);
  const [revision, setRevision] = useState<{
    seqNo: number;
    primaryTerm: number;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const available = targets.filter(
    (target) => target.environment === environment,
  );
  const targetIndex = available.some(
    (target) => target.indexName === selectedTargetIndex,
  )
    ? selectedTargetIndex as string
    : getGoodsIndex(environment);
  const load = useCallback(async (index: string) => {
    setError('');
    try {
      const response = await fetch(
        `/api/v1/admin/synonym-config?targetIndex=${encodeURIComponent(index)}`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      setTargets(body.targets || []);
      setRows(configRows(body.config));
      setRevision(body.config.revision);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '동의어 설정 조회에 실패했습니다.',
      );
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(targetIndex);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, targetIndex]);
  const save = async () => {
    if (!formRef.current || !revision) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const data = new FormData(formRef.current);
      const rules = rows.map((row) => ({
        id: row.id,
        mode: data.get(`mode-${row.id}`) as SynonymRule['mode'],
        representative: String(data.get(`representative-${row.id}`) || ''),
        terms: String(data.get(`terms-${row.id}`) || '')
          .split(',')
          .map((term) => term.trim())
          .filter(Boolean),
        enabled: data.get(`enabled-${row.id}`) === 'on',
      }));
      const response = await fetch('/api/v1/admin/synonym-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetIndex, rules, revision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      setRows(configRows(body.config));
      setRevision(body.config.revision);
      setMessage('동의어 설정을 저장했습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <AdminLayout email={email}>
      <Head>
        <title>동의어/유의어 관리</title>
      </Head>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1>동의어/유의어 관리</h1>
            <p>검색어를 같은 의미의 대표어 또는 동의어로 확장합니다.</p>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              disabled={saving}
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
        <section id="synonym-panel" className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2>동의어 규칙</h2>
              <p>
                terms는 쉼표로 구분해 입력합니다. 양방향은 모든 단어를 서로
                확장하고, 단방향은 terms에서 대표어로 확장합니다.
              </p>
            </div>
          </div>
          <form ref={formRef}>
            <label>
              대상 인덱스
              <select
                className={styles.select}
                value={targetIndex}
                onChange={(event) => setTargetIndex(event.target.value)}
              >
                {available.map((target) => (
                  <option key={target.indexName} value={target.indexName}>
                    {target.displayName} ({target.indexName})
                  </option>
                ))}
              </select>
            </label>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>방향</th>
                  <th>대표어</th>
                  <th>동의어 terms</th>
                  <th>사용</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <select
                        className={styles.input}
                        name={`mode-${row.id}`}
                        defaultValue={row.mode}
                      >
                        <option value="bidirectional">양방향</option>
                        <option value="unidirectional">단방향</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className={styles.input}
                        name={`representative-${row.id}`}
                        defaultValue={row.representative}
                        maxLength={100}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.smallInput}
                        name={`terms-${row.id}`}
                        defaultValue={row.terms.join(', ')}
                        maxLength={2000}
                        placeholder="예: 반팔, 반소매"
                      />
                    </td>
                    <td className={styles.check}>
                      <label>
                        <input
                          type="checkbox"
                          name={`enabled-${row.id}`}
                          defaultChecked={row.enabled}
                        />
                        사용
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() =>
                          setRows((current) =>
                            current.filter((item) => item.id !== row.id),
                          )
                        }
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </form>
          <button
            type="button"
            className={styles.add}
            onClick={() => setRows((current) => [...current, newRow()])}
          >
            ＋ 규칙 추가
          </button>
        </section>
      </div>
    </AdminLayout>
  );
}
