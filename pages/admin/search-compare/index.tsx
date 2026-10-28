import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type { SortConfig } from '../../../service/sort-config-service';
import styles from './search-compare.module.css';

interface Props { email: string; }
interface CurrentItem { id?: string; goods_id?: string; goods_nm?: string; onl_goods_nm?: string; bnd_nm_ko?: string; img_path?: string; sale_amt?: number | string; scores?: { total: number }; }
interface LegacyItem { id: string; goodsId: string | null; name: string | null; brand: string | null; imgPath: string | null; saleAmt: number | null; }
interface Result<T> { items: T[]; total: number; totalPages: number; page: number; error?: string; }

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin ? { props: { email: admin.email } } : { redirect: { destination: '/login', permanent: false } };
};

function imageUrl(value: string | null | undefined): string | null {
  return value && /^\/demo\/[a-z0-9-]+\.svg$/.test(value) ? value : null;
}

function formatPrice(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('ko-KR')}원` : '-';
}

function Product({ item, current, rank }: { item: CurrentItem | LegacyItem; current: boolean; rank: number }) {
  const currentItem = item as CurrentItem; const legacyItem = item as LegacyItem;
  const src = imageUrl(current ? currentItem.img_path : legacyItem.imgPath);
  const name = currentItem.goods_nm || currentItem.onl_goods_nm || legacyItem.name || '-';
  const brand = currentItem.bnd_nm_ko || legacyItem.brand || '-';
  const id = currentItem.goods_id || currentItem.id || legacyItem.goodsId || '-';
  const saleAmount = current ? currentItem.sale_amt : legacyItem.saleAmt;
  return <li className={styles.product}><span className={styles.rank}>{rank}</span>{src ? <Image src={src} alt="" width={58} height={72} unoptimized /> : <span className={styles.imagePlaceholder}>NO<br />IMAGE</span>}<div><strong title={name}>{name}</strong><span>{brand}</span><small>{id}</small><span className={styles.price}><b>{formatPrice(saleAmount)}</b></span></div>{current && <b>{typeof currentItem.scores?.total === 'number' ? currentItem.scores.total.toFixed(4) : '-'}</b>}</li>;
}

export default function SearchComparePage({ email }: Props) {
  const queryRef = useRef<HTMLInputElement>(null);
  const { environment } = useAdminWorkspace();
  const [sortConfigs, setSortConfigs] = useState<SortConfig[]>([]); const [sortConfigId, setSortConfigId] = useState('');
  const [size, setSize] = useState(10);
  const [current, setCurrent] = useState<Result<CurrentItem> | null>(null); const [legacy, setLegacy] = useState<Result<LegacyItem> | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const targetIndex = getGoodsIndex(environment);
  useEffect(() => { fetch('/api/v1/admin/sort-configs').then((r) => r.json()).then((body) => setSortConfigs((body.configs || []).filter((c: SortConfig) => c.targetIndex === targetIndex))).catch(() => {}); }, [targetIndex]);

  const search = async (nextPage = 1, nextSize = size) => {
    const q = queryRef.current?.value.trim() || ''; if (!q) { setError('검색어를 입력해 주세요.'); return; }
    setLoading(true); setError('');
    const requests = await Promise.allSettled([
      fetch('/api/v1/admin/search-ranking/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, page: nextPage, size: nextSize, targetIndex, sortConfigId }) }).then(async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.errorMessage); return x; }),
      fetch('/api/v1/admin/search-compare/legacy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, page: nextPage, size: nextSize, environment }) }).then(async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.errorMessage); return x; }),
    ]);
    const [currentResult, legacyResult] = requests;
    setCurrent(currentResult.status === 'fulfilled' ? currentResult.value : { items: [], total: 0, totalPages: 1, page: nextPage, error: currentResult.reason?.message || '현재 검색에 실패했습니다.' });
    setLegacy(legacyResult.status === 'fulfilled' ? legacyResult.value : { items: [], total: 0, totalPages: 1, page: nextPage, error: legacyResult.reason?.message || '기본 키워드 검색에 실패했습니다.' });
    if (currentResult.status === 'rejected' && legacyResult.status === 'rejected') setError('현재 검색과 기본 키워드 검색을 모두 가져오지 못했습니다.'); setLoading(false);
  };

  const panels: Array<{ title: string; result: Result<CurrentItem> | Result<LegacyItem> | null; current: boolean }> = [{ title: '현재 검색', result: current, current: true }, { title: '기본 키워드 검색 (점수순)', result: legacy, current: false }];
  return <AdminLayout email={email}><Head><title>검색 비교 | 검색엔진 관리자</title></Head><div className={styles.container}>
    <header className={styles.header}><div><span className={styles.eyebrow}>SEARCH QUALITY</span><h1>검색 비교</h1><p>현재 검색 결과와 기본 키워드 검색 결과를 나란히 비교합니다.</p></div><div className={styles.target}><span>검색 환경</span><small>{targetIndex} · 기본 키워드 검색도 동일 환경 적용</small></div></header>
    <section className={styles.card}><div className={styles.searchBar}><input ref={queryRef} maxLength={200} placeholder="검색어를 입력하세요" onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} /><select aria-label="정렬" value={sortConfigId} onChange={(e) => setSortConfigId(e.target.value)}><option value="">점수순</option>{sortConfigs.map((c) => <option key={c.id} value={c.id}>{c.description} ({c.sortName})</option>)}</select><select aria-label="결과 수" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[10, 30, 50, 100].map((n) => <option key={n} value={n}>{n}개</option>)}</select><button type="button" onClick={() => void search()} disabled={loading}>{loading ? '검색 중...' : '검색'}</button></div>{error && <p className={styles.error}>{error}</p>}</section>
    <div className={styles.columns}>{panels.map(({ title, result, current: isCurrent }) => { const data = result; return <section className={styles.resultCard} key={title}><div className={styles.resultHeader}><h2>{title}</h2><span>{data ? (isCurrent ? `${data.total.toLocaleString('ko-KR')}건` : `${data.items.length.toLocaleString('ko-KR')}개 표시`) : '검색 전'}</span></div>{data?.error && <p className={styles.error}>{data.error}</p>}{data && !data.error && <ul>{data.items.map((item, index) => <Product key={`${(item as CurrentItem).id || (item as LegacyItem).goodsId}-${index}`} item={item} current={isCurrent} rank={index + 1} />)}</ul>}{data && !data.error && data.items.length === 0 && <p className={styles.empty}>검색 결과가 없습니다.</p>}</section>; })}</div>
  </div></AdminLayout>;
}
