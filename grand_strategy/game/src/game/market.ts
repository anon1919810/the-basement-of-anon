/**
 * 三级市场（v0.3）：本地（县）→ 区域（省）→ 国家，外加简化国际贸易。
 *
 * 层级与流向（确定性、纯函数式演化，无随机）：
 *  - 本地市场（县）：县内自产自销、无运费，价格 = 基础价 × 县内供需比（clamp 0.4~2.5）
 *  - 区域市场（省）：县间贸易，省内运费（距离 × 地形系数，见 logistics）；县盈余向上流入、缺口向下补足
 *  - 国家市场：省间调运，跨省运费更高；省盈余上缴、省缺口由国家库存补足
 *  - 国际贸易：国家盈余 → 按世界价出口（+关税）；国家缺口 → 进口补足（扣关税），容量受商路（基建）影响
 *  - 价格信号跨层传导（权重）：国家价格趋势 → 区域（15% 权重）→ 本地（20% 权重）
 *
 * v0.3 产业链接入：
 *  - 商品表扩展为 17 种（资源/半成品/成品），全部纳入三级供需定价与国际贸易
 *  - 建筑（投资）供给：工厂产出进入国家市场供给（factorySupply）
 *  - 建筑输入需求：建筑消耗输入从国家库存扣除（economy 预扣），此处：
 *      · buildingDemand  参与国家价格形成（需求↑ → 价格↑，稀缺信号）
 *      · buildingConsumed 从「未满足需求」中扣除（避免重复进口：库存已扣过的不再进口）
 *    守恒（每商品）：生产（县产 + 工厂供给）+ 进口 = 消费（县 + 政府）+ 出口 + Δ国家库存 + 建筑消耗
 */
import type { GoodId } from './types';
import { clamp } from './pops';

export type GoodCategory = 'resource' | 'semi' | 'finished';

export const GOODS_LIST: GoodId[] = [
  // 资源
  'food', 'timber', 'cotton', 'fur', 'coal', 'ironOre', 'salt', 'fish',
  // 半成品
  'lumber', 'cloth', 'iron', 'steel',
  // 成品
  'tools', 'weapons', 'sailShip', 'clothing', 'luxury',
];

/** 商品类别（UI 分组） */
export const GOOD_CATEGORY: Record<GoodId, GoodCategory> = {
  food: 'resource', timber: 'resource', cotton: 'resource', fur: 'resource',
  coal: 'resource', ironOre: 'resource', salt: 'resource', fish: 'resource',
  lumber: 'semi', cloth: 'semi', iron: 'semi', steel: 'semi',
  tools: 'finished', weapons: 'finished', sailShip: 'finished', clothing: 'finished', luxury: 'finished',
};

/** 基础价（万₭/单位）——随加工链价值上升（资源低 → 成品高） */
export const BASE_PRICE: Record<GoodId, number> = {
  food: 2.0,
  timber: 1.0,
  cotton: 1.4,
  fur: 1.6,
  coal: 1.5,
  ironOre: 1.2,
  salt: 0.8,
  fish: 1.1,
  lumber: 1.7,
  cloth: 2.0,
  iron: 2.6,
  steel: 3.4,
  tools: 3.0,
  weapons: 3.2,
  sailShip: 5.0,
  clothing: 1.8,
  luxury: 5.0,
};

/** 世界价（略高于本国基础价：外部市场更大） */
export const WORLD_PRICE: Record<GoodId, number> = {
  food: 2.4,
  timber: 1.4,
  cotton: 1.9,
  fur: 2.2,
  coal: 2.0,
  ironOre: 1.7,
  salt: 1.1,
  fish: 1.5,
  lumber: 2.3,
  cloth: 2.8,
  iron: 3.4,
  steel: 4.4,
  tools: 4.0,
  weapons: 4.2,
  sailShip: 6.4,
  clothing: 2.6,
  luxury: 6.0,
};

/** 价格上下限（基础价 × 系数） */
export const PRICE_CLAMP_MIN = 0.4;
export const PRICE_CLAMP_MAX = 2.5;

