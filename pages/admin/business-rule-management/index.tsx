import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import { useCallback, useEffect, useState } from 'react';

import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import AdminLayout from '../../../components/layout/admin-layout';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getAdminPageSession } from '../../../service/admin-auth';
import type { BusinessRuleWithDisplayStatus, ConditionOperator, PinMatchType, PinProduct, RuleStatus } from '../../../service/business-rule-service';
import styles from './business-rule-management.module.css';

type RuleKind = 'score' | 'pin';
interface RuleForm {
  kind: RuleKind; targetIndex: string; name: string; description: string; field: string; operator: ConditionOperator; conditionValue: string; adjustmentPercent: string;
  query: string; matchType: PinMatchType; products: PinProduct[]; startAt: string; endAt: string; alwaysOn: boolean; status: RuleStatus;
}
interface ListResponse { success: boolean; rules?: BusinessRuleWithDisplayStatus[]; availableFields?: string[]; errorMessage?: string }

export const getServerSideProps: GetServerSideProps<{ email: string }> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin ? { props: { email: admin.email } } : { redirect: { destination: '/login', permanent: false } };
};

function localInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyForm(targetIndex: string, kind: RuleKind): RuleForm {
  const end = new Date(); end.setMonth(end.getMonth() + 1);
  return { kind, targetIndex, name: '', description: '', field: 'sale_amt', operator: 'gt', conditionValue: '', adjustmentPercent: '30', query: '', matchType: 'exact', products: [{ goodsId: '', position: 1 }], startAt: localInput(new Date()), endAt: localInput(end), alwaysOn: false, status: 'active' };
}

function editForm(rule: BusinessRuleWithDisplayStatus): RuleForm {
  if (rule.kind === 'score') return { kind: 'score', targetIndex: rule.targetIndex, name: rule.name, description: rule.description || '', field: rule.condition.field, operator: rule.condition.operator, conditionValue: String(rule.condition.value), adjustmentPercent: String(rule.adjustment * 100), query: '', matchType: 'exact', products: [], startAt: localInput(new Date(rule.startAt)), endAt: localInput(new Date(rule.endAt)), alwaysOn: rule.alwaysOn, status: rule.status };
  return { kind: 'pin', targetIndex: rule.targetIndex, name: '', description: '', field: '', operator: 'eq', conditionValue: '', adjustmentPercent: '', query: rule.query, matchType: rule.matchType, products: rule.products, startAt: localInput(new Date(rule.startAt)), endAt: localInput(new Date(rule.endAt)), alwaysOn: rule.alwaysOn, status: rule.status };
}

const statusLabels = { inactive: '비활성', scheduled: '진행 예정', running: '진행 중', ended: '종료' } as const;
const operatorLabels = { gt: '초과', gte: '이상', lt: '미만', lte: '이하', eq: '같음', contains: '포함' } as const;

