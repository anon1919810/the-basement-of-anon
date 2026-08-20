/**
 * 市场中心（v0.8：省为结算单元）。
 *
 * v0.8 模型（端明ちゃん 定稿，最小实现）：
 *  - 省为结算单元：移除「国家统一市场」实体；每省独立供需/独立价格（省价可不同）。
 *  - 流向链条（每月结算）：
 *      建筑产出 → 先征商品税（含运力/基建税：对运输吨位计税）→ 进入本省市场
 *      → 省盈余按省价流入缺口省（跨省运费；运费吨位计运力/基建商品税）
 *      → 出口权门槛：仅获权省商品可入国际市场（沿海/港口省默认获权，内陆省可授予/收回）
 *      → 入国际市场时征关税
 *  - 开放度：国家级布尔「开放贸易」（默认 false=不贸易；true=按世界价进出口+关税）。
 *  - 价格差异化：同商品不同省价格可不同（省供需比各自定价，clamp 0.4~2.5）。
 *  - 县本地市场保留为简化展示（并入省结算；守恒以省口径核算）。
 *  - 国家 `national` 市场仅作聚合视图（省结算后派生，供 UI/历史图表读取），不是结算实体。
 *  - 守恒（每商品每省）：生产 + 进口 + 净流入 = 消费 + 出口 + Δ库存 + 建筑消耗。
 *
 * 确定性：纯函数式演化，无随机；省按 id 升序处理。
 */
import type { GoodId } from './types';
import { clamp } from './pops';

// v0.11 温和通胀：价格 × (1 + inflation × 商品敏感度)；必需品敏感低、奢侈品/中间品敏感高
const INFLATION_SENS: Partial<Record<GoodId, number>> = {
  food: 0.6, wheat: 0.6, coal: 0.7, iron: 0.8, steel: 0.9, tools: 0.8,
  luxury: 1.1, coffee: 1.0, tobacco: 1.0, clothing: 0.7, paper: 0.7, train: 1.0,
  liquor: 0.8, wine: 1.0, merchantShip: 1.0, navyShip: 1.0,
};
function priceInflationFactor(inflation: number, good: GoodId): number {
  const s = INFLATION_SENS[good] ?? 0.8;
  return 1 + inflation * s;
}

export type GoodCategory = 'resource' | 'semi' | 'finished';

export const GOODS_LIST: GoodId[] = [
  // 资源
  'food', 'wheat', 'cotton', 'fur', 'timber', 'coal', 'ironOre', 'copperOre',
  'sulfur', 'salt', 'fish', 'meat', 'stone', 'oil', 'coffee', 'tobacco',
  // 半成品
  'lumber', 'cloth', 'iron', 'copper', 'steel', 'flour', 'sugar', 'leather',
  'gunpowder', 'dynamite', 'machines', 'paper',
  // 成品
  'tools', 'swords', 'muskets', 'cannons', 'clothing', 'fineFood',
  'luxury', 'merchantShip', 'navyShip', 'liquor', 'wine', 'train', 'transport',
];

/** 商品类别（UI 分组） */
export const GOOD_CATEGORY: Record<GoodId, GoodCategory> = {
  food: 'resource', wheat: 'resource', cotton: 'resource', fur: 'resource',
  timber: 'resource', coal: 'resource', ironOre: 'resource', copperOre: 'resource',
  sulfur: 'resource', salt: 'resource', fish: 'resource', meat: 'resource',
  stone: 'resource', oil: 'resource', coffee: 'resource', tobacco: 'resource',
  lumber: 'semi', cloth: 'semi', iron: 'semi', copper: 'semi', steel: 'semi',
  flour: 'semi', sugar: 'semi', leather: 'semi', gunpowder: 'semi',
  dynamite: 'semi', machines: 'semi', paper: 'semi',
  tools: 'finished', swords: 'finished', muskets: 'finished', cannons: 'finished',
  clothing: 'finished', fineFood: 'finished',
  luxury: 'finished', merchantShip: 'finished', navyShip: 'finished', liquor: 'finished', wine: 'finished', train: 'finished', transport: 'finished',
};

