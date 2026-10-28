import type { GetServerSideProps } from 'next';
import Head from '../../../components/admin/admin-page-head';
import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import AdminLayout from '../../../components/layout/admin-layout';
import { useAdminWorkspace } from '../../../components/admin/admin-workspace';
import { getGoodsIndex } from '../../../constant/goods-index.constant.mjs';
import { getContentsIndex } from '../../../constant/contents-index.constant';
import { getAdminPageSession } from '../../../service/admin-auth';
import type {
  SearchRankingField,
  SearchRankingRevision,
} from '../../../service/search-ranking-service';
import type {
  PopularityAmountField,
  PopularityConfig,
  PopularityNormalizationMethod,
  PopularityQuantityField,
} from '../../../service/popularity-formula';
import type { SortConfig } from '../../../service/sort-config-service';
import type {
  CategoryAdjustmentConfig,
  CategoryAdjustmentDiagnostic,
} from '../../../service/category-adjustment';
import {
  DEFAULT_PERSONALIZATION,
  type PersonalizationConfig,
} from '../../../service/personalization-config';
import type {
  AiSearchAnalysis,
  AiSearchConfig,
} from '../../../service/ai-search-query-service';
import styles from '../search-ranking/search-ranking.module.css';

interface PageProps {
  email: string;
}

const DEFAULT_SEARCH_QUERY =
  '10월 결혼식 하객룩으로 입기 좋은 단정한 원피스 추천해줘';
const SEARCH_QUERY_PLACEHOLDER = `'${DEFAULT_SEARCH_QUERY}'처럼 문장으로 검색해보세요`;

interface RankingConfigResponse {
  success: boolean;
  config?: {
    targetIndex: string;
    fields: SearchRankingField[];
    revision: SearchRankingRevision;
    updatedAt: string;
    updatedBy: string;
    popularity: PopularityConfig;
    categoryAdjustment: CategoryAdjustmentConfig;
    adaptiveSearch: { enabled: boolean };
    ai: AiSearchConfig;
    personalization: PersonalizationConfig;
  };
  availableFields?: string[];
  categoryCatalog?: { categories: string[]; complete: boolean };
  aiRuntime?: { model: string; configured: boolean };
  errorMessage?: string;
}
interface SortConfigListResponse {
  success: boolean;
  configs?: SortConfig[];
  errorMessage?: string;
}
interface DiagnosticField {
  field: string;
  boost: number;
  diagnosticScore: number | null;
  highlightedValues: string[];
  matchedValue: unknown;
}
interface AppliedFilter {
  id: string;
  name: string;
  field: string;
  values: string[];
  range?: Record<string, number>;
}
interface SearchItem {
  id?: string;
  contents_id?: string;
  contents_no?: string;
  contents_div?: string;
  title?: string;
  sub_title?: string;
  disp_strt_dtm?: string;
  disp_end_dtm?: string;
  url?: string;
  goods_id?: string;
  goods_nm?: string;
  onl_goods_nm?: string;
  img_path?: string;
  bnd_nm_ko?: string;
  sale_amt?: number | string;
  scores: {
    total: number;
    keyword: number;
    vector: number;
    keywordRaw: number;
    vectorRaw: number;
    keywordRank: number | null;
    vectorRank: number | null;
    rrfTotal: number;
    popularityRaw: number;
    popularityNormalized: number;
    popularityBoost: number;
    businessRuleBaseScore?: number;
    businessRuleMultiplier?: number;
    categoryAdjustment?: CategoryAdjustmentDiagnostic;
    personalization?: {
      boost: number;
      multiplier: number;
      product: number;
      brand: number;
      category: number;
      sourceBoosts?: {
        cart: number;
        recent: number;
        wish: number;
        order: number;
      };
    };
    businessRules?: Array<{
      id: string;
      name: string;
      adjustment: number;
      field: string;
      operator: string;
      expectedValue: number | string;
      actualValue: unknown;
    }>;
  };
  pinning?: {
    ruleId: string;
    query: string;
    requestedPosition: number;
    appliedPosition: number;
  };
  matchedFields: DiagnosticField[];
  embeddingText: string;
  embeddingSource?: 'geo' | 'keywords';
  sortExplanation?: {
    sortName: string;
    description: string;
    fields: Array<{
      field: string;
      sourcePath: string | null;
      value: unknown;
      state: 'present' | 'null' | 'absent';
    }>;
    sortValues: unknown[];
    scoreTiebreaker: unknown;
  };
}
interface LegacySearchItem {
  id: string;
  goodsId: string | null;
  name: string | null;
  brand: string | null;
  imgPath: string | null;
  saleAmt: number | null;
}
interface SimulationResponse {
  success: boolean;
  searchMode?: 'hybrid' | 'lexical';
  searchModeReason?: string;
  queryAnalysis?: {
    tokens?: Array<{ token?: string; type?: string }>;
    cleanedQuery?: string;
    removedRequestExpressions?: string[];
    effectiveTokens?: string[];
    removedShortTokens?: string[];
    removedStopwords?: string[];
    removedContextTokens?: string[];
    synonymExpansions?: string[];
    synonymExpansionDetails?: Array<{ source: string; target: string }>;
    tokenDiagnostics?: Array<{ token: string; used: boolean; reason?: string }>;
  };
  items?: SearchItem[];
  page?: number;
  total?: number;
  totalPages?: number;
  errorMessage?: string;
  appliedFilters?: AppliedFilter[];
  legacy?: { items: LegacySearchItem[]; error?: string };
  aiAnalysis?: AiSearchAnalysis;
  timings?: {
    settingsMs: number;
    morphologyAnalysisMs: number;
    initialMorphologyAnalysisMs: number;
    additionalMorphologyAnalysisMs: number;
    initialParallelPreparationMs: number;
    queryAnalysisMs: number;
    aiMs: number;
    embeddingMs: number;
    candidatePreparationMs: number;
    candidateSearchMs: number;
    keywordCandidateSearchMs: number;
    vectorCandidateSearchMs: number;
    candidateResultProcessingMs: number;
    categoryCatalogMs: number;
    categoryCatalogCacheStatus: 'hit' | 'miss' | 'shared' | 'skipped';
    categoryCatalogKey: string;
    categoryCatalogCount: number;
    categoryCatalogLoadMethod:
      'aggregation' | 'source_scan' | 'failed' | 'skipped';
    categoryPreparationMs: number;
    personalizationMs: number;
    rankingMs: number;
    documentLoadMs: number;
    keywordDiagnosticsMs: number;
    simulationPreparationMs: number;
    currentSearchMs: number;
    legacyWaitMs: number;
    simulationOtherMs: number;
    legacySearchMs: number;
    simulationTotalMs: number;
    settingsCacheStatus: 'hit' | 'miss' | 'shared' | 'bypass';
    aiCacheStatus: 'hit' | 'miss' | 'skipped';
    embeddingCacheStatus: 'hit' | 'miss' | 'shared' | 'skipped';
    personalizationCacheStatus:
      'hit' | 'miss' | 'shared' | 'failed' | 'skipped';
    requestCacheStatus: 'miss' | 'shared';
  };
  timingWaterfall?: {
    simulation: { totalMs: number; spans: TimingSpan[] };
    currentSearch: {
      totalMs: number;
      spans: TimingSpan[];
      source: 'own' | 'shared';
    };
  };
}
interface TimingSpan {
  id: string;
  startMs: number;
  durationMs: number;
  parentId?: string;
  lane?: string;
}

const TIMING_STAGE_META: Record<
  string,
  { label: string; description: string; color: string }
> = Object.fromEntries(
  Object.entries({
    preparation: '사전 준비',
    'dispatch-overhead': '검색 dispatch',
    'current-search': '현재 검색',
    'diagnostic-preparation': '진단 준비',
    'keyword-diagnostics': '매칭 진단',
    'legacy-wait-preparation': '기본 키워드 검색 대기 준비',
    'legacy-wait': '기본 키워드 검색 추가 대기',
    'response-assembly': '응답 구성',
    'legacy-search': '기본 키워드 검색(병렬)',
    'resolve-index': '인덱스 확인',
    settings: '설정 조회',
    'initial-morphology': '원문 형태소',
    'initial-policy-filter': '원문 정책·필터',
    catalog: '카탈로그',
    'structured-intent': '구조화 의도',
    'remaining-morphology': '잔여 형태소',
    'adaptive-decision': '적응형 판정',
    ai: 'AI 확장',
    'keyword-morphology': '키워드 형태소',
    'effective-policy': '검색 정책',
    embedding: '벡터 생성',
    personalization: '개인화 조회',
    'candidate-preparation': '후보 준비',
    'candidate-search': '후보 조회',
    'candidate-fallback': '필터 fallback',
    'candidate-result-processing': '후보 처리',
    'category-preparation': '카테고리 감지',
    ranking: '순위 계산',
    'document-load': '상품 조회',
    'initial-parallel': '초기 병렬 준비',
  }).map(([id, label], index) => [
    id,
    {
      label,
      description: `${label} 단계의 실제 시작 위치와 소요 시간입니다.`,
      color: ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626'][index % 5],
    },
  ]),
);

