import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import { useCallback, useEffect, useMemo, useState } from 'react';

import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import { getAdminPageSession } from '../../../service/admin-auth';
import type { SortConfig } from '../../../service/sort-config-service';
import styles from './sort-management.module.css';

interface PageProps {
  email: string;
}
interface ListResponse {
  success: boolean;
  configs?: SortConfig[];
  availableIndices?: string[];
  availableIndexTargets?: Array<{ indexName: string; environment: 'prd' | 'dev' }>;
  errorMessage?: string;
}
interface FormState {
  targetIndex: string;
  sortName: string;
  description: string;
  sortOptionsText: string;
}

const EXAMPLE_OPTIONS = JSON.stringify(
  [
    {
      _script: {
        type: 'number',
        script: {
          lang: 'painless',
          source:
            "double a1 = doc['amt1'].size() > 0 ? doc['amt1'].value : 0;\ndouble a2 = doc['amt2'].size() > 0 ? doc['amt2'].value : 0;\nreturn (a1 * 4) + (a2 * 2);",
        },
        order: 'desc',
      },
    },
  ],
  null,
  2,
);

const EMPTY_FORM: FormState = {
  targetIndex: '',
  sortName: '',
  description: '',
  sortOptionsText: EXAMPLE_OPTIONS,
};

export const getServerSideProps: GetServerSideProps<PageProps> = async (
  context,
) => {
  const admin = await getAdminPageSession(context);
  return admin
    ? { props: { email: admin.email } }
    : { redirect: { destination: '/login', permanent: false } };
};