/** 基础价（万₭/单位）——随加工链价值上升（资源低 → 成品高） */
export const BASE_PRICE: Record<GoodId, number> = {
  food: 2.0, wheat: 2.6, cotton: 1.4, fur: 1.6,
  timber: 1.0, coal: 1.5, ironOre: 1.2, copperOre: 1.6,
  sulfur: 1.4, salt: 0.8, fish: 1.1, meat: 2.2,
  stone: 0.9, oil: 2.0, coffee: 3.0, tobacco: 2.8,
  lumber: 1.7, cloth: 2.0, iron: 2.6, copper: 3.0, steel: 3.4,
  flour: 2.8, sugar: 3.2, leather: 2.4, gunpowder: 2.8,
  dynamite: 3.6, machines: 4.2, paper: 1.9,
  tools: 2.7, swords: 3.4, muskets: 4.0, cannons: 4.6,
  clothing: 1.8, fineFood: 4.0, luxury: 5.0,
  merchantShip: 8.0, navyShip: 32.0, // v0.15 商船/军舰：军舰 ≈ 商船 4 倍
  liquor: 2.2, wine: 4.5, train: 6.0, transport: 1.6,
};

/** 世界价（略高于本国基础价：外部市场更大） */
export const WORLD_PRICE: Record<GoodId, number> = {
  food: 2.4, wheat: 3.2, cotton: 1.9, fur: 2.2,
  timber: 1.4, coal: 2.0, ironOre: 1.7, copperOre: 2.2,
  sulfur: 2.0, salt: 1.1, fish: 1.5, meat: 2.8,
  stone: 1.3, oil: 2.6, coffee: 3.8, tobacco: 3.5,
  lumber: 2.3, cloth: 2.8, iron: 3.4, copper: 3.8, steel: 4.4,
  flour: 3.6, sugar: 4.0, leather: 3.2, gunpowder: 3.6,
  dynamite: 4.6, machines: 5.4, paper: 2.6,
  tools: 3.4, swords: 4.4, muskets: 5.2, cannons: 6.0,
  clothing: 2.6, fineFood: 5.2, luxury: 6.0,
  merchantShip: 10.0, navyShip: 40.0, // v0.15 世界价
  liquor: 3.0, wine: 5.8, train: 7.6, transport: 2.2,
};

/** 价格上下限（基础价 × 系数） */
export const PRICE_CLAMP_MIN = 0.4;
export const PRICE_CLAMP_MAX = 2.5;

/** 基础月出口/进口容量（单位/月，基建可提升） */
export const BASE_TRADE_CAP: Record<GoodId, number> = {
  food: 3.0, wheat: 1.4, cotton: 1.6, fur: 1.2,
  timber: 2.0, coal: 2.6, ironOre: 1.6, copperOre: 1.2,
  sulfur: 1.0, salt: 2.2, fish: 1.8, meat: 1.4,
  stone: 2.4, oil: 1.0, coffee: 0.8, tobacco: 0.9,
  lumber: 1.4, cloth: 1.4, iron: 1.2, copper: 1.0, steel: 0.9,
  flour: 1.2, sugar: 1.1, leather: 1.0, gunpowder: 0.6,
  dynamite: 0.5, machines: 0.7, paper: 1.3,
  tools: 0.9, swords: 0.7, muskets: 0.5, cannons: 0.4,
  clothing: 2.2, fineFood: 0.8, luxury: 0.6,
  merchantShip: 0.6, navyShip: 0.2, // v0.15 船只贸易容量低（大件）
  liquor: 1.5, wine: 0.8, train: 0.3, transport: 2.8,
};

/** 关税税率已迁移至 tax.ts（连续滑块，economy 传入 tariffRate） */
/** 成本传导过手率：输入品税价差 → 成品价格上浮的比例（0.85 = 85% 传导） */
export const COST_PUSH_PASS = 0.85;
/** 贸易吨位运力消耗系数（每吨调运/出口吃多少运力，v0.9；0.02 平衡后：运力耐用，基础基建可撑贸易） */
export const TRADE_TRANSPORT = 0.02;