/** 基础月出口/进口容量（单位/月，基建可提升） */
export const BASE_TRADE_CAP: Record<GoodId, number> = {
  food: 3.0,
  timber: 2.0,
  cotton: 1.6,
  fur: 1.2,
  coal: 2.6,
  ironOre: 1.6,
  salt: 2.2,
  fish: 1.8,
  lumber: 1.4,
  cloth: 1.4,
  iron: 1.2,
  steel: 0.9,
  tools: 0.9,
  weapons: 0.7,
  sailShip: 0.4,
  clothing: 2.2,
  luxury: 0.6,
};

/** 关税税率已迁移至 tax.ts（连续滑块，economy 传入 tariffRate） */
/** 成本传导过手率：输入品税价差 → 成品价格上浮的比例（0.85 = 85% 传导） */
export const COST_PUSH_PASS = 0.85;

/** 价格信号跨层传导权重 */
export const BLEND_PROV_FROM_NAT = 0.15; // 区域价格 = 本地供需比 × (1-0.15) + 国家价格信号 0.15
export const BLEND_COUNTY_FROM_PROV = 0.2; // 本地价格 = 县供需比 × (1-0.2) + 区域价格信号 0.2
/** 运费对价格的上浮系数（跨省更高） */
export const FREIGHT_PRICE_INTRA = 0.15;
export const FREIGHT_PRICE_CROSS = 0.2;

/** 全零商品记录（避免逐商品字面量初始化） */
export function zeroGoods(): Record<GoodId, number> {
  const out = {} as Record<GoodId, number>;
  for (const g of GOODS_LIST) out[g] = 0;
  return out;
}

