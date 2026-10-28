import type { GetServerSideProps } from 'next';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import Head from '../../../components/admin/admin-page-head';
import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import { DEFAULT_PERSONALIZATION, type PersonalizationConfig } from '../../../service/personalization-config';
import type { SearchRankingRevision } from '../../../service/search-ranking-service';
import styles from './personalization.module.css';

export const getServerSideProps: GetServerSideProps<{ email: string }> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin ? { props: { email: admin.email } } : { redirect: { destination: '/login', permanent: false } };
};

const labels = { cart: '장바구니', recent: '최근 본 상품', wish: '관심상품', order: '주문' } as const;

export default function PersonalizationPage({ email }: { email: string }) {
  const { environment } = useAdminWorkspace();
  const targetIndex = getGoodsIndex(environment);
  const currentTargetIndexRef = useRef(targetIndex);
  const [config, setConfig] = useState<PersonalizationConfig>(DEFAULT_PERSONALIZATION);
  const [revision, setRevision] = useState<SearchRankingRevision | null>(null);
  const [loadedTargetIndex, setLoadedTargetIndex] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  useLayoutEffect(() => { currentTargetIndexRef.current = targetIndex; }, [targetIndex]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setLoading(true);
      setRevision(null);
      setLoadedTargetIndex(null);
      setStatus('');
      fetch(`/api/v1/admin/personalization?targetIndex=${encodeURIComponent(targetIndex)}`).then(async (response) => {
        const body = await response.json(); if (!response.ok) throw new Error(body.errorMessage);
        if (active) { setConfig(body.config); setRevision(body.revision); setLoadedTargetIndex(targetIndex); }
      }).catch((error) => { if (active) setStatus(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.'); }).finally(() => { if (active) setLoading(false); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [targetIndex]);
  const save = async () => {
    if (!revision || loadedTargetIndex !== targetIndex) return;
    const savedTargetIndex = targetIndex;
    setLoading(true); setStatus('');
    try {
      const response = await fetch('/api/v1/admin/personalization', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetIndex, config, revision }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.errorMessage);
      if (currentTargetIndexRef.current !== savedTargetIndex) return;
      setConfig(body.config); setRevision(body.revision); setStatus('저장되었습니다.');
    } catch (error) { if (currentTargetIndexRef.current === savedTargetIndex) setStatus(error instanceof Error ? error.message : '저장하지 못했습니다.'); } finally { if (currentTargetIndexRef.current === savedTargetIndex) setLoading(false); }
  };
  return <AdminLayout email={email}><Head><title>개인화 | 검색엔진 관리자</title></Head><div className={styles.container}>
    <header><div><h1>개인화</h1><p>가상 회원 행동 4개 인덱스의 조회 기간과 검색 점수 보정 비중을 설정합니다.</p></div><button type="button" onClick={() => void save()} disabled={loading || !revision || loadedTargetIndex !== targetIndex}>저장</button></header>
    {status && <p className={styles.status}>{status}</p>}
    <section><h2>행동 신호</h2><div className={styles.grid}>{Object.entries(labels).map(([key, label]) => { const name = key as keyof typeof labels; return <article key={name}><h3>{label}</h3><label>기간(일)<input type="number" min="1" max="3650" value={config.sources[name].days} onChange={(event) => setConfig((value) => ({ ...value, sources: { ...value.sources, [name]: { ...value.sources[name], days: Number(event.target.value) } } }))} /></label><label>비중(%)<input type="number" min="0" max="100" value={config.sources[name].weight * 100} onChange={(event) => setConfig((value) => ({ ...value, sources: { ...value.sources, [name]: { ...value.sources[name], weight: Number(event.target.value) / 100 } } }))} /></label></article>; })}</div></section>
    <section><h2>매칭 차원</h2><div className={styles.row}>{(['product', 'brand', 'category'] as const).map((name) => <label key={name}>{name === 'product' ? '상품' : name === 'brand' ? '브랜드' : '카테고리'} 비중(%)<input type="number" min="0" max="100" value={config.dimensions[name] * 100} onChange={(event) => setConfig((value) => ({ ...value, dimensions: { ...value.dimensions, [name]: Number(event.target.value) / 100 } }))} /></label>)}</div></section>
    <section><h2>적용 제한</h2><div className={styles.row}><label>최대 보정률(%)<input type="number" min="0" max="100" value={config.maxBoost * 100} onChange={(event) => setConfig((value) => ({ ...value, maxBoost: Number(event.target.value) / 100 }))} /></label><label>캐시 TTL(분)<input type="number" min="5" max="15" value={config.cacheTtlMs / 60000} onChange={(event) => setConfig((value) => ({ ...value, cacheTtlMs: Number(event.target.value) * 60000 }))} /></label></div><p>사용 여부는 검색설정/시뮬레이션에서 전환합니다. 사용자 지정 정렬에서는 개인화를 적용하지 않습니다.</p></section>
  </div></AdminLayout>;
}