/** 价格信号跨层传导权重（v0.8：省价独立定价，仅保留县←省传导） */
export const BLEND_COUNTY_FROM_PROV = 0.2; // 本地价格 = 县供需比 × (1-0.2) + 省价格信号 0.2
/** 省内运费对省价的上浮系数（县 → 省集散） */
export const FREIGHT_PRICE_INTRA = 0.15;

/** 全零商品记录（避免逐商品字面量初始化） */
export function zeroGoods(): Record<GoodId, number> {
  const out = {} as Record<GoodId, number>;
  for (const g of GOODS_LIST) out[g] = 0;
  return out;
}

/** 国家市场商品状态（v0.8 起为聚合视图：省结算后派生，非结算实体） */
export interface MarketGood {
  basePrice: number;
  /** 当前价（万₭/单位）——含成本传导（上游输入品税价差上浮），买方实际支付的基础 */
  price: number;
  prevPrice: number;
  /** v0.4 有效价格（买方支付）= price × (1 + 商品税率)；建筑输入成本按此计价 */
  effPrice: number;
  /** v0.4 成本传导上浮量（万₭/单位，来自上游输入品税价差） */
  costPush: number;
  /** 上月总供给（县产 + 建筑产出） */
  supply: number;
  /** 上月总需求（县消费 + 政府 + 建筑输入） */
  demand: number;
  /** 上月实际消费（县 + 政府） */
  consumed: number;
  exported: number;
  imported: number;
  /** 未满足需求（饥荒/短缺，→ 幸福度惩罚） */
  unmet: number;
  /** 价格趋势（相对上月，-1..） */
  trend: number;
}

/** 省市场商品状态（v0.8 结算单元） */
export interface ProvinceMarket extends MarketGood {
  /** 省际净流出 = flowOut - flowIn（>0 净流出 / <0 净流入；UI 兼容 v0.7 字段） */
  netFlow: number;
  /** v0.8 省际流入（单位/月） */
  flowIn: number;
  /** v0.8 省际流出（单位/月） */
  flowOut: number;
}

/** 本地市场商品状态（县，展示用；并入省结算） */
export interface CountyMarket {
  basePrice: number;
  price: number;
  prevPrice: number;
  /** 县内产出 */
  supply: number;
  /** 县内需求 */
  demand: number;
  /** 实际消费（自产 + 省流入补足） */
  consumed: number;
  /** 未满足需求（缺口未补足部分） */
  unmet: number;
  /** 上缴/下拨净流（>0 盈余外流，<0 缺口由上级补足） */
  netFlow: number;
  trend: number;
}

export interface MarketSnapshot {
  /** 国家聚合市场视图（省结算后派生；UI/断言主读） */
  goods: Record<GoodId, MarketGood>;
  /** 省市场（省 id → 各商品；结算单元） */
  province: Record<number, Record<GoodId, ProvinceMarket>>;
  /** 本地市场（县 id → 各商品；展示） */
  county: Record<number, Record<GoodId, CountyMarket>>;
  /** 各省实际消费（幸福度/效率用） */
  provConsumed: Record<number, Record<GoodId, number>>;
  /** 各省需求 */
  provDemand: Record<number, Record<GoodId, number>>;
  /** 本月关税收入（万₭） */
  tariff: number;
  /** v0.4 单一商品税收入（万₭/月）= Σ 税率 × 成交量（消费+进口+建筑消耗+运输吨位） */
  commodityTax: number;
  exportValue: number;
  importValue: number;
  /** 建筑对省的额外供给（单位/月，聚合视图） */
  factorySupply: Record<GoodId, number>;
  /** 建筑输入消耗（单位/月，聚合视图；守恒断言用） */
  buildingConsumed: Record<GoodId, number>;
  /** v0.8 省 → 建筑输入消耗（单位/月；按省守恒断言用） */
  provBuildingConsumed: Record<number, Record<GoodId, number>>;
}

/** 单个县的流量输入（economy 按省分组、按县 id 升序传入） */
export interface CountyFlow {
  countyId: number;
  provId: number;
  production: Record<GoodId, number>;
  demand: Record<GoodId, number>;
  /** 县 → 省质心 的省内运费系数 */
  intraFreight: number;
}