/** 国家市场商品状态 */
export interface MarketGood {
  basePrice: number;
  /** 当前价（万₭/单位）——含成本传导（上游输入品税价差上浮），买方实际支付的基础 */
  price: number;
  prevPrice: number;
  /** v0.4 有效价格（买方支付）= price × (1 + 商品税率)；建筑输入成本按此计价 */
  effPrice: number;
  /** v0.4 成本传导上浮量（万₭/单位，来自上游输入品税价差） */
  costPush: number;
  /** 上月总供给（县产 + 工厂） */
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

/** 区域市场商品状态（省） */
export interface ProvinceMarket extends MarketGood {
  /** 省内县间净流出（>0 上缴国家）/ 净流入缺口（<0 由国家补足） */
  netFlow: number;
}

/** 本地市场商品状态（县） */
export interface CountyMarket {
  basePrice: number;
  price: number;
  prevPrice: number;
  /** 县内产出 */
  supply: number;
  /** 县内需求 */
  demand: number;
  /** 实际消费（自产 + 省内调剂） */
  consumed: number;
  /** 未满足需求（缺口未补足部分） */
  unmet: number;
  /** 上缴/下拨净流（>0 盈余外流，<0 缺口由上级补足） */
  netFlow: number;
  trend: number;
}

export interface MarketSnapshot {
  /** 国家市场状态（UI/断言主读） */
  goods: Record<GoodId, MarketGood>;
  /** 区域市场（省 id → 各商品） */
  province: Record<number, Record<GoodId, ProvinceMarket>>;
  /** 本地市场（县 id → 各商品） */
  county: Record<number, Record<GoodId, CountyMarket>>;
  /** 各省实际消费（幸福度/效率用） */
  provConsumed: Record<number, Record<GoodId, number>>;
  /** 各省需求 */
  provDemand: Record<number, Record<GoodId, number>>;
  /** 本月关税收入（万₭） */
  tariff: number;
  /** v0.4 单一商品税收入（万₭/月）= Σ 税率 × 成交量（消费+进口+建筑消耗） */
  commodityTax: number;
  exportValue: number;
  importValue: number;
  /** 工厂对国家的额外供给（单位/月，含建筑产出） */
  factorySupply: Record<GoodId, number>;
  /** 建筑输入消耗（单位/月，economy 预扣自库存；守恒断言用） */
  buildingConsumed: Record<GoodId, number>;
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
  /** 工厂对国家市场的额外供给（单位/月，含建筑产出） */
  factorySupply: Record<GoodId, number>;
  govDemand: Record<GoodId, number>;
  /** 建筑输入需求（参与价格形成；economy 已预扣自库存） */
  buildingDemand: Record<GoodId, number>;
  /** 建筑输入实际消耗（从「未满足需求」扣除，避免重复进口） */
  buildingConsumed: Record<GoodId, number>;
  stocks: Record<GoodId, number>;
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
  /** 省 → 跨省运费系数 */
  crossFreight: Record<number, number>;
  /** 全国平均跨省运费 */
  natFreight: number;
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
 * 结算三级市场 + 国际贸易。修改传入的 markets 与 input.stocks（严格同序浮点）。
 */
export function settleMarket(input: MarketInput, markets: MarketState): MarketSnapshot {
  const nat = markets.national;
  // 输入已按省分组、县 id 升序 → 保持确定性处理顺序（首见即入序）
  const provCounties = new Map<number, CountyFlow[]>();
  const provOrder: number[] = [];
  for (const c of input.counties) {
    let list = provCounties.get(c.provId);
    if (!list) {
      list = [];
      provCounties.set(c.provId, list);
      provOrder.push(c.provId);
    }
    list.push(c);
  }

  let tariff = 0;
  let commodityTax = 0;
  let exportValue = 0;
  let importValue = 0;
  const provConsumed: Record<number, Record<GoodId, number>> = {};
  const provDemand: Record<number, Record<GoodId, number>> = {};
  const factorySupply: Record<GoodId, number> = { ...input.factorySupply };
  const buildingConsumed: Record<GoodId, number> = { ...input.buildingConsumed };
  // v0.4 成本传导：供需价（未含传导）与买方有效价（含商品税与上游传导），按 GOODS_LIST 序计算（输入必在上游）
  const sdPriceOf = {} as Record<GoodId, number>;
  const effPriceOf = {} as Record<GoodId, number>;

  for (const g of GOODS_LIST) {
    const base = BASE_PRICE[g];
    const m = nat[g];

    // ---- 1. 国家供需与价格（含建筑输入需求：稀缺 → 涨价信号） ----
    let natSupplyGross = 0;
    let natDemandGross = 0;
    for (const c of input.counties) {
      natSupplyGross += c.production[g];
      natDemandGross += c.demand[g];
    }
    natSupplyGross += input.factorySupply[g];
    natDemandGross += input.govDemand[g] + input.buildingDemand[g];
    const natRatio = natDemandGross / Math.max(natSupplyGross, 1e-9);
    const sdPrice = base * clamp(natRatio * (1 + FREIGHT_PRICE_CROSS * input.natFreight), PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
    sdPriceOf[g] = sdPrice;

    // ---- v0.4 成本传导：上游输入品税价差 → 本商品价格上浮（如 煤炭税 → 铁锭价↑ → 钢材价↑） ----
    const prod = input.producers[g];
    let costPush = 0;
    if (prod) {
      const outQty = Math.max(1e-9, prod.capacity);
      for (const i of Object.keys(prod.inputs) as GoodId[]) {
        const qty = prod.inputs[i] ?? 0;
        if (qty > 0) costPush += (qty / outQty) * (effPriceOf[i] - sdPriceOf[i]);
      }
      costPush *= COST_PUSH_PASS;
    }
    m.supply = natSupplyGross;
    m.demand = natDemandGross;
    m.prevPrice = m.price;
    m.price = clamp(sdPrice + costPush, base * PRICE_CLAMP_MIN, base * PRICE_CLAMP_MAX);
    m.costPush = costPush;
    // 买方有效价 = 市价（含传导）× (1 + 商品税率)
    m.effPrice = m.price * (1 + (input.goodsTax[g] ?? 0));
    effPriceOf[g] = m.effPrice;
    m.trend = trendOf(m.price, m.prevPrice);

    // ---- 2. 区域价格（受国家价格信号传导）----
    const provPrice: Record<number, number> = {};
    for (const pid of provOrder) {
      const list = provCounties.get(pid) ?? [];
      let supply = 0;
      let demand = 0;
      let intraSum = 0;
      for (const c of list) {
        supply += c.production[g];
        demand += c.demand[g];
        intraSum += c.intraFreight;
      }
      const intra = list.length > 0 ? intraSum / list.length : 1;
      const pm = getProvMarket(markets, pid)[g];
      pm.supply = supply;
      pm.demand = demand;
      const ratio = demand / Math.max(supply, 1e-9);
      const blend = 1 - BLEND_PROV_FROM_NAT + BLEND_PROV_FROM_NAT * (m.price / base);
      pm.prevPrice = pm.price;
      pm.price = base * clamp(ratio * blend * (1 + FREIGHT_PRICE_INTRA * intra), PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
      pm.trend = trendOf(pm.price, pm.prevPrice);
      provPrice[pid] = pm.price;
    }

    // ---- 3. 本地价格（受区域价格信号传导）----
    for (const c of input.counties) {
      const cm = getCountyMarket(markets, c.countyId)[g];
      cm.supply = c.production[g];
      cm.demand = c.demand[g];
      const ratio = c.demand[g] / Math.max(c.production[g], 1e-9);
      const pProv = provPrice[c.provId] ?? base;
      const blend = 1 - BLEND_COUNTY_FROM_PROV + BLEND_COUNTY_FROM_PROV * (pProv / base);
      cm.prevPrice = cm.price;
      cm.price = base * clamp(ratio * blend, PRICE_CLAMP_MIN, PRICE_CLAMP_MAX);
      cm.trend = trendOf(cm.price, cm.prevPrice);
    }

    // ---- 4. 流向：县自产自销 → 盈余上流 / 缺口下补 ----
    // 4a. 县内结算
    const selfConsumed = new Map<number, number>();
    const surplus = new Map<number, number>();
    const deficit = new Map<number, number>();
    for (const c of input.counties) {
      const self = Math.min(c.production[g], c.demand[g]);
      selfConsumed.set(c.countyId, self);
      surplus.set(c.countyId, c.production[g] - self);
      deficit.set(c.countyId, c.demand[g] - self);
    }
    // 4b. 省内调剂：县盈余汇入省池，缺口按县 id 序贪心补足
    const countyConsumed = new Map<number, number>();
    const provNetSurplus: Record<number, number> = {};
    const provNetDeficit: Record<number, number> = {};
    for (const pid of provOrder) {
      const list = provCounties.get(pid) ?? [];
      let provSurplus = 0;
      let provDeficit = 0;
      for (const c of list) {
        provSurplus += surplus.get(c.countyId) ?? 0;
        provDeficit += deficit.get(c.countyId) ?? 0;
      }
      const filled = Math.min(provSurplus, provDeficit);
      let remaining = filled;
      for (const c of list) {
        const d = deficit.get(c.countyId) ?? 0;
        const take = Math.min(d, remaining);
        countyConsumed.set(c.countyId, (selfConsumed.get(c.countyId) ?? 0) + take);
        remaining -= take;
      }
      provNetSurplus[pid] = provSurplus - filled;
      provNetDeficit[pid] = provDeficit - filled;
      const pm = getProvMarket(markets, pid)[g];
      pm.netFlow = provNetSurplus[pid] - provNetDeficit[pid];
    }
    // 4c. 国家市场：库存承接省盈余，补省缺口，政府/建筑需求优先
    let nationSupply = 0;
    let nationDemand = 0;
    for (const pid of provOrder) {
      nationSupply += provNetSurplus[pid];
      nationDemand += provNetDeficit[pid];
    }
    nationSupply += input.factorySupply[g];
    nationDemand += input.govDemand[g] + input.buildingDemand[g];

    let stock = input.stocks[g] + nationSupply;
    const govConsumed = Math.min(input.govDemand[g], stock);
    stock -= govConsumed;
    let remainingStock = stock;
    const natFill: Record<number, number> = {};
    for (const pid of provOrder) {
      const need = provNetDeficit[pid];
      const fill = Math.min(need, remainingStock);
      natFill[pid] = fill;
      remainingStock -= fill;
    }
    stock = remainingStock; // 国家库存被省缺口消耗（守恒关键）
    const consumed = govConsumed + provOrder.reduce((s, pid) => s + natFill[pid], 0);
    m.consumed = consumed;
    m.exported = 0;
    m.imported = 0;
    // 未满足需求：建筑输入已由 economy 预扣自库存，此处扣除避免重复进口
    let unmet = nationDemand - consumed - input.buildingConsumed[g];
    if (unmet > 0) {
      const cap = BASE_TRADE_CAP[g] * input.routeCoef;
      const imported = Math.min(unmet, cap);
      m.imported = imported;
      stock += imported;
      unmet -= imported;
    }
    m.unmet = Math.max(0, unmet);
    if (stock > 0) {
      const cap = BASE_TRADE_CAP[g] * input.routeCoef;
      const exported = Math.min(stock, cap);
      m.exported = exported;
      stock -= exported;
    }
    input.stocks[g] = stock;

    tariff += (m.exported + m.imported) * WORLD_PRICE[g] * input.tariffRate;
    exportValue += m.exported * WORLD_PRICE[g];
    importValue += m.imported * WORLD_PRICE[g];

    // ---- 5. 区域/县消费回写（幸福度用）----
    let totalCountyConsumed = 0;
    for (const pid of provOrder) {
      const list = provCounties.get(pid) ?? [];
      let consumedSum = natFill[pid];
      let demandSum = 0;
      // 县剩余缺口（国家补足按比例分摊到县，仅展示用；守恒仍以省/国口径计）
      let dLeftTotal = 0;
      const dLeft = new Map<number, number>();
      for (const c of list) {
        const cc = countyConsumed.get(c.countyId) ?? 0;
        const self = selfConsumed.get(c.countyId) ?? 0;
        const dl = Math.max(0, (deficit.get(c.countyId) ?? 0) - (cc - self));
        dLeft.set(c.countyId, dl);
        dLeftTotal += dl;
      }
      for (const c of list) {
        const cc = countyConsumed.get(c.countyId) ?? 0;
        const natShare = dLeftTotal > 1e-12 ? (natFill[pid] * (dLeft.get(c.countyId) ?? 0)) / dLeftTotal : 0;
        consumedSum += cc;
        totalCountyConsumed += cc;
        demandSum += c.demand[g];
        const cm = getCountyMarket(markets, c.countyId)[g];
        cm.consumed = cc + natShare;
        cm.unmet = Math.max(0, cm.demand - cm.consumed);
        // 净流 = 产出 - 消费（>0 盈余外流 / <0 缺口由上级补足）
        cm.netFlow = c.production[g] - cm.consumed;
      }
      const pm = getProvMarket(markets, pid)[g];
      pm.consumed = consumedSum;
      pm.unmet = Math.max(0, demandSum - consumedSum);
      provConsumed[pid] = provConsumed[pid] ?? {};
      provDemand[pid] = provDemand[pid] ?? {};
      provConsumed[pid][g] = consumedSum;
      provDemand[pid][g] = demandSum;
    }
    // 国家总消费 = 县消费（自产+省内调剂+国家补足）+ 政府消费（守恒公式用；建筑消耗单独计）
    m.consumed = consumed + totalCountyConsumed;

    // ---- v0.4 单一商品税收入：税率 × 成交量（国内消费 + 进口 + 建筑消耗；出口为外国买方，不征） ----
    const taxVol = m.consumed + m.imported + buildingConsumed[g];
    commodityTax += (input.goodsTax[g] ?? 0) * taxVol;
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