export default function BusinessRuleManagementPage({ email }: { email: string }) {
  const { environment } = useAdminWorkspace();
  const targetIndex = getGoodsIndex(environment);
  const [kind, setKind] = useState<RuleKind>('score');
  const [rules, setRules] = useState<BusinessRuleWithDisplayStatus[]>([]);
  const [availableFields, setAvailableFields] = useState<string[]>([]);
  const [form, setForm] = useState<RuleForm>(() => emptyForm(targetIndex, kind));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/v1/admin/business-rules?targetIndex=${encodeURIComponent(targetIndex)}`, { headers: { Accept: 'application/json' } });
      const body = await response.json() as ListResponse;
      if (!response.ok) throw new Error(body.errorMessage || '비즈니스 룰을 불러오지 못했습니다.');
      setRules(body.rules || []); setAvailableFields(body.availableFields || []);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '비즈니스 룰을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [targetIndex]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openCreate = () => { setEditingId(null); setForm(emptyForm(targetIndex, kind)); setError(''); setModalOpen(true); };
  const openEdit = (rule: BusinessRuleWithDisplayStatus) => { setEditingId(rule.id); setForm(editForm(rule)); setError(''); setModalOpen(true); };
  const save = async () => {
    setSaving(true); setError('');
    const payload = form.kind === 'score'
      ? { kind: 'score', targetIndex, name: form.name, description: form.description, condition: { field: form.field, operator: form.operator, value: form.operator === 'contains' ? form.conditionValue : Number(form.conditionValue) }, adjustment: Number(form.adjustmentPercent) / 100, startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString(), alwaysOn: form.alwaysOn, status: form.status }
      : { kind: 'pin', targetIndex, query: form.query, matchType: form.matchType, products: form.products, startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString(), alwaysOn: form.alwaysOn, status: form.status };
    try {
      const response = await fetch(editingId ? `/api/v1/admin/business-rules/${editingId}` : '/api/v1/admin/business-rules', { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.errorMessage || '룰 저장에 실패했습니다.');
      setModalOpen(false); await load();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '룰 저장에 실패했습니다.'); }
    finally { setSaving(false); }
  };
  const remove = async (rule: BusinessRuleWithDisplayStatus) => {
    if (!window.confirm('이 룰을 삭제하시겠습니까?')) return;
    const response = await fetch(`/api/v1/admin/business-rules/${rule.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) { const body = await response.json(); setError(body.errorMessage || '룰 삭제에 실패했습니다.'); return; }
    await load();
  };
  const visibleRules = rules.filter((rule) => rule.kind === kind);

  return <AdminLayout email={email}><Head><title>비즈니스 룰 설정 | 검색엔진 관리자</title></Head><div className={styles.container}>
    <header className={styles.header}><div><h1>비즈니스 룰 설정</h1><p>검색 결과의 점수를 조정하거나 특정 검색어의 상품 순위를 고정합니다.</p></div></header>
    {error && !modalOpen && <div className={styles.errorBanner}>{error}</div>}
    <div className={styles.tabs}><button type="button" className={kind === 'score' ? styles.active : ''} onClick={() => setKind('score')}>점수 부스트·페널티</button><button type="button" className={kind === 'pin' ? styles.active : ''} onClick={() => setKind('pin')}>키워드별 상품 고정</button></div>
    <section className={styles.card}><div className={styles.toolbar}><strong>{targetIndex} · {visibleRules.length}개</strong><button type="button" onClick={openCreate}>＋ 룰 추가</button></div><div className={styles.tableWrapper}><table className={styles.ruleTable}><thead><tr><th>{kind === 'score' ? '룰 이름' : '검색어'}</th><th>{kind === 'score' ? '조건 / 점수 조정' : '고정 상품 / 순위'}</th><th>적용 기간</th><th>상태</th><th>관리</th></tr></thead><tbody>
      {!loading && visibleRules.length === 0 && <tr><td colSpan={5} className={styles.empty}>등록된 룰이 없습니다.</td></tr>}
      {visibleRules.map((rule) => <tr key={rule.id}><td><strong>{rule.kind === 'score' ? rule.name : rule.query}</strong>{rule.kind === 'score' && rule.description && <small>{rule.description}</small>}{rule.kind === 'pin' && <small>{rule.matchType === 'keyword' ? '추출 키워드 포함' : '검색어 정확히 일치'}</small>}</td><td>{rule.kind === 'score' ? <>{rule.condition.field} {operatorLabels[rule.condition.operator]} {rule.condition.value}<b className={rule.adjustment > 0 ? styles.boost : styles.penalty}>{rule.adjustment > 0 ? '+' : ''}{rule.adjustment * 100}%</b></> : rule.products.map((product) => <span key={product.goodsId} className={styles.productRule}>{product.position}위 · {product.goodsId}</span>)}</td><td>{rule.alwaysOn ? '계속 적용' : <>{new Date(rule.startAt).toLocaleString('ko-KR')}<br />~ {new Date(rule.endAt).toLocaleString('ko-KR')}</>}</td><td><span className={`${styles.status} ${styles[rule.displayStatus]}`}>{statusLabels[rule.displayStatus]}</span></td><td><div className={styles.rowActions}><button type="button" onClick={() => openEdit(rule)}>수정</button><button type="button" className={styles.deleteButton} onClick={() => void remove(rule)}>삭제</button></div></td></tr>)}
    </tbody></table></div></section>
    {modalOpen && <div className={styles.modalBackdrop} role="presentation"><div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="rule-dialog-title"><div className={styles.dialogHeader}><div><h2 id="rule-dialog-title">{editingId ? '룰 수정' : '룰 추가'}</h2><p>{form.kind === 'score' ? '조건에 맞는 검색 상품의 최종 점수를 조정합니다.' : '검색어 또는 추출 키워드 조건에 따라 상품을 지정 순위에 고정합니다.'}</p></div><button type="button" onClick={() => setModalOpen(false)}>×</button></div>{error && <div className={styles.errorBanner}>{error}</div>}<div className={styles.formGrid}>
      <label>적용 인덱스<input value={targetIndex} disabled /></label>
      {form.kind === 'score' ? <>
        <label>룰 이름<input value={form.name} maxLength={100} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className={styles.full}>설명<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label>조건 필드<select value={form.field} onChange={(event) => setForm({ ...form, field: event.target.value })}>{availableFields.map((field) => <option key={field}>{field}</option>)}</select></label>
        <label>연산자<select value={form.operator} onChange={(event) => setForm({ ...form, operator: event.target.value as ConditionOperator })}>{Object.entries(operatorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>조건 값<input type={form.operator === 'contains' ? 'text' : 'number'} maxLength={form.operator === 'contains' ? 200 : undefined} placeholder={form.operator === 'contains' ? '여러 값은 쉼표로 구분' : undefined} value={form.conditionValue} onChange={(event) => setForm({ ...form, conditionValue: event.target.value })} /></label>
        <label>점수 조정 (%)<input type="number" min="-100" max="500" value={form.adjustmentPercent} onChange={(event) => setForm({ ...form, adjustmentPercent: event.target.value })} /></label>
      </> : <>
        <label>대상 검색어<input value={form.query} maxLength={100} onChange={(event) => setForm({ ...form, query: event.target.value })} /></label>
        <label>매칭 방식<select value={form.matchType} onChange={(event) => setForm({ ...form, matchType: event.target.value as PinMatchType })}><option value="exact">검색어 정확히 일치</option><option value="keyword">추출 키워드 포함</option></select></label>
        <div className={`${styles.full} ${styles.products}`}><div><strong>고정 상품</strong><button type="button" onClick={() => setForm({ ...form, products: [...form.products, { goodsId: '', position: form.products.length + 1 }] })}>＋ 상품 추가</button></div>{form.products.map((product, index) => <div key={index} className={styles.productRow}><input aria-label={`상품 ID ${index + 1}`} placeholder="상품 ID" value={product.goodsId} onChange={(event) => setForm({ ...form, products: form.products.map((item, itemIndex) => itemIndex === index ? { ...item, goodsId: event.target.value } : item) })} /><input aria-label={`고정 순위 ${index + 1}`} type="number" min="1" max="100" value={product.position} onChange={(event) => setForm({ ...form, products: form.products.map((item, itemIndex) => itemIndex === index ? { ...item, position: Number(event.target.value) } : item) })} /><button type="button" className={styles.deleteButton} disabled={form.products.length === 1} onClick={() => setForm({ ...form, products: form.products.filter((_, itemIndex) => itemIndex !== index) })}>삭제</button></div>)}</div>
      </>}
      <label className={`${styles.full} ${styles.checkboxLabel}`}><input type="checkbox" checked={form.alwaysOn} onChange={(event) => setForm({ ...form, alwaysOn: event.target.checked })} /> 계속 적용</label>
      <label>시작 일시<input type="datetime-local" value={form.startAt} disabled={form.alwaysOn} onChange={(event) => setForm({ ...form, startAt: event.target.value })} /></label>
      <label>종료 일시<input type="datetime-local" value={form.endAt} disabled={form.alwaysOn} onChange={(event) => setForm({ ...form, endAt: event.target.value })} /></label>
      <label>사용 여부<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as RuleStatus })}><option value="active">사용</option><option value="inactive">중지</option></select></label>
    </div><div className={styles.dialogActions}><button type="button" onClick={() => setModalOpen(false)}>취소</button><button type="button" disabled={saving} onClick={() => void save()}>{saving ? '저장 중...' : '저장'}</button></div></div></div>}
  </div></AdminLayout>;
}