export interface MarketInput {
  counties: CountyFlow[];
  /** v0.8 省 → 建筑产出（单位/月，含建筑产出） */
  provFactorySupply: Record<number, Record<GoodId, number>>;
  /** v0.8 省 → 建筑输入需求（参与省价格形成；economy 已预扣自省库存） */
  provBuildingDemand: Record<number, Record<GoodId, number>>;
  /** v0.8 省 → 建筑输入实际消耗（从「未满足需求」扣除，避免重复进口） */
  provBuildingConsumed: Record<number, Record<GoodId, number>>;
  govDemand: Record<GoodId, number>;
  /** v0.8 省库存（结算账本；原地更新，按省守恒） */
  provStocks: Record<number, Record<GoodId, number>>;
  /** 商路系数（基建/地理 → 贸易容量放大） */
  routeCoef: number;
  /** 关税税率（v0.4 连续滑块，来自 tax.rates.tariff） */
  tariffRate: number;
  /** v0.4 单一商品税（商品 → 税率 0-0.3；买方支付，收入 = 税率 × 成交量） */
  goodsTax: Record<GoodId, number>;
  /**
   * v0.4 建筑成本结构（economy 从 BUILDING_DEFS 派生，避免 market↔buildings 循环依赖）：
   * 商品 → 生产该商品的建筑 { 每单位输出所需输入量, 产能 }。用于成本传导（输入品税价差 → 成品价↑）。
   */
  producers: Partial<Record<GoodId, { inputs: Partial<Record<GoodId, number>>; capacity: number }>>;
  /** 省 → 跨省运费系数（v0.8 仅作模型记录；省价独立定价） */
  crossFreight: Record<number, number>;
  /** 全国平均跨省运费（v0.8 仅作模型记录） */
  natFreight: number;
  /** v0.8 开放贸易（false=自给不贸易；true=按世界价进出口+关税） */
  openTrade: boolean;
  /** v0.8 出口权：省 id → 是否获权（获权省商品可入国际市场） */
  exportRights: Record<number, boolean>;
  /** v0.11 通胀压力（-0.15~0.25；温和修正价格水平） */
  inflation: number;
  /** v0.15 海上运力（商船提供；叠加进贸易容量） */
  seaTransport: number;
}

export interface MarketState {
  national: Record<GoodId, MarketGood>;
  province: Record<number, Record<GoodId, ProvinceMarket>>;
  county: Record<number, Record<GoodId, CountyMarket>>;
}