export default function SortManagementPage({ email }: PageProps) {
  const { environment } = useAdminWorkspace();
  const [configs, setConfigs] = useState<SortConfig[]>([]);
  const [availableIndices, setAvailableIndices] = useState<string[]>([]);
  const [availableIndexTargets, setAvailableIndexTargets] = useState<ListResponse['availableIndexTargets']>([]);
  const [targetFilter, setTargetFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/v1/admin/sort-configs', {
        headers: { Accept: 'application/json' },
      });
      const body = (await response.json()) as ListResponse;
      if (!response.ok || !body.success)
        throw new Error(
          body.errorMessage || '정렬 설정을 불러오지 못했습니다.',
        );
      setConfigs(body.configs || []);
      setAvailableIndices((body.availableIndexTargets || []).filter((target) => target.environment === environment).map((target) => target.indexName));
      setAvailableIndexTargets(body.availableIndexTargets || []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : '정렬 설정 조회 중 오류가 발생했습니다.',
      );
    } finally {
      setLoading(false);
    }
  }, [environment]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filteredConfigs = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    const environmentIndices = new Set((availableIndexTargets || []).filter((target) => target.environment === environment).map((target) => target.indexName));
    return configs.filter(
      (config) =>
        environmentIndices.has(config.targetIndex) &&
        (!targetFilter || config.targetIndex === targetFilter) &&
        (!normalized ||
          config.sortName.toLowerCase().includes(normalized) ||
          config.description.toLowerCase().includes(normalized)),
    );
  }, [availableIndexTargets, configs, environment, keyword, targetFilter]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, targetIndex: (availableIndexTargets || []).find((target) => target.environment === environment)?.indexName || '' });
    setError('');
    setFormOpen(true);
  };

  const openEdit = (config: SortConfig) => {
    setEditingId(config.id);
    setForm({
      targetIndex: config.targetIndex,
      sortName: config.sortName,
      description: config.description,
      sortOptionsText: JSON.stringify(config.sortOptions, null, 2),
    });
    setError('');
    setFormOpen(true);
  };

  const save = async () => {
    if (!(availableIndexTargets || []).some((target) => target.indexName === form.targetIndex && target.environment === environment)) {
      setError('현재 선택한 환경의 인덱스만 저장할 수 있습니다.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        editingId
          ? `/api/v1/admin/sort-configs/${editingId}`
          : '/api/v1/admin/sort-configs',
        {
          method: editingId ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(form),
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        errorMessage?: string;
      };
      if (!response.ok || !body.success)
        throw new Error(body.errorMessage || '정렬 설정 저장에 실패했습니다.');
      setFormOpen(false);
      setMessage(
        'Elasticsearch 문법과 참조 필드 검증을 통과해 저장되었습니다.',
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : '정렬 설정 저장 중 오류가 발생했습니다.',
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (config: SortConfig) => {
    if (!window.confirm(`${config.sortName} 정렬 설정을 삭제하시겠습니까?`))
      return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/v1/admin/sort-configs/${config.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
      });
      const body = (await response.json()) as {
        success: boolean;
        errorMessage?: string;
      };
      if (!response.ok || !body.success)
        throw new Error(body.errorMessage || '정렬 설정 삭제에 실패했습니다.');
      setMessage('정렬 설정이 삭제되었습니다.');
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : '정렬 설정 삭제 중 오류가 발생했습니다.',
      );
    }
  };

  return (
    <AdminLayout email={email}>
      <Head>
        <title>검색정렬 관리 | 검색엔진 관리자</title>
      </Head>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1>검색정렬 관리</h1>
            <p>
              검색 쿼리의 sort 배열로 사용할 필드 및 Painless 정렬 설정을
              관리합니다.
            </p>
          </div>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={openCreate}
          >
            ＋ 정렬 추가
          </button>
        </header>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}
        {message && <div className={styles.successBanner}>{message}</div>}

        <section className={styles.card}>
          <div className={styles.filters}>
            <select
              value={targetFilter}
              onChange={(event) => setTargetFilter(event.target.value)}
            >
              <option value="">전체 적용 인덱스</option>
              {availableIndices.map((indexName) => (
                <option key={indexName} value={indexName}>
                  {indexName}
                </option>
              ))}
            </select>
            <input
              value={keyword}
              placeholder="정렬명 또는 설명 검색"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <div className={styles.tableWrapper}>
            <table>
              <thead>
                <tr>
                  <th>적용 인덱스</th>
                  <th>정렬명</th>
                  <th>설명</th>
                  <th>참조 필드</th>
                  <th>최종 검증</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filteredConfigs.length === 0 && (
                  <tr>
                    <td colSpan={6} className={styles.empty}>
                      등록된 정렬 설정이 없습니다.
                    </td>
                  </tr>
                )}
                {filteredConfigs.map((config) => (
                  <tr key={config.id}>
                    <td>
                      <code>{config.targetIndex}</code>
                    </td>
                    <td>
                      <strong>{config.sortName}</strong>
                    </td>
                    <td>{config.description}</td>
                    <td>
                      {config.referencedFields.length
                        ? config.referencedFields.join(', ')
                        : '-'}
                    </td>
                    <td>
                      {new Date(config.validatedAt).toLocaleString('ko-KR')}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button type="button" onClick={() => openEdit(config)}>
                          수정
                        </button>
                        <button
                          type="button"
                          className={styles.deleteButton}
                          onClick={() => void remove(config)}
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {formOpen && (
          <div
            className={styles.modalOverlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sort-modal-title"
          >
            <div className={styles.modal}>
              <div className={styles.modalHeader}>
                <div>
                  <h2 id="sort-modal-title">
                    {editingId ? '정렬 설정 수정' : '정렬 설정 추가'}
                  </h2>
                  <p>
                    저장 시 Elasticsearch에서 문법, Painless 스크립트와 참조
                    필드를 검증합니다.
                  </p>
                </div>
                <div className={styles.modalActions}>
                  <button type="button" onClick={() => setFormOpen(false)}>
                    취소
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={saving}
                    onClick={() => void save()}
                  >
                    {saving ? '검증 중...' : '검증 후 저장'}
                  </button>
                </div>
              </div>
              <div className={styles.formBody}>
                {error && (
                  <div className={styles.modalError} role="alert">
                    {error}
                  </div>
                )}
                <div className={styles.formGrid}>
                  <label>
                    <span>적용 인덱스</span>
                    <select
                      value={form.targetIndex}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          targetIndex: event.target.value,
                        }))
                      }
                    >
                      <option value="">선택하세요</option>
                      {[
                        ...new Set(
                          [...availableIndices, form.targetIndex].filter(
                            Boolean,
                          ),
                        ),
                      ].map((indexName) => (
                        <option key={indexName} value={indexName}>
                          {indexName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>정렬명</span>
                    <input
                      value={form.sortName}
                      placeholder="SORT_AMT1"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          sortName: event.target.value.toUpperCase(),
                        }))
                      }
                    />
                  </label>
                </div>
                <label>
                  <span>설명</span>
                  <input
                    value={form.description}
                    maxLength={200}
                    placeholder="예: 금액순1"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>정렬옵션 JSON 배열</span>
                  <textarea
                    value={form.sortOptionsText}
                    spellCheck={false}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        sortOptionsText: event.target.value,
                      }))
                    }
                  />
                </label>
                <p className={styles.help}>
                  저장된 배열은 Elasticsearch 검색 요청의 <code>sort</code> 값에
                  그대로 사용됩니다. 스크립트는 <code>lang: painless</code>만
                  허용됩니다.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
