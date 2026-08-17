/**
 * 立体税制（v0.4，核心新增）：
 *  - 六税种：土地税 / 人头税 / 消费税 / 关税 / 其他特别税 + 单一商品税（全部 17 商品可选）
 *  - 每税种独立连续滑块 0%-30%（TAX_MAX），默认合理值按国家（nations.ts taxDefaults）
 *  - 阶级负担矩阵：各税种按阶级征收系数不同（CLASS_TAX_MATRIX）——
 *      土地税 → 持地者（地主/大贵族/富农/自耕农，landCoef 系）
 *      人头税 → 全体自由民（奴隶免征）
 *      消费税 → 消费者（市民/工匠/工人/职员等）
 *      关税   → 贸易者（商人/资本家，按进出口额）
 *      特别税 → 运力/港口/印花（按贸易与运输量）
 *  - 商品税：买方支付有效价 = 市价 × (1+税率)；收入 = 税率 × 成交量进国库；
 *      输入品征税 → 下游制造成本↑（按税后价计）→ 成品价格随成本上升（传导进市场定价，见 market.ts）
 *  - 盐回归普通商品：不再有盐税专档，盐走供需定价（可被选作单一商品税对象）
 */
import type { ClassId, GoodId } from './types';
import { GOODS_LIST } from './market';
import { PROGRESSIVE_TAX_MULT } from './classes';

/** 五类非商品税种（第六种 = 单一商品税，按商品独立滑块） */
export type TaxKind = 'land' | 'poll' | 'consumption' | 'tariff' | 'other';

export const TAX_KINDS: TaxKind[] = ['land', 'poll', 'consumption', 'tariff', 'other'];

/** 税率上限（连续滑块 0%-30%） */
export const TAX_MAX = 0.3;
/** 滑块步进（0.5%） */
export const TAX_STEP = 0.005;

export const TAX_LABEL: Record<TaxKind, string> = {
  land: '土地税',
  poll: '人头税',
  consumption: '消费税',
  tariff: '关税',
  other: '特别税',
};

export const TAX_DESC: Record<TaxKind, string> = {
  land: '持地者：地主/大贵族/富农/自耕农',
  poll: '全体自由民（奴隶免征）',
  consumption: '消费者：市民/工匠/工人/职员等',
  tariff: '贸易者：商人/资本家（按进出口额）',
  other: '运力/港口/印花：按贸易与运输量',
};

/** 国家税制状态（写入存档） */
export interface NationTax {
  /** 五税种税率 0-1（滑块 0%-30%） */
  rates: Record<TaxKind, number>;
  /** 单一商品税：全部商品可选，0-1（0.15 = 15%） */
  goods: Record<GoodId, number>;
}

/** 阶级负担矩阵：各税种按阶级的征收系数（沿用 classes.ts 思路扩展为 per-tax） */
export const CLASS_TAX_MATRIX: Record<TaxKind, Record<ClassId, number>> = {
  // 土地税：持地者——地主/大贵族/富农/自耕农（奴隶无地）
  land: { 1: 1.8, 2: 1.4, 3: 1.0, 4: 0.6, 5: 0.3, 6: 0.1, 7: 0 },
  // 人头税：全体自由民，奴隶免征
  poll: { 1: 0.2, 2: 0.4, 3: 0.7, 4: 1.0, 5: 1.3, 6: 1.6, 7: 0 },
  // 消费税：消费者——市民/工匠/工人/职员等
  consumption: { 1: 0.3, 2: 0.5, 3: 0.8, 4: 1.1, 5: 1.4, 6: 1.2, 7: 0.3 },
  // 关税：贸易者——商人/资本家（进出口额）
  tariff: { 1: 0.5, 2: 1.5, 3: 1.2, 4: 0.9, 5: 0.3, 6: 0.1, 7: 0 },
  // 特别税：运力/港口/印花——按贸易与运输量
  other: { 1: 0.3, 2: 1.4, 3: 1.3, 4: 1.0, 5: 0.5, 6: 0.2, 7: 0 },
};

/** 某阶级在某税种下的实际征收系数（含累进税修正：上层↑下层↓） */
export function classTaxCoefFor(kind: TaxKind, c: ClassId, progressive: boolean): number {
  let base = CLASS_TAX_MATRIX[kind][c];
  if (progressive && (kind === 'poll' || kind === 'consumption' || kind === 'land')) {
    base *= PROGRESSIVE_TAX_MULT[c];
  }
  return base;
}

/** 默认商品税：全部 0（盐回归普通商品，无专档） */
export function zeroGoodsTax(): Record<GoodId, number> {
  const out = {} as Record<GoodId, number>;
  for (const g of GOODS_LIST) out[g] = 0;
  return out;
}

/** 默认税率（可按国家覆盖） */
export const DEFAULT_TAX_RATES: Record<TaxKind, number> = {
  land: 0.12,
  poll: 0.12,
  consumption: 0.1,
  tariff: 0.12,
  other: 0.08,
};

export function defaultNationTax(overrides?: Partial<Record<TaxKind, number>>): NationTax {
  return {
    rates: {
      land: overrides?.land ?? DEFAULT_TAX_RATES.land,
      poll: overrides?.poll ?? DEFAULT_TAX_RATES.poll,
      consumption: overrides?.consumption ?? DEFAULT_TAX_RATES.consumption,
      tariff: overrides?.tariff ?? DEFAULT_TAX_RATES.tariff,
      other: overrides?.other ?? DEFAULT_TAX_RATES.other,
    },
    goods: zeroGoodsTax(),
  };
}

export function clampTax(v: number): number {
  return Math.min(TAX_MAX, Math.max(0, v));
}

/**
 * 综合税负（加权 0-0.3）：五税种均值 × 0.7 + 商品税均值 × 0.3。
 * 用于稳定度惩罚 / 人口增长系数 / 幸福度税负。
 */
export function weightedTaxRate(tax: NationTax): number {
  const five =
    (tax.rates.land + tax.rates.poll + tax.rates.consumption + tax.rates.tariff + tax.rates.other) / 5;
  let goodsSum = 0;
  for (const g of GOODS_LIST) goodsSum += tax.goods[g];
  const goodsAvg = goodsSum / GOODS_LIST.length;
  return five * 0.7 + goodsAvg * 0.3;
}

/** 稳定度惩罚（全满 30% → 惩罚 18） */
export function taxPenalty(tax: NationTax): number {
  return 60 * weightedTaxRate(tax);
}

/** 人口增长政策系数（重税 → 增长低；替换 v0.3 POLICY_GROWTH 税率档） */
export function policyGrowthCoef(tax: NationTax): number {
  return 1 - weightedTaxRate(tax) * 0.5;
}