export function newMarket(): Record<GoodId, MarketGood> {
  const out = {} as Record<GoodId, MarketGood>;
  for (const g of GOODS_LIST) {
    out[g] = {
      basePrice: BASE_PRICE[g],
      price: BASE_PRICE[g],
      prevPrice: BASE_PRICE[g],
      effPrice: BASE_PRICE[g],
      costPush: 0,
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

export function newCountyMarkets(): Record<GoodId, CountyMarket> {
  const out = {} as Record<GoodId, CountyMarket>;
  for (const g of GOODS_LIST) {
    out[g] = {
      basePrice: BASE_PRICE[g],
      price: BASE_PRICE[g],
      prevPrice: BASE_PRICE[g],
      supply: 0,
      demand: 0,
      consumed: 0,
      unmet: 0,
      netFlow: 0,
      trend: 0,
    };
  }
  return out;
}

export function newProvinceMarkets(): Record<GoodId, ProvinceMarket> {
  const out = {} as Record<GoodId, ProvinceMarket>;
  for (const g of GOODS_LIST) {
    out[g] = {
      basePrice: BASE_PRICE[g],
      price: BASE_PRICE[g],
      prevPrice: BASE_PRICE[g],
      effPrice: BASE_PRICE[g],
      costPush: 0,
      supply: 0,
      demand: 0,
      consumed: 0,
      exported: 0,
      imported: 0,
      unmet: 0,
      trend: 0,
      netFlow: 0,
      flowIn: 0,
      flowOut: 0,
    };
  }
  return out;
}

export function marketSat(m: MarketGood): number {
  return m.demand > 0 ? clamp(m.consumed / m.demand, 0, 1) : 1;
}

function trendOf(price: number, prevPrice: number): number {
  return prevPrice > 0 ? (price - prevPrice) / prevPrice : 0;
}

/**
 * 结算市场（v0.8：省为结算单元）+ 国际贸易。
 * 修改传入的 markets 与 input.provStocks（严格同序浮点，确定性）。
 */
export function settleMarket(input: MarketInput, markets: MarketState): MarketSnapshot {
  const nat = markets.national;
  // 省分组；省 id 升序（确定性处理顺序）
  const provCounties = new Map<number, CountyFlow[]>();
  const provIdSet = new Set<number>();
  for (const c of input.counties) {
    provIdSet.add(c.provId);
    let list = provCounties.get(c.provId);
    if (!list) {
      list = [];
      provCounties.set(c.provId, list);
    }
    list.push(c);
  }
  for (const pid of Object.keys(input.provStocks)) provIdSet.add(Number(pid));
  for (const pid of Object.keys(input.provFactorySupply)) provIdSet.add(Number(pid));
  for (const pid of Object.keys(input.provBuildingDemand)) provIdSet.add(Number(pid));
  for (const pid of Object.keys(input.exportRights)) provIdSet.add(Number(pid));
  const provOrder = [...provIdSet].sort((a, b) => a - b);

  let tariff = 0;
  let commodityTax = 0;
  let exportValue = 0;
  let importValue = 0;
  const provConsumed: Record<number, Record<GoodId, number>> = {};
  const provDemand: Record<number, Record<GoodId, number>> = {};
  const factorySupply = zeroGoods();
  const buildingConsumed = zeroGoods();
  const provBuildingConsumed: Record<number, Record<GoodId, number>> = {};
  // v0.4 成本传导：供需价（未含传导）与买方有效价（含商品税与上游传导），按 GOODS_LIST 序计算（输入必在上游）
  const sdPriceOf = {} as Record<GoodId, Record<number, number>>;
  const effPriceOf = {} as Record<GoodId, Record<number, number>>;
  const provFreight: Record<number, number> = {}; // 省 → 调运/出口吨位累计（跨商品；运力消耗记账）

  for (const g of GOODS_LIST) {
    const base = BASE_PRICE[g];
    const taxRate = input.goodsTax[g] ?? 0;

    // ---- 1. 省供需（产出 = 县产 + 建筑产出；需求 = 县需 + 政府分摊 + 建筑输入） ----
    const supply: Record<number, number> = {};
    const demand: Record<number, number> = {};
    const countyDemand: Record<number, number> = {};
    const intraAvg: Record<number, number> = {};
    let totalCountyDemand = 0;
    for (const pid of provOrder) {
      const list = provCounties.get(pid) ?? [];
      let s = 0;
      let d = 0;
      let intraSum = 0;
      for (const c of list) {
        s += c.production[g];
        d += c.demand[g];
        intraSum += c.intraFreight;
      }
      s += input.provFactorySupply[pid]?.[g] ?? 0;
      const cd = d;
      d += input.provBuildingDemand[pid]?.[g] ?? 0;
      supply[pid] = s;
      demand[pid] = d;
      countyDemand[pid] = cd;
      intraAvg[pid] = list.length > 0 ? intraSum / list.length : 1;
      totalCountyDemand += cd;
    }
    // 政府需求按县需份额分摊到省（确定性）
    const govTotal = input.govDemand[g] ?? 0;
    for (const pid of provOrder) {
      const share =
        totalCountyDemand > 1e-9
          ? countyDemand[pid] / totalCountyDemand
          : provOrder.length > 0
            ? 1 / provOrder.length
            : 0;
      demand[pid] += govTotal * share;
    }
    // 运力需求含贸易吨位（transport 为最后商品，此时 provFreight 已累计其他商品吨位）→ 运力价反映贸易稀缺
    if (g === 'transport') {
      for (const pid of provOrder) {
        demand[pid] += (provFreight[pid] ?? 0) * TRADE_TRANSPORT;
      }
    }

    // ---- 2. 省价：供需比各自定价（clamp 0.4~2.5；省内运费小幅上浮） ----
    const sdPrice: Record<number, number> = {};
    for (const pid of provOrder) {
      const ratio = demand[pid] / Math.max(supply[pid], 1e-9);
      sdPrice[pid] = base * clamp(ratio * (1 + FREIGHT_PRICE_INTRA * intraAvg[pid]), PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
    }
    sdPriceOf[g] = sdPrice;

    // ---- 3. 省价成本传导：上游输入品税价差 → 本省成品价上浮（如 煤炭税 → 铁锭价↑ → 钢材价↑） ----
    const prod = input.producers[g];
    for (const pid of provOrder) {
      const pm = getProvMarket(markets, pid)[g];
      let costPush = 0;
      if (prod) {
        const outQty = Math.max(1e-9, prod.capacity);
        for (const i of Object.keys(prod.inputs) as GoodId[]) {
          const qty = prod.inputs[i] ?? 0;
          if (qty > 0) costPush += (qty / outQty) * ((effPriceOf[i]?.[pid] ?? 0) - (sdPriceOf[i]?.[pid] ?? 0));
        }
        costPush *= COST_PUSH_PASS;
      }
      pm.supply = supply[pid];
      pm.demand = demand[pid];
      pm.prevPrice = pm.price;
      // v0.11 温和通胀：价格 × (1 + inflation × 商品敏感度)
      const infFactor = priceInflationFactor(input.inflation ?? 0, g);
      pm.price = clamp((sdPrice[pid] + costPush) * infFactor, base * PRICE_CLAMP_MIN, base * PRICE_CLAMP_MAX);
      pm.costPush = costPush;
      // 买方有效价 = 市价（含传导）× (1 + 商品税率)
      pm.effPrice = pm.price * (1 + taxRate);
      pm.trend = trendOf(pm.price, pm.prevPrice);
      pm.flowIn = 0;
      pm.flowOut = 0;
      pm.exported = 0;
      pm.imported = 0;
      pm.unmet = 0;
    }
    effPriceOf[g] = {};
    for (const pid of provOrder) effPriceOf[g][pid] = getProvMarket(markets, pid)[g].effPrice;

    // ---- 4. 县本地市场（并入省结算：价格展示 + 消费展示账） ----
    for (const c of input.counties) {
      const cm = getCountyMarket(markets, c.countyId)[g];
      cm.supply = c.production[g];
      cm.demand = c.demand[g];
      const pPrice = getProvMarket(markets, c.provId)[g].price;
      const ratio = c.demand[g] / Math.max(c.production[g], 1e-9);
      const blend = 1 - BLEND_COUNTY_FROM_PROV + BLEND_COUNTY_FROM_PROV * (pPrice / base);
      cm.prevPrice = cm.price;
      cm.price = base * clamp(ratio * blend, PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
      cm.trend = trendOf(cm.price, cm.prevPrice);
    }

    // ---- 5. 省本地消费与库存账（库存 = 上月末 + 产出 − 本地消费） ----
    const cons: Record<number, number> = {};
    const unmet: Record<number, number> = {};
    const stock: Record<number, number> = {};
    for (const pid of provOrder) {
      const s0 = input.provStocks[pid]?.[g] ?? 0;
      const available = s0 + supply[pid];
      const c = Math.min(demand[pid], available);
      cons[pid] = c;
      unmet[pid] = Math.max(0, demand[pid] - c);
      stock[pid] = available - c;
    }

    // ---- 6. 省际调运：盈余省按省价流入缺口省（运费吨位计运力/基建商品税） ----
    const flowOut: Record<number, number> = {};
    const flowIn: Record<number, number> = {};
    for (const pid of provOrder) {
      flowOut[pid] = 0;
      flowIn[pid] = 0;
    }
    const surplusQ = provOrder
      .filter((pid) => stock[pid] > 1e-9)
      .map((pid) => ({ pid, amt: stock[pid] }));
    const deficitQ = provOrder
      .filter((pid) => unmet[pid] > 1e-9)
      .map((pid) => ({ pid, amt: unmet[pid] }));
    let qi = 0;
    for (let si = 0; si < surplusQ.length && qi < deficitQ.length; si++) {
      const sp = surplusQ[si];
      while (sp.amt > 1e-9 && qi < deficitQ.length) {
        const dq = deficitQ[qi];
        const a = Math.min(sp.amt, dq.amt);
        if (a > 1e-9) {
          sp.amt -= a;
          dq.amt -= a;
          flowOut[sp.pid] += a;
          flowIn[dq.pid] += a;
        }
        if (dq.amt <= 1e-9) qi++;
      }
    }
    let freightTonnage = 0;
    for (const pid of provOrder) {
      const out = flowOut[pid];
      const inn = flowIn[pid];
      if (out > 1e-9) {
        stock[pid] -= out;
        freightTonnage += out;
        if (g !== 'transport') provFreight[pid] = (provFreight[pid] ?? 0) + out; // 运力商品自身调运不计吨位（防自指吃运力）
      }
      if (inn > 1e-9) {
        cons[pid] += inn;
        unmet[pid] = Math.max(0, unmet[pid] - inn);
      }
    }

    // ---- 7. 国际贸易：开放度门槛 + 出口权门槛 + 关税 ----
    // v0.15 贸易容量 = 陆运（基建×运力）+ 海运（商船运力）；商船运力按商品份额分配
    const seaShare = (input.seaTransport ?? 0) * 0.06; // 海运容量：每运力 → 每商品容量 0.06（18 商品摊分）
    const tradeCap = BASE_TRADE_CAP[g] * input.routeCoef + seaShare;
    const hasAuthorized = provOrder.some((pid) => !!input.exportRights[pid]);
    let exported = 0;
    let imported = 0;
    if (input.openTrade) {
      // 出口：仅获权省商品可入国际市场；内陆省余量运抵口岸出口（运费吨位计税）
      if (hasAuthorized) {
        let rem = tradeCap;
        for (const pid of provOrder) {
          if (rem <= 1e-9) break;
          if (!input.exportRights[pid]) continue;
          const e = Math.min(stock[pid], rem);
          if (e > 1e-9) {
            stock[pid] -= e;
            rem -= e;
            exported += e;
            if (g !== 'transport') provFreight[pid] = (provFreight[pid] ?? 0) + e;
            getProvMarket(markets, pid)[g].exported = e;
          }
        }
        for (const pid of provOrder) {
          if (rem <= 1e-9) break;
          if (input.exportRights[pid]) continue;
          const e = Math.min(stock[pid], rem);
          if (e > 1e-9) {
            stock[pid] -= e;
            rem -= e;
            exported += e;
            freightTonnage += e; // 内陆 → 口岸 的运力吨位
            if (g !== 'transport') provFreight[pid] = (provFreight[pid] ?? 0) + e;
            getProvMarket(markets, pid)[g].exported = e;
          }
        }
      }
      // 进口：缺口省按 id 序补足（入省库存）
      let remI = tradeCap;
      for (const pid of provOrder) {
        if (remI <= 1e-9) break;
        if (unmet[pid] <= 1e-9) continue;
        const imp = Math.min(unmet[pid], remI);
        if (imp > 1e-9) {
          stock[pid] += imp;
          unmet[pid] -= imp;
          remI -= imp;
          imported += imp;
          getProvMarket(markets, pid)[g].imported = imp;
        }
      }
    }
    tariff += (exported + imported) * WORLD_PRICE[g] * input.tariffRate;
    exportValue += exported * WORLD_PRICE[g];
    importValue += imported * WORLD_PRICE[g];

    // ---- 8. 回写省市场/省库存/省账本（幸福度 + 守恒断言数据） ----
    let sumSupply = 0;
    let sumDemand = 0;
    let sumCons = 0;
    let sumExported = 0;
    let sumImported = 0;
    let sumUnmet = 0;
    let priceW = 0;
    let priceWSum = 0;
    let costPushW = 0;
    for (const pid of provOrder) {
      const pm = getProvMarket(markets, pid)[g];
      pm.consumed = cons[pid];
      pm.unmet = Math.max(0, unmet[pid]);
      pm.netFlow = flowOut[pid] - flowIn[pid];
      pm.flowIn = flowIn[pid];
      pm.flowOut = flowOut[pid];
      if (!input.provStocks[pid]) input.provStocks[pid] = zeroGoods();
      input.provStocks[pid][g] = stock[pid];
      sumSupply += supply[pid];
      sumDemand += demand[pid];
      sumCons += cons[pid];
      sumExported += pm.exported;
      sumImported += pm.imported;
      sumUnmet += pm.unmet;
      priceW += pm.price * supply[pid];
      priceWSum += supply[pid];
      costPushW += pm.costPush * supply[pid];
      provConsumed[pid] = provConsumed[pid] ?? {};
      provDemand[pid] = provDemand[pid] ?? {};
      provConsumed[pid][g] = cons[pid];
      provDemand[pid][g] = countyDemand[pid];
      const bc = input.provBuildingConsumed[pid]?.[g] ?? 0;
      provBuildingConsumed[pid] = provBuildingConsumed[pid] ?? {};
      provBuildingConsumed[pid][g] = bc;
      buildingConsumed[g] += bc;
      factorySupply[g] += input.provFactorySupply[pid]?.[g] ?? 0;
    }

    // ---- 9. 国家聚合视图（省结算后派生；UI/历史图表读取，非结算实体） ----
    const m = nat[g];
    const natPrice =
      priceWSum > 1e-9
        ? priceW / priceWSum
        : provOrder.length > 0
          ? provOrder.reduce((s, pid) => s + getProvMarket(markets, pid)[g].price, 0) / provOrder.length
          : base;
    m.supply = sumSupply;
    m.demand = sumDemand;
    m.prevPrice = m.price;
    m.price = clamp(natPrice, base * PRICE_CLAMP_MIN, base * PRICE_CLAMP_MAX);
    m.costPush = priceWSum > 1e-9 ? costPushW / priceWSum : 0;
    m.effPrice = m.price * (1 + taxRate);
    m.consumed = sumCons;
    m.exported = sumExported;
    m.imported = sumImported;
    m.unmet = sumUnmet;
    m.trend = trendOf(m.price, m.prevPrice);

    // ---- 10. 单一商品税（含运力/基建税：对运输吨位计税；出口为外国买方不征） ----
    let bCons = 0;
    for (const pid of provOrder) bCons += input.provBuildingConsumed[pid]?.[g] ?? 0;
    const taxVol = sumCons + sumImported + bCons + freightTonnage;
    commodityTax += taxRate * taxVol;
  }

  // ---- 11. 贸易吃运力：调运/出口吨位 × 系数 → 源头省运力库存扣减（按实际库存，不虚记） ----
  for (const pid of Object.keys(provFreight)) {
    const eat = (provFreight[Number(pid)] ?? 0) * TRADE_TRANSPORT;
    if (eat <= 1e-9) continue;
    const ts = input.provStocks[Number(pid)];
    if (!ts) continue;
    const cur = ts.transport ?? 0;
    const actual = Math.min(eat, Math.max(0, cur));
    if (actual > 1e-9) {
      ts.transport = cur - actual;
      const pmT = markets.province[Number(pid)]?.transport;
      if (pmT) pmT.consumed = (pmT.consumed ?? 0) + actual;
    }
  }

  return {
    goods: nat,
    province: markets.province,
    county: markets.county,
    provConsumed,
    provDemand,
    tariff,
    commodityTax,
    exportValue,
    importValue,
    factorySupply,
    buildingConsumed,
    provBuildingConsumed,
  };
}

function getProvMarket(markets: MarketState, provId: number): Record<GoodId, ProvinceMarket> {
  let pm = markets.province[provId];
  if (!pm) {
    pm = newProvinceMarkets();
    markets.province[provId] = pm;
  }
  return pm;
}

function getCountyMarket(markets: MarketState, countyId: number): Record<GoodId, CountyMarket> {
  let cm = markets.county[countyId];
  if (!cm) {
    cm = newCountyMarkets();
    markets.county[countyId] = cm;
  }
  return cm;
}
