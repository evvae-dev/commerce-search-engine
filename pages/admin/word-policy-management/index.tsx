import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import AdminLayout from '../../../components/layout/admin-layout';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type {
  ForbiddenWordRule,
  StopWordRule,
  WordPolicyConfig,
} from '../../../service/search-dictionary-service';
import styles from '../dictionary.module.css';

interface Props {
  email: string;
}
interface Target {
  indexName: string;
  displayName: string;
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
const newStop = (): StopWordRule => ({
  id: crypto.randomUUID(),
  term: '',
  enabled: true,
});
const newForbidden = (): ForbiddenWordRule => ({
  id: crypto.randomUUID(),
  term: '',
  matchType: 'token',
  action: 'block',
  message: '',
  enabled: true,
});

export default function WordPolicyManagementPage({ email }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const { environment } = useAdminWorkspace();
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTargetIndex, setTargetIndex] = useState<string | null>(null);
  const [stopRows, setStopRows] = useState<StopWordRule[]>([newStop()]);
  const [forbiddenRows, setForbiddenRows] = useState<ForbiddenWordRule[]>([
    newForbidden(),
  ]);
  const [revision, setRevision] = useState<{
    seqNo: number;
    primaryTerm: number;
  } | null>(null);
  const [tab, setTab] = useState<'stop' | 'forbidden'>('stop');
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
        `/api/v1/admin/word-policy-config?targetIndex=${encodeURIComponent(index)}`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      const config = body.config as WordPolicyConfig;
      setTargets(body.targets || []);
      setStopRows(config.stopWords.length ? config.stopWords : [newStop()]);
      setForbiddenRows(
        config.forbiddenWords.length ? config.forbiddenWords : [newForbidden()],
      );
      setRevision(config.revision);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '단어 정책 조회에 실패했습니다.',
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
      const stopWords = stopRows
        .map((row) => ({
          id: row.id,
          term: String(data.get(`stop-${row.id}`) || ''),
          enabled: data.get(`stop-enabled-${row.id}`) === 'on',
        }))
        .filter((row) => row.term.trim());
      const forbiddenWords = forbiddenRows
        .map((row) => ({
          id: row.id,
          term: String(data.get(`forbidden-${row.id}`) || ''),
          matchType: data.get(`match-${row.id}`),
          action: data.get(`action-${row.id}`),
          message: String(data.get(`message-${row.id}`) || ''),
          enabled: data.get(`forbidden-enabled-${row.id}`) === 'on',
        }))
        .filter((row) => row.term.trim() || row.message.trim());
      const response = await fetch('/api/v1/admin/word-policy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetIndex,
          stopWords,
          forbiddenWords,
          revision,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      setRevision(body.config.revision);
      setStopRows(
        body.config.stopWords.length ? body.config.stopWords : [newStop()],
      );
      setForbiddenRows(
        body.config.forbiddenWords.length
          ? body.config.forbiddenWords
          : [newForbidden()],
      );
      setMessage('단어 정책을 저장했습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <AdminLayout email={email}>
      <Head>
        <title>불용어/금지어 관리</title>
      </Head>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1>불용어/금지어 관리</h1>
            <p>검색 전 불용어 제거와 금지어 차단·경고 정책을 관리합니다.</p>
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
        <section id="word-policy-panel" className={styles.card}>
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
          <div className={styles.tabs}>
            <button
              type="button"
              className={tab === 'stop' ? styles.active : ''}
              onClick={() => setTab('stop')}
            >
              불용어
            </button>
            <button
              type="button"
              className={tab === 'forbidden' ? styles.active : ''}
              onClick={() => setTab('forbidden')}
            >
              금지어
            </button>
          </div>
          <form ref={formRef}>
            <div style={{ display: tab === 'stop' ? 'block' : 'none' }}>
              <div className={styles.cardHeader}>
                <div>
                  <h2>불용어</h2>
                  <p>분석 결과에서 제거할 토큰입니다.</p>
                </div>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>단어</th>
                    <th>사용</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {stopRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          className={styles.input}
                          name={`stop-${row.id}`}
                          defaultValue={row.term}
                          maxLength={100}
                        />
                      </td>
                      <td className={styles.check}>
                        <label>
                          <input
                            type="checkbox"
                            name={`stop-enabled-${row.id}`}
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
                            setStopRows((current) =>
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
              <button
                type="button"
                className={styles.add}
                onClick={() =>
                  setStopRows((current) => [...current, newStop()])
                }
              >
                ＋ 불용어 추가
              </button>
            </div>
            <div style={{ display: tab === 'forbidden' ? 'block' : 'none' }}>
              <div className={styles.cardHeader}>
                <div>
                  <h2>금지어</h2>
                  <p>
                    token은 분석 토큰 단위, phrase는 원문 구문으로 검사합니다.
                  </p>
                </div>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>단어/구문</th>
                    <th>검사</th>
                    <th>동작</th>
                    <th>메시지</th>
                    <th>사용</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {forbiddenRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          className={styles.input}
                          name={`forbidden-${row.id}`}
                          defaultValue={row.term}
                          maxLength={100}
                        />
                      </td>
                      <td>
                        <select
                          className={styles.input}
                          name={`match-${row.id}`}
                          defaultValue={row.matchType}
                        >
                          <option value="token">token</option>
                          <option value="phrase">phrase</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className={styles.input}
                          name={`action-${row.id}`}
                          defaultValue={row.action}
                        >
                          <option value="block">차단</option>
                          <option value="warn">경고</option>
                        </select>
                      </td>
                      <td>
                        <input
                          className={styles.message}
                          name={`message-${row.id}`}
                          defaultValue={row.message}
                          maxLength={200}
                          placeholder="사용자에게 표시할 안내"
                        />
                      </td>
                      <td className={styles.check}>
                        <label>
                          <input
                            type="checkbox"
                            name={`forbidden-enabled-${row.id}`}
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
                            setForbiddenRows((current) =>
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
              <button
                type="button"
                className={styles.add}
                onClick={() =>
                  setForbiddenRows((current) => [...current, newForbidden()])
                }
              >
                ＋ 금지어 추가
              </button>
            </div>
          </form>
        </section>
      </div>
    </AdminLayout>
  );
}