const SIMULATION_ONLY_TIMING_STAGE_IDS = new Set([
  'preparation',
  'dispatch-overhead',
  'diagnostic-preparation',
  'keyword-diagnostics',
  'legacy-wait-preparation',
  'legacy-wait',
  'response-assembly',
  'legacy-search',
]);

function estimateProductionSearchMs(spans: TimingSpan[]): number {
  const intervals = spans
    .filter(
      (span) =>
        span.id !== 'settings' &&
        span.id !== 'initial-parallel' &&
        span.durationMs > 0,
    )
    .map(
      (span) =>
        [span.startMs, span.startMs + span.durationMs] as [number, number],
    )
    .sort(([leftStart], [rightStart]) => leftStart - rightStart);

  let totalMs = 0;
  let currentStart = 0;
  let currentEnd = 0;
  intervals.forEach(([start, end], index) => {
    if (index === 0) {
      currentStart = start;
      currentEnd = end;
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  });
  if (intervals.length > 0) totalMs += currentEnd - currentStart;
  return Math.round(totalMs);
}

function Waterfall({
  title,
  totalMs,
  spans,
}: {
  title: string;
  totalMs: number;
  spans: TimingSpan[];
}) {
  const denominator = Math.max(totalMs, 1);
  return (
    <section className={styles.waterfall}>
      <h4>{title}</h4>
      <div className={styles.waterfallCanvas}>
        {spans.map((span) => {
          const meta = TIMING_STAGE_META[span.id] || {
            label: span.id,
            description: span.id,
            color: '#4f46e5',
          };
          const simulationOnly = SIMULATION_ONLY_TIMING_STAGE_IDS.has(span.id);
          const detail = `${simulationOnly ? '시뮬레이터 전용 단계입니다. ' : ''}${meta.description} 시작 ${Math.round(span.startMs)}ms · 소요 ${Math.round(span.durationMs)}ms${span.lane ? ` · ${span.lane} 병렬 lane` : ''}`;
          return (
            <div className={styles.waterfallRow} key={span.id}>
              <span
                className={simulationOnly ? styles.simulationOnlyStage : undefined}
                title={simulationOnly ? '실제 운영 검색 API에서는 실행하지 않는 시뮬레이터 전용 단계입니다.' : undefined}
              >
                {meta.label}
              </span>
              <div
                className={styles.waterfallTrack}
                title={detail}
                aria-label={detail}
              >
                <i
                  style={{
                    left: `${Math.min(100, (span.startMs / denominator) * 100)}%`,
                    width: `max(2px, ${Math.min(100, (span.durationMs / denominator) * 100)}%)`,
                    background: meta.color,
                  }}
                />
              </div>
              <b>{Math.round(span.durationMs)}ms</b>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function mergeCurrentSearchSpans(
  simulationSpans: TimingSpan[],
  currentSearchSpans: TimingSpan[],
): TimingSpan[] {
  const currentSearch = simulationSpans.find(
    (span) => span.id === 'current-search',
  );
  if (!currentSearch) return simulationSpans;

  return simulationSpans.flatMap((span) =>
    span.id === 'current-search'
      ? currentSearchSpans.map((currentSpan) => ({
          ...currentSpan,
          startMs: currentSearch.startMs + currentSpan.startMs,
        }))
      : [span],
  );
}
interface DraftSnapshot {
  fields: SearchRankingField[];
  popularity: PopularityConfig;
  ai: AiSearchConfig;
  categoryAdjustment: CategoryAdjustmentConfig;
  adaptiveSearch: { enabled: boolean };
  personalization: PersonalizationConfig;
}

interface PersonalizationSimulationSnapshot {
  memberNo: string;
  config: PersonalizationConfig;
  sortConfigId: string;
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (
  context,
) => {
  const admin = await getAdminPageSession(context);
  return admin
    ? { props: { email: admin.email } }
    : { redirect: { destination: '/login', permanent: false } };
};

const SCORE_NUMBER_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 5,
  useGrouping: false,
});

function formatScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? SCORE_NUMBER_FORMATTER.format(value)
    : '-';
}

function cacheStatusLabel(
  status: 'hit' | 'miss' | 'shared' | 'failed' | 'skipped' | 'bypass',
): string {
  if (status === 'hit') return '캐시 적중';
  if (status === 'shared') return '동시 요청 공유';
  if (status === 'skipped') return '미사용';
  if (status === 'failed') return '조회 실패';
  if (status === 'bypass') return '캐시 미사용';
  return '캐시 미적중';
}

function formatAdjustmentPercent(value: number): string {
  const percent = Math.round(value * 1000) / 10;
  return `${percent >= 0 ? '+' : ''}${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function HelpTooltip({ text }: { text: string }) {
  return (
    <span className={styles.helpTooltip} tabIndex={0} aria-label={text}>
      ?<span role="tooltip">{text}</span>
    </span>
  );
}

function businessRuleTooltip(
  rule: NonNullable<SearchItem['scores']['businessRules']>[number],
): string {
  const operators: Record<string, string> = {
    gt: '초과',
    gte: '이상',
    lt: '미만',
    lte: '이하',
    eq: '같음',
    contains: '포함',
  };
  return `조건: ${rule.field} ${operators[rule.operator] || rule.operator} ${formatSortValue(rule.expectedValue)} · 실제값: ${formatSortValue(rule.actualValue)} · 점수 보정: ${formatAdjustmentPercent(rule.adjustment)}`;
}

function formatPrice(value: number | string | undefined): string {
  if (value === undefined || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('ko-KR')}원` : '-';
}

function formatContentDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function productImageUrl(value?: string): string | null {
  return value && /^\/demo\/[a-z0-9-]+\.svg$/.test(value) ? value : null;
}

function contentPageUrl(value: string): string | null {
  return /^\/demo\/[a-z0-9-]+\.svg$/.test(value) ? value : null;
}

function formatSortValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatAppliedFilter(filter: AppliedFilter): string {
  if (!filter.range) return `${filter.field} · ${filter.values.join(', ')}`;
  const labels: Record<string, string> = {
    gte: '이상',
    gt: '초과',
    lte: '이하',
    lt: '미만',
  };
  return `${filter.field} · ${Object.entries(filter.range)
    .map(
      ([operator, value]) =>
        `${value.toLocaleString('ko-KR')} ${labels[operator] || operator}`,
    )
    .join(' · ')}`;
}

function renderHighlightedValue(value: string) {
  let highlighted = false;
  return value.split(/([\uE000\uE001])/).map((part, index) => {
    if (part === '\uE000') {
      highlighted = true;
      return null;
    }
    if (part === '\uE001') {
      highlighted = false;
      return null;
    }
    return highlighted ? (
      <mark key={index}>{part}</mark>
    ) : (
      <span key={index}>{part}</span>
    );
  });
}

function snapshot(
  fields: SearchRankingField[],
  popularity: PopularityConfig,
  ai: AiSearchConfig,
  categoryAdjustment: CategoryAdjustmentConfig,
  adaptiveSearch: { enabled: boolean },
  personalization: PersonalizationConfig,
): DraftSnapshot {
  return {
    fields,
    popularity,
    ai,
    categoryAdjustment,
    adaptiveSearch,
    personalization,
  };
}

export default function SearchWeightTuningPage({ email }: PageProps) {
  const { environment } = useAdminWorkspace();
  const [indexType, setIndexType] = useState<'goods' | 'contents'>('goods');
  const contents = indexType === 'contents';
  const targetIndex = contents
    ? getContentsIndex(environment)
    : getGoodsIndex(environment);
  const currentTargetIndexRef = useRef(targetIndex);
  const loadedTargetIndexRef = useRef<string | null>(null);
  const [loadedTargetIndex, setLoadedTargetIndex] = useState<string | null>(
    null,
  );
  const loadRequestRef = useRef(0);
  const simulationRequestRef = useRef(0);
  const [fields, setFields] = useState<SearchRankingField[]>([]);
  const [popularity, setPopularity] = useState<PopularityConfig>({
    enabled: false,
    expression: '',
    weight: 0.2,
    normalizationMethod: 'max',
    topPercent: 5,
    referencedFields: [],
    amountField: 'month_amt',
    quantityField: 'month_ord_cnt',
    amountRatio: 0.4,
    quantityRatio: 0.5,
    hitsRatio: 0.1,
  });
  const [ai, setAi] = useState<AiSearchConfig>({ enabled: false });
  const [categoryAdjustment, setCategoryAdjustment] =
    useState<CategoryAdjustmentConfig>({
      enabled: false,
      matchMultiplier: 1.25,
      mismatchMultiplier: 0.9,
      undetectedMultiplier: 1,
    });
  const [adaptiveSearch, setAdaptiveSearch] = useState({ enabled: false });
  const [personalization, setPersonalization] = useState<PersonalizationConfig>(
    DEFAULT_PERSONALIZATION,
  );
  const [testMemberNo, setTestMemberNo] = useState('');
  const [personalizationSimulation, setPersonalizationSimulation] =
    useState<PersonalizationSimulationSnapshot | null>(null);
  const [searchMode, setSearchMode] = useState<{
    mode: 'hybrid' | 'lexical';
    reason: string;
  } | null>(null);
  const [aiRuntime, setAiRuntime] = useState({ model: '', configured: false });
  const [aiAnalysis, setAiAnalysis] = useState<AiSearchAnalysis | null>(null);
  const [timings, setTimings] =
    useState<SimulationResponse['timings']>(undefined);
  const [timingWaterfall, setTimingWaterfall] =
    useState<SimulationResponse['timingWaterfall']>();
  const [timingExpanded, setTimingExpanded] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<DraftSnapshot | null>(
    null,
  );
  const [revision, setRevision] = useState<SearchRankingRevision | null>(null);
  const [availableFields, setAvailableFields] = useState<string[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [updatedInfo, setUpdatedInfo] = useState('');
  const queryInputRef = useRef<HTMLInputElement>(null);
  const [sortConfigs, setSortConfigs] = useState<SortConfig[]>([]);
  const [sortConfigId, setSortConfigId] = useState('');
  const [resultSize, setResultSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [legacy, setLegacy] = useState<SimulationResponse['legacy']>();
  const [matchingItem, setMatchingItem] = useState<SearchItem | null>(null);
  const [ruleTooltip, setRuleTooltip] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<
    SimulationResponse['appliedFilters']
  >([]);
  const showRuleTooltip = (target: HTMLElement, text: string) => {
    const rect = target.getBoundingClientRect();
    setRuleTooltip({
      text,
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    });
  };
  const [requestAnalysis, setRequestAnalysis] =
    useState<SimulationResponse['queryAnalysis']>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const popularityRatioValid =
    Math.abs(
      popularity.amountRatio +
        popularity.quantityRatio +
        popularity.hitsRatio -
        1,
    ) < 0.000001;

  const dirty = useMemo(
    () =>
      savedSnapshot !== null &&
      JSON.stringify(savedSnapshot) !==
        JSON.stringify(
          snapshot(
            fields,
            popularity,
            ai,
            categoryAdjustment,
            adaptiveSearch,
            personalization,
          ),
        ),
    [
      fields,
      popularity,
      ai,
      categoryAdjustment,
      adaptiveSearch,
      personalization,
      savedSnapshot,
    ],
  );

  const loadConfig = useCallback(async (indexName: string) => {
    const requestId = ++loadRequestRef.current;
    const isCurrent = () =>
      requestId === loadRequestRef.current &&
      indexName === currentTargetIndexRef.current;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const [response, sortResponse] = await Promise.all([
        fetch(
          `/api/v1/admin/search-ranking?targetIndex=${encodeURIComponent(indexName)}`,
          { headers: { Accept: 'application/json' } },
        ),
        fetch('/api/v1/admin/sort-configs', {
          headers: { Accept: 'application/json' },
        }),
      ]);
      const [body, sortBody] = await Promise.all([
        response.json() as Promise<RankingConfigResponse>,
        sortResponse.json() as Promise<SortConfigListResponse>,
      ]);
      if (!response.ok || !body.config)
        throw new Error(
          body.errorMessage || '검색 가중치 설정을 불러오지 못했습니다.',
        );
      if (!sortResponse.ok || !sortBody.success)
        throw new Error(
          sortBody.errorMessage || '정렬 설정을 불러오지 못했습니다.',
        );
      if (!isCurrent()) return;
      if (body.config.targetIndex !== indexName)
        throw new Error('요청한 인덱스의 설정이 아닙니다.');
      loadedTargetIndexRef.current = indexName;
      setLoadedTargetIndex(indexName);
      setFields(body.config.fields);
      setPopularity(body.config.popularity);
      setAi(body.config.ai || { enabled: false });
      setCategoryAdjustment(
        body.config.categoryAdjustment || {
          enabled: false,
          matchMultiplier: 1.25,
          mismatchMultiplier: 0.9,
          undetectedMultiplier: 1,
        },
      );
      setAdaptiveSearch(body.config.adaptiveSearch || { enabled: false });
      setPersonalization(
        body.config.personalization || DEFAULT_PERSONALIZATION,
      );
      setSearchMode(null);
      setAiRuntime(body.aiRuntime || { model: '', configured: false });
      setAiAnalysis(null);
      setTimings(undefined);
      setSavedSnapshot(
        snapshot(
          body.config.fields,
          body.config.popularity,
          body.config.ai || { enabled: false },
          body.config.categoryAdjustment || {
            enabled: false,
            matchMultiplier: 1.25,
            mismatchMultiplier: 0.9,
            undetectedMultiplier: 1,
          },
          body.config.adaptiveSearch || { enabled: false },
          body.config.personalization || DEFAULT_PERSONALIZATION,
        ),
      );
      setRevision(body.config.revision);
      setAvailableFields(body.availableFields || []);
      setCategoryOptions(body.categoryCatalog?.categories || []);
      setSortConfigs(
        (sortBody.configs || []).filter(
          (config) => config.targetIndex === indexName,
        ),
      );
      setSortConfigId('');
      setUpdatedInfo(
        `${body.config.updatedBy} · ${new Date(body.config.updatedAt).toLocaleString('ko-KR')}`,
      );
      setItems([]);
      setPersonalizationSimulation(null);
      setLegacy(undefined);
      setMatchingItem(null);
      setRequestAnalysis(undefined);
      setAppliedFilters([]);
      setCurrentPage(1);
      setTotalPages(1);
      setTotal(0);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : '설정 조회 중 오류가 발생했습니다.',
      );
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useLayoutEffect(() => {
    currentTargetIndexRef.current = targetIndex;
    loadedTargetIndexRef.current = null;
    loadRequestRef.current += 1;
    simulationRequestRef.current += 1;
  }, [targetIndex]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoadedTargetIndex(null);
      setRevision(null);
      setItems([]);
      setPersonalizationSimulation(null);
      setSearching(false);
      void loadConfig(targetIndex);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfig, targetIndex]);

  useEffect(() => {
    if (!matchingItem) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMatchingItem(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [matchingItem]);

  const updateField = (index: number, patch: Partial<SearchRankingField>) => {
    setFields((current) =>
      current.map((field, fieldIndex) =>
        fieldIndex === index ? { ...field, ...patch } : field,
      ),
    );
    setMessage('');
  };

  const save = async () => {
    if (!revision || loadedTargetIndexRef.current !== targetIndex) return;
    const savedTargetIndex = targetIndex;
    if (!contents && !popularityRatioValid) {
      setError('판매금액, 판매수량, 조회수 비중의 합계가 100%여야 합니다.');
      return;
    }
    if (!window.confirm('저장 시 사이트에 바로 적용됩니다. 저장하시겠습니까?'))
      return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/v1/admin/search-ranking', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetIndex,
          fields,
          popularity,
          ai,
          categoryAdjustment,
          adaptiveSearch,
          personalization,
          revision,
        }),
      });
      const body = (await response.json()) as RankingConfigResponse;
      if (!response.ok || !body.config)
        throw new Error(body.errorMessage || '설정 저장에 실패했습니다.');
      if (
        savedTargetIndex !== currentTargetIndexRef.current ||
        loadedTargetIndexRef.current !== savedTargetIndex
      )
        return;
      if (body.config.targetIndex !== savedTargetIndex)
        throw new Error('요청한 인덱스의 설정이 아닙니다.');
      setFields(body.config.fields);
      setPopularity(body.config.popularity);
      setAi(body.config.ai || { enabled: false });
      setCategoryAdjustment(body.config.categoryAdjustment);
      setAdaptiveSearch(body.config.adaptiveSearch || { enabled: false });
      setPersonalization(
        body.config.personalization || DEFAULT_PERSONALIZATION,
      );
      setSavedSnapshot(
        snapshot(
          body.config.fields,
          body.config.popularity,
          body.config.ai || { enabled: false },
          body.config.categoryAdjustment,
          body.config.adaptiveSearch || { enabled: false },
          body.config.personalization || DEFAULT_PERSONALIZATION,
        ),
      );
      setRevision(body.config.revision);
      setUpdatedInfo(
        `${body.config.updatedBy} · ${new Date(body.config.updatedAt).toLocaleString('ko-KR')}`,
      );
      setMessage('저장되었습니다. 다음 공개 검색 요청부터 바로 적용됩니다.');
    } catch (saveError) {
      if (savedTargetIndex !== currentTargetIndexRef.current) return;
      setError(
        saveError instanceof Error
          ? saveError.message
          : '설정 저장 중 오류가 발생했습니다.',
      );
    } finally {
      setSaving(false);
    }
  };

  const simulate = async (page = 1, size = resultSize) => {
    if (loadedTargetIndexRef.current !== targetIndex) return;
    const simulatedTargetIndex = targetIndex;
    const requestId = ++simulationRequestRef.current;
    const isCurrent = () =>
      requestId === simulationRequestRef.current &&
      simulatedTargetIndex === currentTargetIndexRef.current;
    let query = queryInputRef.current?.value.trim() || '';
    if (!query) {
      query = DEFAULT_SEARCH_QUERY;
      if (queryInputRef.current) queryInputRef.current.value = query;
    }
    setSearching(true);
    setLegacy(undefined);
    setError('');
    try {
      const response = await fetch('/api/v1/admin/search-ranking/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: query,
          page,
          size,
          targetIndex,
          fields,
          sortConfigId,
          popularity,
          ai,
          categoryAdjustment,
          adaptiveSearch,
          personalization,
          testMemberNo,
        }),
      });
      const body = (await response.json()) as SimulationResponse;
      if (!isCurrent()) return;
      if (!response.ok)
        throw new Error(body.errorMessage || '검색 시뮬레이션에 실패했습니다.');
      setItems(body.items || []);
      setPersonalizationSimulation({
        memberNo: testMemberNo,
        config: JSON.parse(
          JSON.stringify(personalization),
        ) as PersonalizationConfig,
        sortConfigId,
      });
      setLegacy(body.legacy);
      setRequestAnalysis(body.queryAnalysis);
      setAppliedFilters(body.appliedFilters || []);
      setAiAnalysis(body.aiAnalysis || null);
      setSearchMode(
        body.searchMode
          ? { mode: body.searchMode, reason: body.searchModeReason || '' }
          : null,
      );
      setTimings(body.timings);
      setTimingWaterfall(body.timingWaterfall);
      setCurrentPage(body.page || page);
      setTotalPages(body.totalPages || 1);
      setTotal(body.total || 0);
    } catch (searchError) {
      if (!isCurrent()) return;
      setError(
        searchError instanceof Error
          ? searchError.message
          : '검색 중 오류가 발생했습니다.',
      );
    } finally {
      if (isCurrent()) setSearching(false);
    }
  };

  return (
    <AdminLayout email={email}>
      <Head>
        <title>검색설정/시뮬레이션 | 검색엔진 관리자</title>
      </Head>
      <div className={styles.container}>
        <header className={styles.pageHeader}>
          <div>
            <h1>검색설정/시뮬레이션</h1>
            <p>
              저장 전 초안으로 검색 점수를 테스트하고 검증된 설정만 공개 검색에
              반영합니다.
            </p>
          </div>
          <div className={styles.pageActions}>
            <label className={styles.indexTargetControl}>
              <span>대상 인덱스</span>
              <select
                value={indexType}
                onChange={(event) => {
                  loadedTargetIndexRef.current = null;
                  loadRequestRef.current += 1;
                  simulationRequestRef.current += 1;
                  setLoadedTargetIndex(null);
                  setRevision(null);
                  setItems([]);
                  setPersonalizationSimulation(null);
                  setIndexType(event.target.value as 'goods' | 'contents');
                }}
              >
                <option value="goods">상품</option>
                <option value="contents">콘텐츠</option>
              </select>
            </label>
            <div className={styles.saveActions}>
              <small>
                {dirty ? '저장하지 않은 변경사항' : updatedInfo || '조회 중'}
              </small>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={
                  loading ||
                  saving ||
                  !revision ||
                  loadedTargetIndex !== targetIndex ||
                  (!contents && !popularityRatioValid)
                }
                onClick={() => void save()}
              >
                {saving ? '저장 중...' : '전체 설정 저장'}
              </button>
            </div>
          </div>
        </header>
        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}
        {message && <div className={styles.successBanner}>{message}</div>}

        <section className={`${styles.card} ${styles.topSearchCard}`}>
          <div className={styles.searchBar}>
            <div className={styles.searchInput}>
              <input
                ref={queryInputRef}
                defaultValue=""
                maxLength={200}
                placeholder={SEARCH_QUERY_PLACEHOLDER}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void simulate(1);
                }}
              />
              <button
                type="button"
                aria-label="검색어 지우기"
                onClick={() => {
                  if (!queryInputRef.current) return;
                  queryInputRef.current.value = '';
                  queryInputRef.current.focus();
                }}
              >
                ×
              </button>
            </div>
            <select
              aria-label="정렬"
              value={sortConfigId}
              onChange={(event) => {
                setSortConfigId(event.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="">점수순</option>
              {sortConfigs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.description} ({config.sortName})
                </option>
              ))}
            </select>
            <select
              aria-label="페이지당 결과 수"
              value={resultSize}
              onChange={(event) => {
                const size = Number(event.target.value);
                setResultSize(size);
                setCurrentPage(1);
                if (queryInputRef.current?.value.trim()) void simulate(1, size);
              }}
            >
              <option value={10}>10개</option>
              <option value={30}>30개</option>
              <option value={50}>50개</option>
              <option value={100}>100개</option>
            </select>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={searching || loadedTargetIndex !== targetIndex}
              onClick={() => void simulate(1)}
            >
              {searching ? '검색 중...' : '검색'}
            </button>
          </div>
          {sortConfigId && (
            <p className={styles.sortNote}>
              사용자 지정 정렬이 최종 점수보다 우선합니다.
            </p>
          )}
        </section>

        <section className={`${styles.card} ${styles.searchAssistCard}`}>
          <div className={styles.searchAssistGrid}>
            {!contents && (
              <div className={styles.searchAssistOption}>
                <div className={styles.searchAssistOptionHeader}>
                  <div>
                    <h2>적응형 검색</h2>
                    <p>
                      짧고 명확한 검색은 키워드만 사용하고, 문장형·복합 검색은
                      키워드와 벡터를 함께 사용합니다.
                    </p>
                  </div>
                  <label className={styles.aiToggle}>
                    <input
                      aria-label="적응형 검색 사용"
                      type="checkbox"
                      checked={adaptiveSearch.enabled}
                      onChange={(event) => {
                        setAdaptiveSearch({ enabled: event.target.checked });
                        setSearchMode(null);
                      }}
                    />
                    사용
                  </label>
                </div>
              </div>
            )}

            {!contents && (
              <div className={styles.searchAssistOption}>
                <div className={styles.searchAssistOptionHeader}>
                  <div>
                    <h2>개인화 검색</h2>
                    <p>
                      장바구니·최근 본 상품·관심상품·주문 신호로 회원별 후보
                      순위를 보정합니다.
                    </p>
                  </div>
                  <label className={styles.aiToggle}>
                    <input
                      aria-label="개인화 검색 사용"
                      type="checkbox"
                      checked={personalization.enabled}
                      onChange={(event) =>
                        setPersonalization((value) => ({
                          ...value,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    사용
                  </label>
                </div>
                <label className={styles.testMemberField}>
                  <span>테스트 회원번호</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={testMemberNo}
                    onChange={(event) =>
                      setTestMemberNo(event.target.value.replace(/\D/g, ''))
                    }
                    placeholder="시뮬레이션 전용"
                  />
                </label>
                {testMemberNo && !personalization.enabled && (
                  <p className={styles.personalizationNote}>
                    개인화 사용을 켜야 테스트 회원번호가 적용됩니다.
                  </p>
                )}
                {personalization.enabled && sortConfigId && (
                  <p className={styles.personalizationNote}>
                    사용자 지정 정렬을 선택해 개인화가 생략됩니다.
                  </p>
                )}
              </div>
            )}

            <div className={styles.searchAssistOption}>
              <div className={styles.searchAssistOptionHeader}>
                <div>
                  <h2>AI 검색 보조</h2>
                  <p>
                    Gemini가 자연어 검색의 의도를 분석해 키워드와 의미 검색
                    문장을 확장합니다. 장애 시에는 원문 검색으로 자동
                    전환합니다.
                  </p>
                </div>
                <label className={styles.aiToggle}>
                  <input
                    aria-label="AI 검색 보조 사용"
                    type="checkbox"
                    checked={ai.enabled}
                    onChange={(event) => {
                      setAi({ enabled: event.target.checked });
                      setAiAnalysis(null);
                    }}
                  />
                  사용
                </label>
              </div>
            </div>
          </div>
          {ai.enabled && (
            <div className={styles.aiPanel}>
              <div>
                <span>모델</span>
                <strong>{aiRuntime.model || '-'}</strong>
              </div>
              <div>
                <span>API 설정</span>
                <strong
                  className={
                    aiRuntime.configured ? styles.aiReady : styles.aiUnavailable
                  }
                >
                  {aiRuntime.configured ? '사용 가능' : 'API 키 없음'}
                </strong>
              </div>
              {aiAnalysis && (
                <>
                  <div>
                    <span>이번 검색</span>
                    <strong>
                      {aiAnalysis.used
                        ? aiAnalysis.cached
                          ? '캐시 사용'
                          : 'AI 분석 사용'
                        : '원문 검색'}
                    </strong>
                  </div>
                  <div>
                    <span>토큰{aiAnalysis.cached ? ' (최초 호출)' : ''}</span>
                    <strong>
                      입력{' '}
                      {aiAnalysis.usage.inputTokens.toLocaleString('ko-KR')} ·
                      출력(사고 포함){' '}
                      {aiAnalysis.usage.outputTokens.toLocaleString('ko-KR')} ·
                      합계{' '}
                      {aiAnalysis.usage.totalTokens.toLocaleString('ko-KR')}
                    </strong>
                  </div>
                  <div>
                    <span>
                      예상 비용(표준 유료 · 환율 1,400원)
                      {aiAnalysis.cached
                        ? ' · 최초 호출 기준, 재사용 추가 비용 없음'
                        : ''}
                    </span>
                    <strong>
                      {(aiAnalysis.usage.estimatedCostUsd * 1400).toFixed(1)}원
                      (US${aiAnalysis.usage.estimatedCostUsd.toFixed(6)})
                    </strong>
                  </div>
                  <div>
                    <span>AI 처리시간</span>
                    <strong>
                      {aiAnalysis.durationMs.toLocaleString('ko-KR')}ms
                    </strong>
                  </div>
                  <div className={styles.aiWide}>
                    <span>확장 키워드</span>
                    <strong>{aiAnalysis.keywordQuery || '-'}</strong>
                  </div>
                  <div className={styles.aiWide}>
                    <span>의미 검색 문장</span>
                    <strong>{aiAnalysis.semanticQuery || '-'}</strong>
                  </div>
                  <div className={styles.aiWide}>
                    <span>추출 메타데이터</span>
                    <strong>
                      {[
                        aiAnalysis.intent,
                        ...aiAnalysis.metadata.categories,
                        ...aiAnalysis.metadata.seasons,
                        ...aiAnalysis.metadata.occasions,
                        ...aiAnalysis.metadata.attributes,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '-'}
                    </strong>
                  </div>
                  {aiAnalysis.error && (
                    <div className={styles.aiError}>{aiAnalysis.error}</div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <section id="search-weight-panel" className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <div className={styles.titleWithHelp}>
                <h2>검색 점수 시뮬레이터</h2>
                <span className={styles.helpTooltip}>
                  <button
                    type="button"
                    aria-label="검색 결과 순위 결정 방식 도움말"
                  >
                    ?
                  </button>
                  <span role="tooltip">
                    키워드 검색과 의미 검색에서 각각 높은 순위를 받은 상품일수록
                    최종 순위가 높아집니다. 두 검색에서 고르게 상위에 있는
                    상품이 더 유리합니다. 인기도를 사용하면 검색된 상품 안에서
                    판매금액·판매수량·조회수를 기준으로 순위를 추가 보정하며,
                    검색과 관련 없는 인기 상품이 새로 추가되지는 않습니다.
                  </span>
                </span>
              </div>
              <p>
                현재 화면의 미저장 검색 설정과 인기도 설정으로 결과를
                확인합니다.
              </p>
            </div>
          </div>
          {!!requestAnalysis?.removedRequestExpressions?.length && (
            <div className={styles.tokens}>
              <strong>정제 검색어</strong>
              <span>{requestAnalysis.cleanedQuery || '(없음)'}</span>
              <strong>제거한 요청 표현</strong>
              {requestAnalysis.removedRequestExpressions.map((phrase) => (
                <span key={phrase}>{phrase}</span>
              ))}
            </div>
          )}
          {(!!requestAnalysis?.tokenDiagnostics?.length ||
            !!requestAnalysis?.synonymExpansionDetails?.length) && (
            <div className={styles.tokens}>
              <strong>키워드</strong>
              {requestAnalysis.tokenDiagnostics?.map((item, index) => (
                <span
                  key={`${item.token}-${index}`}
                  className={item.used ? undefined : styles.tokenRemoved}
                  title={item.reason}
                >
                  {item.token}
                  {item.reason && <small>{item.reason}</small>}
                </span>
              ))}
              {requestAnalysis.synonymExpansionDetails?.map((item) => (
                <span
                  key={`synonym-${item.source}-${item.target}`}
                  className={styles.tokenAdded}
                >
                  {item.source} → {item.target}
                  <small>동의어</small>
                </span>
              ))}
            </div>
          )}
          {appliedFilters && appliedFilters.length > 0 && (
            <div className={styles.tokens}>
              <strong>적용 필터</strong>
              {appliedFilters.map((filter) => (
                <span key={filter.id}>
                  {filter.name}: {filter.field} · {filter.values.join(', ')}
                </span>
              ))}
            </div>
          )}
          {timings && timingWaterfall && (
            <div className={styles.timingBar}>
              <button
                type="button"
                className={styles.timingSummary}
                aria-expanded={timingExpanded}
                aria-controls="search-timing-waterfall"
                onClick={() => setTimingExpanded((value) => !value)}
              >
                <strong>단계별 속도</strong>
                <span
                  className={styles.productionEstimate}
                  title="시뮬레이터 전용 단계와 캐시 사용을 전제로 한 설정 조회를 제외하고, 병렬·포함 구간의 중복을 제거한 예상 시간입니다."
                >
                  운영 API 예상 속도{' '}
                  <b>
                    {estimateProductionSearchMs(
                      timingWaterfall.currentSearch.spans,
                    ).toLocaleString('ko-KR')}
                    ms
                  </b>
                </span>
                {searchMode && (
                  <span title={searchMode.reason}>
                    검색 방식{' '}
                    <b>
                      {searchMode.mode === 'hybrid' ? '하이브리드' : '키워드'}
                    </b>
                    <small className={styles.timingDetail}>
                      ({searchMode.reason})
                    </small>
                  </span>
                )}
                {(
                  [
                    [
                      '전체',
                      timings.simulationTotalMs,
                      '검색 버튼 요청부터 관리자 시뮬레이션 응답을 만들기까지 걸린 전체 시간입니다.',
                      timings.requestCacheStatus === 'shared'
                        ? '동시 요청 공유'
                        : null,
                    ],
                    [
                      '설정 조회',
                      timings.settingsMs,
                      '검색 가중치, 비즈니스 룰, 동의어·불용어와 검색 필터 설정을 조회한 시간입니다.',
                      cacheStatusLabel(timings.settingsCacheStatus),
                    ],
                    [
                      'ES 형태소 분석',
                      timings.morphologyAnalysisMs,
                      'Elasticsearch 분석기로 원문과 실제 키워드 검색어의 형태소를 분석한 시간입니다.',
                      null,
                    ],
                    [
                      '검색어 분석',
                      timings.queryAnalysisMs,
                      '필터 감지어를 처리하고 실제 키워드 검색에 사용할 형태소와 동의어를 구성한 시간입니다.',
                      null,
                    ],
                    [
                      'AI 확장',
                      timings.aiMs,
                      'Gemini가 검색 의도, 확장 키워드와 의미 검색 문장을 생성한 시간입니다.',
                      cacheStatusLabel(timings.aiCacheStatus),
                    ],
                    [
                      '벡터 생성',
                      timings.embeddingMs,
                      '의미 검색 문장을 임베딩 서버에 전달해 검색용 벡터를 생성한 시간입니다.',
                      cacheStatusLabel(timings.embeddingCacheStatus),
                    ],
                    [
                      '개인화 조회',
                      timings.personalizationMs ?? 0,
                      '공통·통계 Elasticsearch에서 회원 행동 프로필을 병렬 조회하거나 캐시에서 가져온 시간입니다.',
                      cacheStatusLabel(
                        timings.personalizationCacheStatus || 'skipped',
                      ),
                    ],
                    [
                      'ES 후보 조회',
                      timings.candidateSearchMs,
                      'Elasticsearch 후보 조회 전체 시간입니다.',
                      null,
                    ],
                    [
                      '순위 계산',
                      timings.rankingMs,
                      '후보의 RRF 점수를 합치고 인기도·개인화·비즈니스 룰·상품 고정을 적용해 순서를 결정한 시간입니다.',
                      null,
                    ],
                    [
                      '상품 조회',
                      timings.documentLoadMs,
                      '현재 페이지에 표시할 상품의 전체 문서를 조회한 시간입니다.',
                      null,
                    ],
                    [
                      '매칭 진단',
                      timings.keywordDiagnosticsMs,
                      '현재 페이지 상품의 키워드 매칭 필드와 하이라이트를 조회한 시간입니다.',
                      null,
                    ],
                  ] as const
                ).map(([label, value, description, cacheLabel]) => (
                  <span key={label} title={description}>
                    {label} <b>{value.toLocaleString('ko-KR')}ms</b>
                    {label === 'ES 후보 조회' && (
                      <small className={styles.timingDetail}>
                        (키워드 ES{' '}
                        {timings.keywordCandidateSearchMs.toLocaleString(
                          'ko-KR',
                        )}
                        ms · 벡터 ES{' '}
                        {timings.vectorCandidateSearchMs.toLocaleString(
                          'ko-KR',
                        )}
                        ms 병렬 처리)
                      </small>
                    )}
                    {cacheLabel && <em>{cacheLabel}</em>}
                  </span>
                ))}
                <i aria-hidden="true">{timingExpanded ? '⌃' : '⌄'}</i>
              </button>
              {timingExpanded && (
                <div
                  id="search-timing-waterfall"
                  className={styles.timingExpanded}
                  role="region"
                  aria-label="검색 시간 상세"
                >
                  <Waterfall
                    title="시뮬레이션 전체"
                    totalMs={timingWaterfall.simulation.totalMs}
                    spans={mergeCurrentSearchSpans(
                      timingWaterfall.simulation.spans,
                      timingWaterfall.currentSearch.spans,
                    )}
                  />
                </div>
              )}
            </div>
          )}
          <div className={styles.comparisonLayout}>
            <div className={styles.currentResultPanel}>
              <div className={styles.comparisonHeader}>
                <h3>검색엔진</h3>
                <span>{total.toLocaleString('ko-KR')}건</span>
              </div>
              <div className={styles.resultTableWrapper}>
                <table className={styles.resultTable}>
                  <thead>
                    <tr>
                      <th className={styles.rankColumn}>순위</th>
                      <th className={styles.productColumn}>
                        {contents ? '콘텐츠' : '상품'}
                      </th>
                      <th className={styles.totalColumn}>RRF 총점</th>
                      <th className={styles.rrfColumn}>키워드 RRF</th>
                      {!contents && (
                        <th className={styles.rrfColumn}>벡터 RRF</th>
                      )}
                      {!contents && (
                        <th className={styles.popularityColumn}>인기도</th>
                      )}
                      {!contents && (
                        <th className={styles.personalizationColumn}>
                          개인화
                          {personalizationSimulation?.memberNo && (
                            <small>
                              회원 {personalizationSimulation.memberNo}
                            </small>
                          )}
                        </th>
                      )}
                      <th className={styles.ruleColumn}>룰/필터</th>
                      {sortConfigId && (
                        <th className={styles.sortColumn}>정렬</th>
                      )}
                      <th className={styles.matchingColumn}>매칭</th>
                      {!contents && (
                        <th className={styles.legacyColumn}>기본 키워드 검색 상품</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr>
                        <td
                          colSpan={
                            (sortConfigId ? 11 : 10) - (contents ? 4 : 0)
                          }
                          className={styles.empty}
                        >
                          {searching
                            ? '검색 중입니다.'
                            : '검색 결과가 없습니다.'}
                        </td>
                      </tr>
                    )}
                    {items.map((item, index) => {
                      const imageUrl = productImageUrl(item.img_path);
                      const contentUrl =
                        contents && item.url
                          ? contentPageUrl(item.url)
                          : null;
                      const legacyItem = legacy?.items[index];
                      const legacyImageUrl = productImageUrl(
                        legacyItem?.imgPath || undefined,
                      );
                      return (
                        <tr key={item.id || index}>
                          <td className={styles.rankColumn}>
                            {(currentPage - 1) * resultSize + index + 1}
                          </td>
                          <td className={styles.productColumn}>
                            <div className={styles.productCell}>
                              {imageUrl ? (
                                <Image
                                  className={styles.productThumbnail}
                                  src={imageUrl}
                                  alt=""
                                  width={48}
                                  height={62}
                                  unoptimized
                                />
                              ) : (
                                <span
                                  className={styles.productImagePlaceholder}
                                >
                                  NO IMAGE
                                </span>
                              )}
                              <div className={styles.productIdentity}>
                                <strong>
                                  {item.title ||
                                    item.goods_nm ||
                                    item.onl_goods_nm ||
                                    item.goods_id ||
                                    item.id}
                                </strong>
                                <span>
                                  {contents
                                    ? `${item.contents_div || '-'} · ${item.contents_no || '-'}`
                                    : `${item.bnd_nm_ko || '-'} · ${item.goods_id || item.id}`}
                                </span>
                                {contents && (
                                  <span>{item.sub_title || ''}</span>
                                )}
                                {contents && (
                                  <span>
                                    {formatContentDateTime(item.disp_strt_dtm)}{' '}
                                    ~ {formatContentDateTime(item.disp_end_dtm)}
                                  </span>
                                )}
                                {contentUrl && (
                                  <a
                                    href={contentUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    콘텐츠 보기
                                  </a>
                                )}
                                {!contents && (
                                  <span className={styles.productPrice}>
                                    <b>{formatPrice(item.sale_amt)}</b>
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className={styles.totalColumn}>
                            <div
                              className={`${styles.scoreCell} ${styles.totalScoreCell}`}
                            >
                              <strong>{formatScore(item.scores.total)}</strong>
                              <span>
                                RRF {formatScore(item.scores.rrfTotal)}
                              </span>
                              {!contents && (
                                <span>
                                  (키워드 {formatScore(item.scores.keyword)} +
                                  벡터 {formatScore(item.scores.vector)}) ×
                                  인기도{' '}
                                  {formatAdjustmentPercent(
                                    item.scores.popularityBoost,
                                  )}
                                  {` × 카테고리 ${formatScore(item.scores.categoryAdjustment?.multiplier)}`}
                                  {item.scores.personalization
                                    ? ` × 개인화 ${formatScore(item.scores.personalization.multiplier)}`
                                    : ''}
                                  {item.scores.businessRules
                                    ?.map(
                                      (rule) =>
                                        ` × ${rule.name} ${formatAdjustmentPercent(rule.adjustment)}`,
                                    )
                                    .join('')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className={styles.rrfColumn}>
                            <div className={styles.scoreCell}>
                              <strong>
                                {formatScore(item.scores.keyword)}
                              </strong>
                              <span>순위 {item.scores.keywordRank ?? '-'}</span>
                              <span>
                                원점수 {formatScore(item.scores.keywordRaw)}
                              </span>
                            </div>
                          </td>
                          {!contents && (
                            <td className={styles.rrfColumn}>
                              <div className={styles.scoreCell}>
                                <strong>
                                  {formatScore(item.scores.vector)}
                                </strong>
                                <span>
                                  순위 {item.scores.vectorRank ?? '-'}
                                </span>
                                <span>
                                  원점수 {formatScore(item.scores.vectorRaw)}
                                </span>
                              </div>
                            </td>
                          )}
                          {!contents && (
                            <td className={styles.popularityColumn}>
                              <div className={styles.scoreCell}>
                                <strong>
                                  {formatAdjustmentPercent(
                                    item.scores.popularityBoost,
                                  )}
                                </strong>
                                <span>
                                  정규화{' '}
                                  {formatScore(
                                    item.scores.popularityNormalized,
                                  )}
                                </span>
                                <span>
                                  원본 {formatScore(item.scores.popularityRaw)}
                                </span>
                              </div>
                            </td>
                          )}
                          {!contents && (
                            <td className={styles.personalizationColumn}>
                              <div className={styles.scoreCell}>
                                {item.scores.personalization ? (
                                  (() => {
                                    if (
                                      item.scores.personalization.boost <= 0
                                    ) {
                                      return <span>보정없음</span>;
                                    }
                                    return (
                                      <>
                                        <strong>
                                          {formatAdjustmentPercent(
                                            item.scores.personalization.boost,
                                          )}
                                        </strong>
                                        {item.scores.personalization
                                          .sourceBoosts && (
                                          <>
                                            <span>
                                              장바구니{' '}
                                              {formatAdjustmentPercent(
                                                item.scores.personalization
                                                  .sourceBoosts.cart,
                                              )}
                                            </span>
                                            <span>
                                              최근 본 상품{' '}
                                              {formatAdjustmentPercent(
                                                item.scores.personalization
                                                  .sourceBoosts.recent,
                                              )}
                                            </span>
                                            <span>
                                              관심상품{' '}
                                              {formatAdjustmentPercent(
                                                item.scores.personalization
                                                  .sourceBoosts.wish,
                                              )}
                                            </span>
                                            <span>
                                              주문{' '}
                                              {formatAdjustmentPercent(
                                                item.scores.personalization
                                                  .sourceBoosts.order,
                                              )}
                                            </span>
                                          </>
                                        )}
                                      </>
                                    );
                                  })()
                                ) : (
                                  <span>
                                    {!personalizationSimulation?.config.enabled
                                      ? '사용 안 함'
                                      : !personalizationSimulation.memberNo
                                        ? '회원번호 없음'
                                        : personalizationSimulation.sortConfigId
                                          ? '사용자 정렬로 생략'
                                          : '프로필 미적용'}
                                  </span>
                                )}
                              </div>
                            </td>
                          )}
                          <td className={styles.ruleColumn}>
                            <div className={styles.ruleEvidence}>
                              {item.pinning && (
                                <strong>
                                  {item.pinning.query} 검색 시{' '}
                                  {item.pinning.appliedPosition}위 고정
                                </strong>
                              )}
                              {item.scores.categoryAdjustment && (
                                <div>
                                  <b
                                    className={
                                      item.scores.categoryAdjustment.status ===
                                      'match'
                                        ? styles.ruleBoost
                                        : item.scores.categoryAdjustment
                                              .status === 'mismatch'
                                          ? styles.rulePenalty
                                          : undefined
                                    }
                                  >
                                    카테고리{' '}
                                    {item.scores.categoryAdjustment.status ===
                                    'match'
                                      ? '일치'
                                      : item.scores.categoryAdjustment
                                            .status === 'mismatch'
                                        ? '불일치'
                                        : '미감지'}{' '}
                                    ×
                                    {Number(
                                      item.scores.categoryAdjustment.multiplier.toFixed(
                                        2,
                                      ),
                                    )}
                                  </b>
                                  {item.scores.categoryAdjustment.status ===
                                    'match' && (
                                    <span>
                                      {item.scores.categoryAdjustment.actualCategories.join(
                                        ' > ',
                                      )}
                                    </span>
                                  )}
                                </div>
                              )}
                              {item.scores.businessRules?.map((rule) => (
                                <div key={rule.id}>
                                  <b
                                    className={`${rule.adjustment < 0 ? styles.rulePenalty : styles.ruleBoost} ${styles.ruleTooltipTarget}`}
                                    aria-label={businessRuleTooltip(rule)}
                                    tabIndex={0}
                                    onMouseEnter={(event) =>
                                      showRuleTooltip(
                                        event.currentTarget,
                                        businessRuleTooltip(rule),
                                      )
                                    }
                                    onMouseLeave={() => setRuleTooltip(null)}
                                    onFocus={(event) =>
                                      showRuleTooltip(
                                        event.currentTarget,
                                        businessRuleTooltip(rule),
                                      )
                                    }
                                    onBlur={() => setRuleTooltip(null)}
                                    onClick={(event) =>
                                      showRuleTooltip(
                                        event.currentTarget,
                                        businessRuleTooltip(rule),
                                      )
                                    }
                                  >
                                    {rule.name}{' '}
                                    {formatAdjustmentPercent(rule.adjustment)}
                                  </b>
                                </div>
                              ))}
                              {appliedFilters?.map((filter) => (
                                <div key={`filter-${filter.id}`}>
                                  <b>{filter.name}</b>
                                  <span>{formatAppliedFilter(filter)}</span>
                                </div>
                              ))}
                              {!item.pinning &&
                                !item.scores.businessRules?.length &&
                                !item.scores.categoryAdjustment &&
                                !appliedFilters?.length && (
                                  <span>적용 없음</span>
                                )}
                            </div>
                          </td>
                          {sortConfigId && (
                            <td className={styles.sortColumn}>
                              <div className={styles.sortEvidence}>
                                {item.sortExplanation?.fields.map((field) => (
                                  <div key={field.field}>
                                    <code>{field.field}</code>
                                    <strong>
                                      {field.state === 'absent'
                                        ? '원본값 없음'
                                        : formatSortValue(field.value)}
                                    </strong>
                                    {field.sourcePath &&
                                      field.sourcePath !== field.field && (
                                        <small>원본: {field.sourcePath}</small>
                                      )}
                                  </div>
                                ))}
                                <p>
                                  <span>ES 정렬값</span>
                                  <code>
                                    {formatSortValue(
                                      item.sortExplanation?.sortValues,
                                    )}
                                  </code>
                                </p>
                                {item.sortExplanation?.scoreTiebreaker !==
                                  null &&
                                  item.sortExplanation?.scoreTiebreaker !==
                                    undefined && (
                                    <p>
                                      <span>동점 보정 점수</span>
                                      <code>
                                        {formatSortValue(
                                          item.sortExplanation.scoreTiebreaker,
                                        )}
                                      </code>
                                    </p>
                                  )}
                              </div>
                            </td>
                          )}
                          <td className={styles.matchingColumn}>
                            <button
                              type="button"
                              className={styles.matchingButton}
                              onClick={() => setMatchingItem(item)}
                            >
                              결과
                            </button>
                          </td>
                          {!contents && (
                            <td className={styles.legacyColumn}>
                              {legacyItem ? (
                                <div className={styles.productCell}>
                                  {legacyImageUrl ? (
                                    <Image
                                      className={styles.productThumbnail}
                                      src={legacyImageUrl}
                                      alt=""
                                      width={48}
                                      height={62}
                                      unoptimized
                                    />
                                  ) : (
                                    <span
                                      className={styles.productImagePlaceholder}
                                    >
                                      NO IMAGE
                                    </span>
                                  )}
                                  <div className={styles.productIdentity}>
                                    <strong>
                                      {legacyItem.name ||
                                        legacyItem.goodsId ||
                                        '-'}
                                    </strong>
                                    <span>
                                      {legacyItem.brand || '-'} ·{' '}
                                      {legacyItem.goodsId || '-'}
                                    </span>
                                    <span className={styles.productPrice}>
                                      <b>
                                        {formatPrice(
                                          legacyItem.saleAmt ?? undefined,
                                        )}
                                      </b>
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <span className={styles.legacyEmpty}>
                                  {legacy?.error || '-'}
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.pagination}>
                <span>총 {total.toLocaleString('ko-KR')}건</span>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={searching || currentPage <= 1}
                  onClick={() => void simulate(currentPage - 1)}
                >
                  이전
                </button>
                <strong>
                  {currentPage} / {totalPages}
                </strong>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={searching || currentPage >= totalPages}
                  onClick={() => void simulate(currentPage + 1)}
                >
                  다음
                </button>
              </div>
            </div>
          </div>
        </section>

        {matchingItem && (
          <div
            className={styles.modalBackdrop}
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setMatchingItem(null);
            }}
          >
            <section
              className={styles.matchingModal}
              role="dialog"
              aria-modal="true"
              aria-labelledby="matching-result-title"
            >
              <header className={styles.matchingModalHeader}>
                <div>
                  <h2 id="matching-result-title">매칭 결과</h2>
                  <p>
                    {matchingItem.onl_goods_nm || matchingItem.goods_nm} ·{' '}
                    {matchingItem.goods_id || matchingItem.id}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.modalCloseButton}
                  aria-label="매칭 결과 닫기"
                  autoFocus
                  onClick={() => setMatchingItem(null)}
                >
                  ×
                </button>
              </header>
              <div className={styles.matchingModalBody}>
                <div className={styles.diagnostics}>
                  <p>키워드 매칭 필드</p>
                  {matchingItem.matchedFields.length ? (
                    matchingItem.matchedFields.map((matched) => (
                      <div key={matched.field}>
                        <div className={styles.diagnosticHeader}>
                          <code>
                            {matched.field}^{matched.boost}
                          </code>
                          <strong>
                            {formatScore(matched.diagnosticScore)}
                          </strong>
                        </div>
                        <div className={styles.matchedValues}>
                          {matched.highlightedValues.length ? (
                            matched.highlightedValues.map((value, index) => (
                              <p key={index}>{renderHighlightedValue(value)}</p>
                            ))
                          ) : (
                            <p>{formatSortValue(matched.matchedValue)}</p>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <span>매칭된 키워드 필드가 없습니다.</span>
                  )}
                  <section className={styles.embeddingSentence}>
                    <strong>조립된 전체 임베딩 문장</strong>
                    <p>
                      {matchingItem.embeddingText || '저장된 임베딩 문장이 없습니다. 변경 문서 벡터화를 실행한 뒤 확인하세요.'}
                    </p>
                  </section>
                </div>
              </div>
            </section>
          </div>
        )}

        {!contents && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h2>인기도 보정</h2>
                <p>
                  키워드·벡터 후보 안에서 판매금액, 판매수량, 조회수의 비중을
                  적용합니다.
                </p>
              </div>
              <label className={styles.aiToggle}>
                <input
                  type="checkbox"
                  checked={popularity.enabled}
                  onChange={(event) =>
                    setPopularity((value) => ({
                      ...value,
                      enabled: event.target.checked,
                    }))
                  }
                />
                인기도 사용
              </label>
            </div>
            <div className={styles.popularityControls}>
              <div className={styles.popularityMainRow}>
                <label className={styles.popularityWeight}>
                  최대 보정률 (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(popularity.weight * 100)}
                    onChange={(event) =>
                      setPopularity((value) => ({
                        ...value,
                        weight: Number(event.target.value) / 100,
                      }))
                    }
                  />
                </label>
                <label>
                  판매금액 기간
                  <select
                    value={popularity.amountField}
                    onChange={(event) =>
                      setPopularity((value) => ({
                        ...value,
                        amountField: event.target
                          .value as PopularityAmountField,
                      }))
                    }
                  >
                    <option value="day_amt">일 판매금액</option>
                    <option value="week_amt">주 판매금액</option>
                    <option value="month_amt">월 판매금액</option>
                  </select>
                </label>
                <label>
                  판매금액
                  <span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(popularity.amountRatio * 100)}
                      onChange={(event) =>
                        setPopularity((value) => ({
                          ...value,
                          amountRatio: Number(event.target.value) / 100,
                        }))
                      }
                    />
                    %
                  </span>
                </label>
                <label>
                  판매수량 기간
                  <select
                    value={popularity.quantityField}
                    onChange={(event) =>
                      setPopularity((value) => ({
                        ...value,
                        quantityField: event.target
                          .value as PopularityQuantityField,
                      }))
                    }
                  >
                    <option value="day_ord_cnt">일 주문수량</option>
                    <option value="week_ord_cnt">주 주문수량</option>
                    <option value="month_ord_cnt">월 주문수량</option>
                  </select>
                </label>
                <label>
                  판매수량
                  <span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(popularity.quantityRatio * 100)}
                      onChange={(event) =>
                        setPopularity((value) => ({
                          ...value,
                          quantityRatio: Number(event.target.value) / 100,
                        }))
                      }
                    />
                    %
                  </span>
                </label>
                <label>
                  조회수
                  <span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(popularity.hitsRatio * 100)}
                      onChange={(event) =>
                        setPopularity((value) => ({
                          ...value,
                          hitsRatio: Number(event.target.value) / 100,
                        }))
                      }
                    />
                    %
                  </span>
                </label>
                <strong
                  className={
                    popularityRatioValid
                      ? styles.ratioValid
                      : styles.ratioInvalid
                  }
                >
                  합계{' '}
                  {Math.round(
                    (popularity.amountRatio +
                      popularity.quantityRatio +
                      popularity.hitsRatio) *
                      100,
                  )}
                  %
                </strong>
              </div>
              <div className={styles.popularityMethods}>
                <strong>인기도 적용방식</strong>
                {(
                  [
                    [
                      'max',
                      '최대값',
                      '전체 검색 후보 중 인기도가 가장 높은 상품을 최대 보정 기준으로 사용합니다.',
                    ],
                    [
                      'topPercent',
                      '상위',
                      '인기도가 0보다 큰 후보 중 설정한 상위 비율의 경계값을 기준으로 사용합니다. 기준 이상 상품은 모두 최대 보정을 받습니다.',
                    ],
                    [
                      'log',
                      '로그',
                      '큰 인기도 값의 차이를 줄여 중간 인기도 상품도 비교적 강하게 보정합니다.',
                    ],
                  ] as const
                ).map(([method, label, description]) => (
                  <label key={method}>
                    <input
                      type="radio"
                      name="popularity-normalization"
                      checked={popularity.normalizationMethod === method}
                      onChange={() =>
                        setPopularity((value) => ({
                          ...value,
                          normalizationMethod:
                            method as PopularityNormalizationMethod,
                        }))
                      }
                    />
                    {label}
                    {method === 'topPercent' && (
                      <span className={styles.topPercentInput}>
                        <input
                          type="number"
                          min="1"
                          max="50"
                          step="1"
                          value={popularity.topPercent}
                          disabled={
                            popularity.normalizationMethod !== 'topPercent'
                          }
                          onChange={(event) =>
                            setPopularity((value) => ({
                              ...value,
                              topPercent: Number(event.target.value),
                            }))
                          }
                          aria-label="상위 기준 비율"
                        />
                        %
                      </span>
                    )}
                    <HelpTooltip text={description} />
                  </label>
                ))}
              </div>
              <div className={styles.popularityFormula}>
                <span>스코어 계산식 (power)</span>
                <code>
                  단가 ^ 판매금액 비중 × 판매수량 ^ 판매수량 비중 × 조회수 ^
                  조회수 비중
                </code>
              </div>
            </div>
          </section>
        )}

        {!contents && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h2>카테고리 일치 보정</h2>
                <p>
                  상품 카테고리 경로의 세그먼트를 자동 감지하고, 최종 점수에
                  반영합니다. 상품을 제외하지 않습니다.
                </p>
              </div>
              <label className={styles.aiToggle}>
                <input
                  type="checkbox"
                  checked={categoryAdjustment.enabled}
                  onChange={(event) =>
                    setCategoryAdjustment((value) => ({
                      ...value,
                      enabled: event.target.checked,
                    }))
                  }
                />
                카테고리 보정 사용
              </label>
            </div>
            <div className={styles.categoryAdjustmentControls}>
              {(
                [
                  ['일치 배율', 'matchMultiplier'],
                  ['불일치 배율', 'mismatchMultiplier'],
                  ['감지 안 됨 배율', 'undetectedMultiplier'],
                ] as const
              ).map(([label, key]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min="0.1"
                    max="5"
                    step="0.05"
                    value={categoryAdjustment[key]}
                    onChange={(event) =>
                      setCategoryAdjustment((value) => ({
                        ...value,
                        [key]: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              ))}
              <p className={styles.categoryAdjustmentHint}>
                실제 카테고리 {categoryOptions.length.toLocaleString('ko-KR')}
                개를 색인 경로에서 자동 수집합니다. 원문과 동의어 확장 결과에서
                감지된 카테고리를 모두 보정합니다.
              </p>
            </div>
          </section>
        )}

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2>키워드 검색 필드 및 가중치</h2>
              <p>
                <code>bnd_nm_ko^200</code>처럼 Elasticsearch 키워드 점수에
                적용되는 필드와 Boost입니다.
              </p>
            </div>
            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() =>
                  setFields((current) => [
                    ...current,
                    { field: '', boost: 10, enabled: true },
                  ])
                }
              >
                ＋ 필드 추가
              </button>
            </div>
          </div>
          <div className={styles.fieldTableWrapper}>
            <table className={styles.fieldTable}>
              <thead>
                <tr>
                  <th>순서</th>
                  <th>검색 필드</th>
                  <th>Boost</th>
                  <th>사용</th>
                  <th>삭제</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field, index) => (
                  <tr key={`${index}-${field.field}`}>
                    <td>{index + 1}</td>
                    <td>
                      <input
                        list="searchable-fields"
                        value={field.field}
                        placeholder="예: goods_nm"
                        onChange={(event) =>
                          updateField(index, { field: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0.1"
                        max="1000"
                        step="0.1"
                        value={field.boost}
                        onChange={(event) =>
                          updateField(index, {
                            boost: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      <label className={styles.switch}>
                        <input
                          type="checkbox"
                          checked={field.enabled}
                          onChange={(event) =>
                            updateField(index, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span />
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.deleteButton}
                        onClick={() =>
                          setFields((current) =>
                            current.filter(
                              (_, fieldIndex) => fieldIndex !== index,
                            ),
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
          </div>
          <datalist id="searchable-fields">
            {availableFields.map((field) => (
              <option key={field} value={field} />
            ))}
          </datalist>
        </section>
      </div>
      {ruleTooltip && (
        <div
          className={styles.floatingRuleTooltip}
          role="tooltip"
          style={{ left: ruleTooltip.left, top: ruleTooltip.top }}
        >
          {ruleTooltip.text}
        </div>
      )}
    </AdminLayout>
  );
}
