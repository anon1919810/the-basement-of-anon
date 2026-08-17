/**
 * 国家市场与简化国际贸易（v0.1）：
 *  - 国家市场：每种商品供需定价 实际价 = 基础价 × 供需比（供>求跌、供<求涨，clamp 0.4~2.5 倍）
 *  - 商品：粮食/衣物/燃料/工业品（奢侈品留 v0.2）
 *  - 简化国际贸易：省内盈余>需求 → 按世界价出口（+关税收入）；缺口 → 进口补足（扣关税）
 *    贸易额受商路（海路/陆路）与运费影响（routeCoef 由基建导出）
 */
import type { GoodId, TaxLevel } from './types';
import { clamp } from './pops';

export const GOODS_LIST: GoodId[] = ['food', 'clothing', 'fuel', 'industrial'];

/** 基础价（万₭/单位） */
export const BASE_PRICE: Record<GoodId, number> = {
  food: 2.0,
  clothing: 1.8,
  fuel: 1.5,
  industrial: 2.4,
};

/** 世界价（略高于本国基础价：外部市场更大） */
export const WORLD_PRICE: Record<GoodId, number> = {
  food: 2.4,
  clothing: 2.6,
  fuel: 2.0,
  industrial: 2.8,
};

/** 价格上下限（基础价 × 系数） */
export const PRICE_CLAMP_MIN = 0.4;
export const PRICE_CLAMP_MAX = 2.5;

/** 基础月出口/进口容量（单位/月，基建可提升） */
export const BASE_TRADE_CAP: Record<GoodId, number> = {
  food: 3.0,
  clothing: 2.2,
  fuel: 2.6,
  industrial: 1.6,
};

/** 关税税率档（来自税率档） */
export const TARIFF_RATE: Record<TaxLevel, number> = {
  light: 0.1,
  medium: 0.15,
  heavy: 0.22,
  oppressive: 0.3,
};

export interface MarketGood {
  basePrice: number;
  /** 当前价（万₭/单位） */
  price: number;
  prevPrice: number;
  /** 上月供给（产出） */
  supply: number;
  /** 上月需求（消费+政府） */
  demand: number;
  /** 上月实际消费 */
  consumed: number;
  exported: number;
  imported: number;
  /** 未满足需求（饥荒/短缺，→ 幸福度惩罚） */
  unmet: number;
  /** 价格趋势（相对上月，-1..） */
  trend: number;
}

export interface MarketSnapshot {
  /** 各商品市场状态 */
  goods: Record<GoodId, MarketGood>;
  /** 本月关税收入（万₭） */
  tariff: number;
  exportValue: number;
  importValue: number;
}

export function newMarket(): Record<GoodId, MarketGood> {
  const out = {} as Record<GoodId, MarketGood>;
  for (const g of GOODS_LIST) {
    out[g] = {
      basePrice: BASE_PRICE[g],
      price: BASE_PRICE[g],
      prevPrice: BASE_PRICE[g],
      supply: 0,
      demand: 0,
      consumed: 0,
      exported: 0,
      imported: 0,
      unmet: 0,
      trend: 0,
    };
  }
  return out;
}

export function marketSat(m: MarketGood): number {
  return m.demand > 0 ? clamp(m.consumed / m.demand, 0, 1) : 1;
}

export interface MarketInput {
  production: Record<GoodId, number>;
  consumption: Record<GoodId, number>;
  govDemand: Record<GoodId, number>;
  stocks: Record<GoodId, number>;
  /** 商路系数（基建/地理 → 贸易容量放大） */
  routeCoef: number;
  tariffRate: number;
}

/**
 * 结算国家市场 + 国际贸易。
 * 守恒：stock_after = stock_before + production + import - consumption - export（严格浮点同序）
 */
export function settleMarket(input: MarketInput, market: Record<GoodId, MarketGood>): MarketSnapshot {
  let tariff = 0;
  let exportValue = 0;
  let importValue = 0;
  for (const g of GOODS_LIST) {
    const m = market[g];
    const supply = input.production[g];
    const demand = input.consumption[g] + input.govDemand[g];
    m.supply = supply;
    m.demand = demand;
    const ratio = demand / Math.max(supply, 1e-9);
    m.prevPrice = m.price;
    m.price = m.basePrice * clamp(ratio, PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
    m.trend = m.prevPrice > 0 ? (m.price - m.prevPrice) / m.prevPrice : 0;

    let stock = input.stocks[g] + supply;
    const consumed = Math.min(stock, demand);
    stock -= consumed;
    m.consumed = consumed;
    const unmet = demand - consumed;

    const tradeCap = BASE_TRADE_CAP[g] * input.routeCoef;
    let exported = 0;
    let imported = 0;
    if (stock > 0) {
      exported = Math.min(stock, tradeCap);
      stock -= exported;
    }
    if (unmet > 0) {
      imported = Math.min(unmet, tradeCap);
      stock += imported;
    }
    m.exported = exported;
    m.imported = imported;
    m.unmet = Math.max(0, unmet - imported);
    input.stocks[g] = stock;

    tariff += (exported + imported) * WORLD_PRICE[g] * input.tariffRate;
    exportValue += exported * WORLD_PRICE[g];
    importValue += imported * WORLD_PRICE[g];
  }
  return { goods: market, tariff, exportValue, importValue };
}
