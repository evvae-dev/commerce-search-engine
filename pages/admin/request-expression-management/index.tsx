import type { GetServerSideProps } from 'next';
import { useEffect, useState } from 'react';

import Head from '../../../components/admin/admin-page-head';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import AdminLayout from '../../../components/layout/admin-layout';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type { RequestExpressionConfig } from '../../../service/search-dictionary-service';
import styles from '../dictionary.module.css';

type Props = { email: string };
type Target = { indexName: string; displayName: string; environment: 'dev' | 'prd' };
type Preview = { cleanedQuery: string; removedExpressions: string[] };
const endpoint = '/api/v1/admin/request-expression-config';
const examples = ['추천해줘', '추천해주세요', '추천 좀 해줘', '찾아줘', '찾아주세요', '보여줘', '보여주세요', '골라줘', '골라주세요', '알려줘', '알려주세요'];

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin ? { props: { email: admin.email } } : { redirect: { destination: '/login', permanent: false } };
};

export default function RequestExpressionManagementPage({ email }: Props) {
  const { environment } = useAdminWorkspace();
  const [selected, setSelected] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [config, setConfig] = useState<RequestExpressionConfig | null>(null);
  const [phrasesText, setPhrasesText] = useState('');
  const [text, setText] = useState('더울때 입을 모던리프옷좀 추천해줘');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const available = targets.filter((target) => target.environment === environment);
  const targetIndex = selected || getGoodsIndex(environment);
  const phrases = phrasesText.split('\n').map((line) => line.trim()).filter(Boolean);
  const dirty = Boolean(config && JSON.stringify(phrases) !== JSON.stringify(config.phrases));
  const disabled = busy || loading || !config || config.targetIndex !== targetIndex;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setConfig(null); setPreview(null); setError(''); setMessage('');
      try {
        const response = await fetch(`${endpoint}?targetIndex=${encodeURIComponent(targetIndex)}`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.errorMessage);
        if (!controller.signal.aborted) { setConfig(body.config); setPhrasesText(body.config.phrases.join('\n')); setTargets(body.targets); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '조회에 실패했습니다.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [targetIndex, reload]);

  const run = async (method: 'POST' | 'PUT') => {
    if (disabled) return;
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try {
      const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetIndex, phrases, text, revision: config.revision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage);
      if (method === 'POST') setPreview(body.preview);
      else {
        setConfig(body.config); setPhrasesText(body.config.phrases.join('\n'));
        setMessage('저장했습니다. 재색인은 필요하지 않습니다. 다른 서버 프로세스는 설정 캐시 만료 후 반영됩니다.');
      }
    } catch (e) { setError(e instanceof Error ? e.message : '요청에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  return <AdminLayout email={email}>
    <Head><title>요청 표현 관리 | 검색엔진 관리자</title></Head>
    <div className={styles.container}>
      <header className={styles.header}>
        <div><h1>요청 표현 관리</h1><p>등록 구문을 키워드 형태소 분석 전에 제거합니다. 일반 불용어와 별도로 관리합니다.</p></div>
        <div className={styles.actions}>
          <button disabled={busy || loading} onClick={() => {
            if (!dirty || window.confirm('저장하지 않은 내용을 버리고 다시 불러오시겠습니까?')) setReload((value) => value + 1);
          }}>새로고침</button>
          <button className={styles.primary} disabled={disabled || !dirty} onClick={() => void run('PUT')}>요청 표현 저장</button>
        </div>
      </header>
      {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}</div>}
      {message && <div role="status" className={styles.notice}>{message}</div>}
      <section className={styles.card}>
        <label>대상 인덱스
          <select className={styles.select} value={targetIndex} disabled={busy || loading} onChange={(event) => {
            if (!dirty || window.confirm('저장하지 않은 내용을 버리고 인덱스를 변경하시겠습니까?')) setSelected(event.target.value);
          }}>
            {!available.some((target) => target.indexName === targetIndex) && <option value={targetIndex}>{targetIndex}</option>}
            {available.map((target) => <option key={target.indexName} value={target.indexName}>{target.displayName} ({target.indexName})</option>)}
          </select>
        </label>
        {loading ? <p>불러오는 중...</p> : <>
          <div className={styles.cardHeader}><h2>등록 구문 ({phrases.length}개){dirty && ' · 저장하지 않은 변경 있음'}</h2>
            <button className={styles.secondary} disabled={disabled} onClick={() => { setPhrasesText([...new Set([...phrases, ...examples])].join('\n')); setPreview(null); }}>예시 구문 추가</button>
          </div>
          <p id="request-phrases-help">한 줄에 한 구문씩 입력하세요. 삭제할 구문은 지운 뒤 저장하세요. 예시 추가만으로는 저장되지 않습니다.</p>
          <textarea className={styles.message} aria-label="등록 요청 표현" aria-describedby="request-phrases-help" rows={12} value={phrasesText} disabled={disabled} onChange={(event) => { setPhrasesText(event.target.value); setPreview(null); }} spellCheck={false} placeholder={'추천해줘\n추천해주세요\n추천 좀 해줘'} />
          <p>검색어 내 위치와 관계없이 등록 구문을 제거합니다. 긴 구문을 우선하며, 영문 대소문자·전각 문자·연속 공백을 정규화합니다. 띄어쓰기 변형은 각각 등록하세요.</p>
          <p><code>추천해줘</code>를 등록해도 <code>추천</code>만 있는 검색어는 유지됩니다. 포괄적인 단어 대신 요청 구문을 등록하세요.</p>
        </>}
      </section>
      <section className={styles.card}>
        <div className={styles.cardHeader}><div><h2>구문 제거 미리보기</h2><p>입력 중인 구문으로 확인하며 저장하지 않습니다. 검색 필터·AI 확장·형태소 분석은 수행하지 않습니다.</p></div></div>
        <input className={styles.input} aria-label="미리보기 검색어" value={text} maxLength={500} disabled={busy} onChange={(event) => { setText(event.target.value); setPreview(null); }} />
        <button className={styles.add} disabled={disabled || !text.trim()} onClick={() => void run('POST')}>제거 결과 확인</button>
        {preview && <div role="status">
          <p>정제 검색어: <strong>{preview.cleanedQuery || '(검색어 없음 · 검색할 상품명을 입력해야 합니다)'}</strong></p>
          <p>제거한 요청 표현: {preview.removedExpressions.join(' · ') || '없음'}</p>
        </div>}
        <p>검색 시 원문의 금지어 검사는 유지됩니다. 벡터 검색에는 기존 의미 검색어를 사용하고, 키워드 검색에서 요청 표현을 제외합니다.</p>
      </section>
    </div>
  </AdminLayout>;
}
