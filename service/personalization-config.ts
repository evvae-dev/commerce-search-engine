export interface PersonalizationSourceConfig {
  days: number;
  weight: number;
}

export interface PersonalizationConfig {
  enabled: boolean;
  sources: {
    cart: PersonalizationSourceConfig;
    recent: PersonalizationSourceConfig;
    wish: PersonalizationSourceConfig;
    order: PersonalizationSourceConfig;
  };
  dimensions: { product: number; brand: number; category: number };
  maxBoost: number;
  cacheTtlMs: number;
}

export const DEFAULT_PERSONALIZATION: PersonalizationConfig = {
  enabled: false,
  sources: {
    cart: { days: 30, weight: 0.2 },
    recent: { days: 30, weight: 0.1 },
    wish: { days: 180, weight: 0.3 },
    order: { days: 365, weight: 0.4 },
  },
  dimensions: { product: 0.6, brand: 0.25, category: 0.15 },
  maxBoost: 0.3,
  cacheTtlMs: 600000,
};

function ratio(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function days(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : fallback;
}

export function validatePersonalizationConfig(input: unknown): PersonalizationConfig {
  const raw = input && typeof input === 'object' ? input as Partial<PersonalizationConfig> : {};
  const sources = raw.sources || {} as PersonalizationConfig['sources'];
  const dimensions = raw.dimensions || {} as PersonalizationConfig['dimensions'];
  const result: PersonalizationConfig = {
    enabled: raw.enabled === true,
    sources: {
      cart: { days: days(sources.cart?.days, 30), weight: ratio(sources.cart?.weight, 0.2) },
      recent: { days: days(sources.recent?.days, 30), weight: ratio(sources.recent?.weight, 0.1) },
      wish: { days: days(sources.wish?.days, 180), weight: ratio(sources.wish?.weight, 0.3) },
      order: { days: days(sources.order?.days, 365), weight: ratio(sources.order?.weight, 0.4) },
    },
    dimensions: {
      product: ratio(dimensions.product, 0.6),
      brand: ratio(dimensions.brand, 0.25),
      category: ratio(dimensions.category, 0.15),
    },
    maxBoost: ratio(raw.maxBoost, 0.3),
    cacheTtlMs: Number.isInteger(Number(raw.cacheTtlMs)) && Number(raw.cacheTtlMs) >= 300000 && Number(raw.cacheTtlMs) <= 900000 ? Number(raw.cacheTtlMs) : 600000,
  };
  const sourceTotal = Object.values(result.sources).reduce((sum, source) => sum + source.weight, 0);
  const dimensionTotal = Object.values(result.dimensions).reduce((sum, value) => sum + value, 0);
  if (Math.abs(sourceTotal - 1) > 0.000001) throw new Error('개인화 항목별 비중 합계는 100%여야 합니다.');
  if (Math.abs(dimensionTotal - 1) > 0.000001) throw new Error('상품·브랜드·카테고리 비중 합계는 100%여야 합니다.');
  return result;
}
