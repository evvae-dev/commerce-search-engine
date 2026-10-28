import type { GetServerSideProps } from 'next';
import { useEffect, useState } from 'react';

import Head from '../../../components/admin/admin-page-head';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import AdminLayout from '../../../components/layout/admin-layout';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type { NoriDictionaryConfig, NoriDictionaryPreview } from '../../../service/nori-dictionary-service';
import styles from '../dictionary.module.css';
import local from './nori-dictionary.module.css';

type Props = { email: string };
type Target = { indexName: string; displayName: string; environment: 'dev' | 'prd' };
const endpoint = '/api/v1/admin/nori-dictionary';
const statusLabels = { applied: '저장된 사전 적용 완료', pending: '전체색인 후 적용 필요', unavailable: '현재 인덱스 없음 · 전체색인 필요' };

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin ? { props: { email: admin.email } } : { redirect: { destination: '/login', permanent: false } };
};

export default function NoriDictionaryManagementPage({ email }: Props) {
  const { environment } = useAdminWorkspace();
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState('');
  const [config, setConfig] = useState<NoriDictionaryConfig | null>(null);
  const [rulesText, setRulesText] = useState('');
  const [text, setText] = useState('더울때 입을 모던리프옷');
  const [preview, setPreview] = useState<NoriDictionaryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const available = targets.filter((target) => target.environment === environment);
  const targetIndex = available.some((target) => target.indexName === selected) ? selected : getGoodsIndex(environment);
  const rules = rulesText.split('\n').map((line) => line.trim()).filter(Boolean);
  const dirty = Boolean(config && JSON.stringify(rules) !== JSON.stringify(config.rules));

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      setTargets(body.targets);
    }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '인덱스 목록 조회에 실패했습니다.'); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(''); setMessage(''); setPreview(null); setConfig(null);
      try {
        const response = await fetch(`${endpoint}?targetIndex=${encodeURIComponent(targetIndex)}`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.errorMessage);
        if (!controller.signal.aborted) { setConfig(body.config); setRulesText(body.config.rules.join('\n')); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '사용자 사전 조회에 실패했습니다.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [targetIndex, reload]);

  const run = async (method: 'POST' | 'PUT') => {
    if (!config || config.targetIndex !== targetIndex) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetIndex, rules, revision: config.revision, text }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      if (method === 'POST') setPreview(body.preview);
      else {
        setConfig(body.config); setRulesText(body.config.rules.join('\n')); setPreview(null);
        setMessage('저장했습니다. 해당 인덱스의 전체색인이 완료되고 별칭이 전환되면 검색에 적용됩니다.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청에 실패했습니다.');
    } finally { setBusy(false); }
  };

  const refresh = () => {
    if (dirty && !window.confirm('저장하지 않은 내용을 버리고 다시 불러오시겠습니까?')) return;
    setReload((value) => value + 1);
  };
  const disabled = loading || busy || !config || config.targetIndex !== targetIndex;
  return <AdminLayout email={email}>
    <Head><title>사용자 사전 관리 | 검색엔진 관리자</title></Head>
    <div className={styles.container}>
      <header className={styles.header}>
        <div><h1>사용자 사전 관리</h1><p>브랜드명과 고유명사를 등록해 Nori가 하나의 단어로 인식하도록 합니다.</p></div>
        <div className={styles.actions}>
          <button disabled={busy || loading} onClick={refresh}>새로고침</button>
          <button className={styles.primary} disabled={disabled || !dirty} onClick={() => void run('PUT')}>{busy ? '처리 중...' : '사전 저장'}</button>
        </div>
      </header>
      {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}</div>}
      {message && <div role="status" className={styles.notice}>{message}</div>}
      <section className={styles.card}>
        <label>대상 인덱스
          <select className={styles.select} value={targetIndex} disabled={busy} onChange={(event) => {
            if (dirty && !window.confirm('저장하지 않은 내용을 버리고 인덱스를 변경하시겠습니까?')) return;
            setSelected(event.target.value);
          }}>
            {!available.some((target) => target.indexName === targetIndex) && <option value={targetIndex}>{targetIndex}</option>}
            {available.map((target) => <option key={target.indexName} value={target.indexName}>{target.displayName} ({target.indexName})</option>)}
          </select>
        </label>
        <div className={local.guidance}>저장한 사전은 다음 전체색인부터 적용됩니다. 추가색인만으로는 반영되지 않습니다.</div>
        {loading ? <p>불러오는 중...</p> : config?.targetIndex === targetIndex && <>
          <p className={local.status}>{statusLabels[config.applicationStatus]}{dirty && ' · 저장하지 않은 변경 있음'}</p>
          <label className={local.label} htmlFor="nori-rules">등록 단어 ({rules.length.toLocaleString('ko-KR')}개)</label>
          <p id="nori-rules-help" className={local.hint}>한 줄에 한 단어씩 입력하세요. 예: 모던리프, 스튜디오블룸, 데일리루프. 단어를 지우고 저장하면 사전에서 삭제됩니다.</p>
          <textarea id="nori-rules" aria-describedby="nori-rules-help" className={local.editor} rows={12} value={rulesText} disabled={busy} onChange={(event) => { setRulesText(event.target.value); setPreview(null); }} placeholder={'모던리프\n스튜디오블룸\n데일리루프'} spellCheck={false} />
          <p className={local.hint}>복합어를 나누려면 <code>세종시 세종 시</code>처럼 입력하세요. 브랜드명은 분해 단어 없이 입력하면 됩니다.</p>
        </>}
      </section>
      <section className={styles.card}>
        <div className={styles.cardHeader}><div><h2>형태소 분석 미리보기</h2><p>현재 검색과 입력 중인 사전의 분석 결과를 비교합니다. 미리보기는 저장하지 않습니다.</p></div></div>
        <div className={local.previewForm}>
          <input className={styles.input} aria-label="분석할 검색어" maxLength={500} value={text} disabled={busy} onChange={(event) => { setText(event.target.value); setPreview(null); }} />
          <button className={styles.secondary} disabled={disabled || !text.trim()} onClick={() => void run('POST')}>분석 비교</button>
        </div>
        {preview && <div className={local.comparison}>
          <div><h3>현재 검색</h3><p>{preview.current === null ? '현재 인덱스가 없습니다.' : preview.current.join(' · ') || '(토큰 없음)'}</p></div>
          <div><h3>입력한 사전 적용 후</h3><p>{preview.draft.join(' · ') || '(토큰 없음)'}</p></div>
        </div>}
      </section>
    </div>
  </AdminLayout>;
}
