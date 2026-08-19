/**
 * 财政与经济全循环（v0.4）：
 *  - 立体税制：六税种连续滑块 0%-30%（土地/人头/消费/关税/特别 + 单一商品税全部商品可选）
 *    · 阶级负担矩阵（tax.ts CLASS_TAX_MATRIX）：各税种按阶级征收系数
 *    · 单一商品税：买方支付有效价 = 市价 × (1+税率)；收入 = 税率 × 成交量进国库
 *    · 产业链传导：输入品征税 → 下游建筑按税后价计成本 → 成品价格随成本上升（market.ts costPush）
 *  - 支出：军/行政/基建/宫廷/卫生 滑杆 → 行政提识字率、卫生提健康、基建提产能与降运费
 *  - 三级市场（17 商品：资源→半成品→成品）+ 国际贸易 + 建筑输入/产出接入
 *  - 产业链建筑：技能要求（无对应职业 POP → 产能打折）、输入消耗、加工损耗、产出进市场
 *  - 阶级系统：税收负担/奢侈品消费/政治影响力/幸福度/动乱倾向；奴隶恒低幸福
 *  - 投资回报：上层阶级 POP 投资收入（全国资本回报池按阶级财富占比分配）+ 玩家建筑月度回报
 *  - 阶级流动：识字率 + 财富驱动（labor.applyClassMobility，确定性）
 *  - 月度结算顺序（确定性，无随机）：
 *    基建演化 → 物流运费 → 生产/消费（含省资源与奢侈品）→ 建筑进度与运营（预扣输入）
 *    → 三级市场+贸易（含成本传导与商品税）→ 建筑现金（按税后输入价）→ 工资 → POP 投资收入
 *    → 幸福度/动乱/效率 → 人口增长+迁移 → 阶级流动 → 财政（六税种，含建筑现金流）→ 识字率/健康 → 稳定度
 */
import type { GameMap, Province } from './map';
import type { GameState, NationState, EconomicLaw } from './state';
import { addChronicle } from './state';
import type { GoodId, JobId, NationId } from './types';
import type { ClassId } from './types';
import { NATIONS } from './nations';
import {
  BASE_HOUSING_PER_CELL,
  BASE_WAGE,
  GOODS,
  INITIAL_JOB_MIX,
  JOBS,
  zeroJobMix,
  JOB_OUTPUT_PER_WAN,
  LUXURY_NEED_BASE,
  LUXURY_OUTPUT_PER_WAN,
  NEED_PER_WAN,
  RETRAIN_OUTPUT_PENALTY,
  clamp,
  classDef,
  farmerOutput,
  luxuryWealthCoef,
  minerOutput,
  provinceLuxuryPotential,
  CONSUME_MATRIX,
  JOB_CONSUME,
  EXPECTED_STD,
  JOB_LADDER,
  JOB_LATERAL,
} from './pops';
import { classPoliticalWeight, PROGRESSIVE_HAPPINESS, SUFFRAGE_HAPPINESS } from './classes';
import { classTaxCoefFor, taxPenalty, policyGrowthCoef } from './tax';
import type { NationTax } from './tax';
import { LABOR_DEMAND_PER_CELL, applyClassMobility, computeWages } from './labor';
import { settleMarket } from './market';
import type { CountyFlow, MarketState } from './market';
import { BASE_PRICE, GOODS_LIST, GOOD_CATEGORY, zeroGoods } from './market';
import { countyFreightFactor, provinceFreightFactor, isCoastal } from './logistics';
import { BUILDING_DEFS, BUILDING_KINDS, buildingSkillReqPop, buildingUnlock, startInvestment, terrainCostFactor } from './buildings';
import type { BuildingCategory, BuildingKind, InvestmentProject } from './buildings';
import { provinceHasResource } from './resources';

// ---- 税率（v0.4 连续滑块 0%-30%，见 tax.ts；TAX_RATES/TAX_LEVELS 已移除） ----

/** 人均年收入（万₭/人/年）≈ 1780 年代水平（v0.9 平衡：3.0→4.0，税收与消费同步升，缩小收支缺口） */
export const PER_CAPITA_INCOME = 4.0;
/** 人均年粮食消耗（吨/人/年）→ 每万人 0.09 万吨/年 */
export const GRAIN_PER_WAN_PERSON = 0.09;
/** 每陆地格基础年产粮（万吨/年，× 省份 grainMod） */
export const CELL_GRAIN_BASE = 0.9;
/** 每格土地年价值（万₭/格/年，× 产出修正） */
export const LAND_VALUE_PER_CELL = 2.4;
/** 破产触发阈值（国库万₭，允许负但记入大事记） */
export const BANKRUPTCY_THRESHOLD = -2000;
export const BANKRUPTCY_COOLDOWN = 12; // 月

/** 基建演化系数 */
export const INFRA_ROADS_K = 0.02;
export const INFRA_PORTS_K = 0.013;
export const INFRA_DECAY = 0.008;

/** 全国资本回报池系数（v0.3 上层阶级投资收入） */
export const CAPITAL_POOL_TRADE = 0.4; // 贸易顺差计入比例
export const CAPITAL_POOL_INDUSTRY = 0.5; // 建筑工业利润计入比例

// ---- v0.9 投资池（端明ちゃん 模型：分红 × 贡献比例 × 投资效率修正）----
/** 各人群投资贡献比例（分红/盈余中缴入投资池的比例） */
export const INVEST_RATE: Partial<Record<JobId, number>> & { noble: number; landlord: number } = {
  banker: 0.2, capitalist: 0.15, merchant: 0.05, shopkeeper: 0.05,
  peasant: 0.05, noble: 0.1, landlord: 0.07,
};
/** 经济体制 → 投资效率修正（试验数值；缺省 = 1 无修正） */
export const INVEST_EFF: Record<EconomicLaw, Partial<Record<JobId, number>> & { noble?: number; landlord?: number }> = {
  traditionalism: { banker: 0.5, capitalist: 0.5, merchant: 0.5, shopkeeper: 0.5, noble: 0.5, landlord: 0.5 },
  laissezFaire: { banker: 1.25, capitalist: 1.25, shopkeeper: 1.25, merchant: 1.15 },
  draconian: { peasant: 1.5, landlord: 1.5, noble: 1.5 },
};

// ---- v0.9 生活水平阶级偏移（收入端分化：贵族生活 ≈ 奴隶 5-10 倍；阶级=财富地位，流动为调节阀）----
export const CLASS_STD_SHIFT: Record<ClassId, number> = {
  1: 48, 2: 36, 3: 24, 4: 10, 5: -6, 6: -14, 7: -18,
};
/** 阶级财富乘数（v0.9：收入 = 职业收入 × 阶级乘数——贵族收入 ≈ 奴隶 6 倍，财富地位直接变现） */
export const CLASS_WAGE_MULT: Record<ClassId, number> = {
  1: 2.5, 2: 2.0, 3: 1.5, 4: 1.1, 5: 0.9, 6: 0.7, 7: 0.4,
};

// ---- v0.9 政府分红（国企利润 → 国库，效率受经济体制）----
export const GOV_DIV_EFF: Record<EconomicLaw, number> = {
  traditionalism: 0.9, // 传统体制国企利润抽取效率略低
  laissezFaire: 1.0,   // 自由放任中性
  draconian: 1.15,     // 龙本主义重视国家资本
};

/** 农奴制效率惩罚（未废奴且存在奴隶 → 产出 ×0.9） */
export const SERFDOM_PENALTY = 0.9;

/** v0.5 迁移软化：单省月流出上限 = 该省住房容量 × 2%（不再首月大额流亡） */
export const MIGRATION_CAP = 0.02;

/**
 * 建筑成本结构表（market.ts 成本传导用，避免 market↔buildings 循环依赖）：
 * 商品 → 生产该商品的建筑 { 每单位输出所需输入量, 满产产能 }。
 */
export const GOOD_PRODUCERS: Partial<Record<GoodId, { inputs: Partial<Record<GoodId, number>>; capacity: number }>> = (() => {
  const out: Partial<Record<GoodId, { inputs: Partial<Record<GoodId, number>>; capacity: number }>> = {};
  for (const kind of Object.keys(BUILDING_DEFS) as (keyof typeof BUILDING_DEFS)[]) {
    const def = BUILDING_DEFS[kind];
    if (!def.output) continue; // 服务类建筑（学校/银行/市场）不产商品
    out[def.output] = {
      inputs: { ...def.inputs, ...(def.anyOf ? { [def.anyOf[0]]: 1.2 } : {}) },
      capacity: def.capacity,
    };
    for (const v of def.variants ?? []) {
      out[v.output] = {
        inputs: { ...v.inputs, ...(v.anyOf ? { [v.anyOf[0]]: 1.2 } : {}) },
        capacity: def.capacity,
      };
    }
  }
  return out;
})();

/** 月度账本（结算后写入 nation.monthly，UI 与守恒断言读取） */
export interface MonthlyLedger {
  income: number;
  spending: number;
  // ---- v0.4 六税种实收（万₭/月） ----
  pollTax: number;
  landTax: number;
  /** 消费税（市民/工匠/工人等消费者） */
  consumptionTax: number;
  /** 关税（进出口额） */
  tariff: number;
  /** 其他特别税（运力/港口/印花，按贸易与运输量） */
  otherTax: number;
  /** 单一商品税（Σ 税率 × 成交量，全部商品可选） */
  goodsTax: number;
  exportValue: number;
  importValue: number;
  tradeBalance: number;
  foodProd: number;
  foodConsumed: number;
  /** 粮食盈余比例（-1..1） */
  foodSurplus: number;
  /** 年化人口增长率 */
  growthRate: number;
  // ---- v0.2 投资现金流 ----
  /** POP 投资收入（全国资本回报池分配，万₭/月） */
  investIncome: number;
  /** 玩家投资回报（建筑月度回报，万₭/月，可为负=亏损） */
  investReturn: number;
  /** 玩家投资支出（本月新建项目成本合计） */
  investCost: number;
  /** 玩家投资取消退款（本月合计） */
  investRefund: number;
  // ---- v0.5 迁移（软化的月迁移账） ----
  /** 本月省外流人口合计（万人，过挤省推挤） */
  migrationOut: number;
  /** 本月迁入人口合计（万人，空余省拉引） */
  migrationIn: number;
}

export function zeroLedger(): MonthlyLedger {
  return {
    income: 0, spending: 0, pollTax: 0, landTax: 0, consumptionTax: 0, tariff: 0, otherTax: 0, goodsTax: 0,
    exportValue: 0, importValue: 0, tradeBalance: 0,
    foodProd: 0, foodConsumed: 0, foodSurplus: 0, growthRate: 0,
    investIncome: 0, investReturn: 0, investCost: 0, investRefund: 0,
    migrationOut: 0, migrationIn: 0,
  };
}

// ---- 兼容辅助（v0.0.0 接口，读上月账本 / 省份状态） ----
export function nationMonthlyIncome(_map: GameMap, state: GameState, nationId: NationId): number {
  return state.nations[nationId].monthly.income;
}
export function nationMonthlySpending(state: GameState, nationId: NationId): number {
  return state.nations[nationId].monthly.spending;
}
/** 国家月粮食结余（万吨/月） */
export function nationMonthlyGrain(_map: GameMap, state: GameState, nationId: NationId): number {
  const m = state.nations[nationId].monthly;
  return m.foodProd - m.foodConsumed;
}
/** 国家年耗粮（万吨/年） */
export function nationGrainConsumption(state: GameState, nationId: NationId): number {
  return state.nations[nationId].popWan * GRAIN_PER_WAN_PERSON;
}
/** 省份年产粮（万吨/年，地图静态估算） */
export function provinceGrainPerYear(map: GameMap, provId: number): number {
  const prov = map.provinceById.get(provId);
  if (!prov) return 0;
  return prov.cellIds.length * CELL_GRAIN_BASE * prov.grainMod;
}
/** 国家年产粮（万吨/年） */
export function nationGrainPerYear(map: GameMap, nationId: NationId): number {
  let sum = 0;
  for (const prov of map.provinces) {
    if (prov.owner === nationId && !prov.isUndiscovered) sum += provinceGrainPerYear(map, prov.id);
  }
  return sum;
}
/** 省份人口（万人，来自省经济状态） */
export function provincePopWan(_map: GameMap, state: GameState, provId: number): number {
  return state.provinces[provId]?.popTotal ?? 0;
}

/** 基建水平演化（道路/港口 0-100） */
export function evolveInfra(n: NationState): void {
  n.infra.roads = clamp(0, 100, n.infra.roads + n.spending.infra * INFRA_ROADS_K - n.infra.roads * INFRA_DECAY);
  n.infra.ports = clamp(0, 100, n.infra.ports + n.spending.infra * INFRA_PORTS_K - n.infra.ports * INFRA_DECAY);
}

/** 基建产能加成（1+，工业/农业同享） */
export function infraCapacity(n: NationState): number {
  return 1 + (n.infra.roads + n.infra.ports) * 0.004;
}

/** 商路系数（海路=港口、陆路=道路 → 贸易容量放大） */
export function routeCoef(n: NationState): number {
  return 1 + (n.infra.ports / 100) * 0.5 + (n.infra.roads / 100) * 0.3;
}

// ---- 运力系统（v0.9 阶段 B）：基建产运力 → 加强项可选购 → 贸易吃运力 ----
/** 部门运力消耗（每产能单位/月）：采矿>工业>加工>农业（用户定稿） */
export const TRANSPORT_USE: Record<BuildingCategory, number> = {
  agriculture: 0.1, extraction: 0.5, processing: 0.3, heavy: 0.4, fine: 0.4, infra: 0,
};
/** 启用运力加强项的产能加成（按部门差异化，v0.9 E 阶段实测调参） */
export const TRANSPORT_BOOST: Record<BuildingCategory, number> = {
  agriculture: 1.2, extraction: 1.3, processing: 1.25, heavy: 1.3, fine: 1.3, infra: 1,
};
/** 每省运力限额基数（地形容量；基建/科技提升上限） */
export const TRANSPORT_CAP_BASE = 24;
/** 贸易吨位运力消耗系数（每吨调运/出口吃多少运力） */
export const TRADE_TRANSPORT = 0.2;

function provAvgH(map: GameMap, prov: Province): number {
  let s = 0, n = 0;
  for (const cid of prov.cellIds) {
    const c = map.cellsById.get(cid);
    if (c) { s += c.h; n++; }
  }
  return n ? s / n : 0;
}

/** 基建地形乘数：公路平原好 / 铁路山地好 / 港口沿海 */
export function transportTerrainFactor(map: GameMap, kind: BuildingKind, prov: Province): number {
  const avgH = provAvgH(map, prov);
  const coastal = isCoastal(map, prov);
  switch (kind) {
    case 'road': return avgH < 28 ? 1.4 : 0.9;
    case 'railroad': return avgH >= 28 ? 1.6 : 1.1;
    case 'canal': return 1.3;
    case 'port': return coastal ? 1.5 : 0.5;
    case 'lighthouse': return coastal ? 1.2 : 0.6;
    default: return 1;
  }
}

/** 省运力限额（地形容量）：基数 × 地形（平原/山地） */
export function provinceTransportCap(map: GameMap, prov: Province): number {
  return TRANSPORT_CAP_BASE * (provAvgH(map, prov) < 28 ? 1.4 : 1.15);
}

/** 全国运力充足度（0.25-1）：运力紧 → 贸易容量收缩（含建筑需求 + 贸易吨位） */
export function transportAdequacy(n: NationState): number {
  let stock = 0, demand = 0;
  for (const pid of Object.keys(n.provStocks)) stock += n.provStocks[Number(pid)]?.transport ?? 0;
  for (const p of n.projects) {
    if (p.status !== 'active') continue;
    const def = BUILDING_DEFS[p.kind];
    if (def.output) demand += (TRANSPORT_USE[def.category] ?? 0.3) * def.capacity;
  }
  // 贸易吨位（上月省际调运 + 出口，transport 商品自身除外）→ 运力需求
  for (const pid of Object.keys(n.provinceMarkets)) {
    const pmAll = n.provinceMarkets[Number(pid)];
    if (!pmAll) continue;
    for (const g of GOODS_LIST) {
      if (g === 'transport') continue;
      demand += (pmAll[g].flowOut ?? 0) + (pmAll[g].exported ?? 0);
    }
  }
  return clamp(stock / Math.max(1e-9, stock + demand), 0.25, 1);
}

/** 部门从业资质（v0.9 职业/阶级/资质三分）：允许职业集合，产能按集合内 POP 和 */
export const SKILL_ALLOW: Record<BuildingCategory, JobId[]> = {
  agriculture: ['slave', 'peasant', 'worker', 'clerk'],
  extraction: ['slave', 'worker', 'clerk', 'engineer', 'merchant'],
  processing: ['worker', 'technician', 'clerk', 'engineer', 'merchant', 'capitalist', 'banker'],
  heavy: ['worker', 'technician', 'clerk', 'engineer', 'merchant', 'capitalist', 'banker'],
  fine: ['worker', 'technician', 'clerk', 'engineer', 'merchant', 'capitalist', 'banker'],
  infra: ['worker', 'technician', 'clerk', 'engineer', 'merchant'],
};

/** 国家政治影响力构成（阶级规模 × 政治权重；含普选修正）——UI「权势构成」 */
export function nationClassPower(map: GameMap, state: GameState, nationId: NationId): Record<ClassId, number> {
  const n = state.nations[nationId];
  const power: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) {
      power[pop.class] += pop.size * classPoliticalWeight(pop.class, n.policies.universalSuffrage);
    }
  }
  return power;
}

/** 国家阶级人口合计（万人，断言/UI 用） */
export function nationClassMixOf(map: GameMap, state: GameState, nationId: NationId): Record<ClassId, number> {
  const mix: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) mix[pop.class] += pop.size;
  }
  return mix;
}

/** 国家动乱指数（下层不满加权，0 起，越大越危险） */
export function nationUnrest(map: GameMap, state: GameState, nationId: NationId): number {
  let unrestSum = 0;
  let total = 0;
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) {
      unrestSum += pop.size * ((100 - pop.happiness) / 100) * classDef(pop.class).unrestWeight;
      total += pop.size;
    }
  }
  return total > 1e-9 ? unrestSum / total : 0;
}

/** 国家奴隶人口（万人，政策/断言用） */
export function nationSlavePop(map: GameMap, state: GameState, nationId: NationId): number {
  let sum = 0;
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) if (pop.class === 7) sum += pop.size;
  }
  return sum;
}

/** 国家人口加权平均幸福度（0-100，v0.7 侧栏图表用） */
export function nationAvgHappiness(map: GameMap, state: GameState, nationId: NationId): number {
  let sum = 0;
  let total = 0;
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    sum += ps.happiness * ps.popTotal;
    total += ps.popTotal;
  }
  return total > 1e-9 ? sum / total : 50;
}

/** 月度经济全循环（只结算玩家国家；无随机，确定性） */
export function settleEconomyMonth(state: GameState, map: GameMap): void {
  const id = state.playerNation;
  const n = state.nations[id];
  const def = NATIONS[id];
  const tax: NationTax = n.tax;
  const penalty = taxPenalty(tax);
  const provIds = map.provinces
    .filter((p) => p.owner === id && !p.isUndiscovered)
    .map((p) => p.id);

  // ---- 1. 基建演化 ----
  evolveInfra(n);
  const infraCap = infraCapacity(n);

  // ---- 2. 物流：跨省运费 + 省内县运费 ----
  const capital = provIds.length > 0 ? (map.provinceById.get(provIds[0]) ?? null) : null;
  const crossFreight: Record<number, number> = {};
  let freightSum = 0;
  for (const pid of provIds) {
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    const f = provinceFreightFactor(map, prov, capital, n.infra);
    state.provinces[pid].freight = f;
    crossFreight[pid] = f;
    freightSum += f;
  }
  const avgFreight = provIds.length > 0 ? freightSum / provIds.length : 1;

  // ---- 3. 生产与消费（逐省：职业产出 + 省资源 + 奢侈品；阶级消费倍率） ----
  const prodAgg = zeroGoods();
  const consAgg = zeroGoods();
  const wealthCoef = luxuryWealthCoef(n);
  // 农奴制效率惩罚：未废奴且存在奴隶 → 整体效率 ×0.9
  let slavePop = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) if (pop.class === 7) slavePop += pop.size;
  }
  const serfPenalty = !n.policies.abolishedSerfdom && slavePop > 0.1 ? SERFDOM_PENALTY : 1;
  n.slavePop = slavePop;

  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    const luxPot = provinceLuxuryPotential(prov);
    const out = zeroGoods();
    let luxDemand = 0;
    for (const pop of ps.pops) {
      const retrainMult = pop.retrainMonths > 0 ? RETRAIN_OUTPUT_PENALTY : 1;
      const eff = ps.efficiency * infraCap * retrainMult * serfPenalty;
      if (pop.job === 'slave' || pop.job === 'peasant') {
        const o = farmerOutput(prov, pop.size, eff);
        for (const g of GOODS) out[g] += o[g];
      } else if (pop.job === 'worker') {
        const o = minerOutput(prov, pop.size, eff);
        for (const g of GOODS) out[g] += o[g];
      } else if (pop.job === 'technician' || pop.job === 'clerk' || pop.job === 'bureaucrat') {
        out.clothing += pop.size * JOB_OUTPUT_PER_WAN[pop.job] * eff;
      } else if (pop.job === 'soldier') {
        // 军人：无产出（吃军饷）
      } else if (pop.job === 'shopkeeper' || pop.job === 'merchant' || pop.job === 'capitalist' || pop.job === 'banker') {
        out.luxury += pop.size * JOB_OUTPUT_PER_WAN[pop.job] * eff;
      } else {
        out.tools += pop.size * JOB_OUTPUT_PER_WAN.engineer * eff;
      }
      // 奢侈品：工匠/工程师附加产出（× 省奢侈品潜力）
      const luxOut = pop.size * LUXURY_OUTPUT_PER_WAN[pop.job] * luxPot * eff;
      out.luxury += luxOut;
      // 奢侈品需求：仅上层阶级（1-3 必享/偶享，4 级偶发）；随阶级规模与幸福度
      const cd = classDef(pop.class);
      if (cd.luxuryAccess > 0) {
        luxDemand += pop.size * cd.luxuryAccess * (0.35 + 0.65 * (pop.happiness / 100));
      }
    }
    ps.output = out;
    for (const g of GOODS) prodAgg[g] += out[g];
    // 需求（v0.9 消费矩阵：基础需求 × 阶级权重 × 职业乘数 × 阶级消费倍率；渔获为粮食替代）
    const d = zeroGoods();
    for (const pop of ps.pops) {
      const cons = classDef(pop.class).consumptionMult;
      const jm = JOB_CONSUME;
      const m = (g: GoodId, base: number) => base * cons * (CONSUME_MATRIX[g]?.[pop.class] ?? 1) * (jm[g]?.[pop.job] ?? 1);
      d.food += pop.size * m('food', NEED_PER_WAN.food);
      d.wheat += pop.size * m('wheat', NEED_PER_WAN.wheat);
      d.meat += pop.size * m('meat', NEED_PER_WAN.meat);
      d.fish += pop.size * m('fish', NEED_PER_WAN.fish);
      d.sugar += pop.size * m('sugar', NEED_PER_WAN.sugar);
      d.coffee += pop.size * m('coffee', NEED_PER_WAN.coffee);
      d.tobacco += pop.size * m('tobacco', NEED_PER_WAN.tobacco);
      d.clothing += pop.size * m('clothing', NEED_PER_WAN.clothing);
      d.fineFood += pop.size * m('fineFood', NEED_PER_WAN.fineFood);
      d.coal += pop.size * m('coal', NEED_PER_WAN.coal);
    }
    d.luxury = luxDemand * LUXURY_NEED_BASE * wealthCoef;
    ps.demand = d;
    for (const g of GOODS) consAgg[g] += d[g];
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
    ps.housingCap = prov.cellIds.length * BASE_HOUSING_PER_CELL * (1 + (n.infra.roads + n.infra.ports) * 0.006);
  }

  // 政府需求：军费耗武器/煤、基建耗工具/木材/煤、行政耗衣物/煤、宫廷耗奢侈品
  const govDemand = zeroGoods();
  govDemand.clothing = n.spending.admin * 0.004;
  govDemand.swords = n.spending.military * 0.0012;
  govDemand.muskets = n.spending.military * 0.001;
  govDemand.cannons = n.spending.military * 0.0008;
  govDemand.tools = n.spending.infra * 0.005;
  govDemand.luxury = n.spending.court * 0.0008;
  govDemand.coal = n.spending.admin * 0.002 + n.spending.military * 0.001;
  govDemand.timber = n.spending.infra * 0.002;

  // ---- 4. 三级市场输入：县流量（按格数分摊省产/省需） ----
  const counties: CountyFlow[] = [];
  for (const pid of provIds) {
    const prov = map.provinceById.get(pid);
    const ps = state.provinces[pid];
    if (!prov || !ps) continue;
    const provCells = Math.max(1, prov.cellIds.length);
    for (const county of prov.counties) {
      const share = county.cellIds.length / provCells;
      const prod = zeroGoods();
      const dem = zeroGoods();
      for (const g of GOODS) {
        prod[g] = ps.output[g] * share;
        dem[g] = ps.demand[g] * share;
      }
      counties.push({
        countyId: county.id,
        provId: pid,
        production: prod,
        demand: dem,
        intraFreight: countyFreightFactor(map, county, prov, n.infra),
      });
    }
  }

  // ---- 5. 建筑进度与运营（v0.3 产业链；v0.8 产出/输入消耗按省入账） ----
  const provFactorySupply: Record<number, Record<GoodId, number>> = {};
  const provBuildingDemand: Record<number, Record<GoodId, number>> = {};
  const provBuildingConsumed: Record<number, Record<GoodId, number>> = {};
  const provGoods = (m: Record<number, Record<GoodId, number>>, pid: number): Record<GoodId, number> => {
    let r = m[pid];
    if (!r) {
      r = zeroGoods();
      m[pid] = r;
    }
    return r;
  };
  const newlyCompleted = new Set<number>();
  for (const p of n.projects) {
    if (p.status === 'building') {
      p.monthsLeft -= 1;
      if (p.monthsLeft <= 0) {
        p.status = 'active';
        p.monthsLeft = 0;
        newlyCompleted.add(p.id);
        const prov = map.provinceById.get(p.provId);
        addChronicle(state, `「${BUILDING_DEFS[p.kind].label}」落成`, prov ? `行省 #${p.provId + 1} · ${prov.counties.length} 县` : `行省 #${p.provId + 1}`);
      }
    }
  }
  // ---- 运力预计算（省级自动启用加强项）：省运输库存 ≥ 需求 → 启用 ----
  const transpPolicy = n.transportPolicy !== 'off';
  const provTUse: Record<number, number> = {};
  for (const p of n.projects) {
    if (p.status !== 'active' || newlyCompleted.has(p.id)) continue;
    const def = BUILDING_DEFS[p.kind];
    if (!def.output) continue; // 基建建筑产运力，不消耗
    provTUse[p.provId] = (provTUse[p.provId] ?? 0) + (TRANSPORT_USE[def.category] ?? 0.3) * def.capacity;
  }
  const provTEnabled: Record<number, boolean> = {};
  if (transpPolicy) {
    for (const pid of Object.keys(provTUse)) {
      const stock = n.provStocks[Number(pid)]?.transport ?? 0;
      provTEnabled[Number(pid)] = stock >= (provTUse[Number(pid)] ?? 0);
    }
  }
  const transpAdequacy = transportAdequacy(n);
  // 已投产（含上月投产）的建筑：技能要求 → 从本省库存预扣输入 → 产出进本省市场供给
  // 支持：必输 inputs（都要）+ anyOf（任一选库存最足）+ 变体产线（armory）+ 服务类无输出（school/bank/market）
  for (const p of n.projects) {
    if (p.status !== 'active' || newlyCompleted.has(p.id)) continue;
    const def = BUILDING_DEFS[p.kind];
    const varDef = (def.variants ?? [])[p.variant ?? 0];
    const baseInputs = { ...def.inputs, ...(varDef?.inputs ?? {}) };
    const anyOf = (varDef?.anyOf ?? def.anyOf) ?? [];
    const mainOutput = varDef?.output ?? def.output;
    const ps = state.provinces[p.provId];
    let skillPop = 0;
    if (ps) {
      const allow = SKILL_ALLOW[def.category];
      for (const pop of ps.pops) if (allow.includes(pop.job)) skillPop += pop.size;
    }
    const skillFactor = clamp(skillPop / buildingSkillReqPop(def), 0, 1);
    // 输入可用性：按本省库存（建筑按项目 id 序确定性占用）
    const provStock = n.provStocks[p.provId] ?? (n.provStocks[p.provId] = zeroGoods());
    let avail = 1;
    const inputGoods = Object.keys(baseInputs) as GoodId[];
    for (const g of inputGoods) {
      const need = (baseInputs[g] ?? 0) * skillFactor;
      if (need > 0) {
        const have = Math.max(0, provStock[g] ?? 0);
        avail = Math.min(avail, have / need);
      }
    }
    // anyOf：选本省库存最充足的原料（确定性；任一即满足）
    let chosenAny: GoodId | null = null;
    if (anyOf.length > 0) {
      let best: GoodId | null = null;
      let bestHave = -1;
      for (const g of anyOf) {
        const have = Math.max(0, provStock[g] ?? 0);
        if (have > bestHave) { best = g; bestHave = have; }
      }
      if (best) {
        chosenAny = best;
        const need = 1.2 * skillFactor;
        avail = Math.min(avail, Math.max(0, provStock[best] ?? 0) / Math.max(1e-9, need));
      }
    }
    avail = clamp(avail, 0, 1);
    // 预扣输入（从本省库存；守恒 = 生产+进口+净流入 = 消费+出口+Δ库存+建筑消耗）
    const inputUsed = {} as Record<GoodId, number>;
    for (const g of inputGoods) {
      const need = (baseInputs[g] ?? 0) * skillFactor;
      const used = need * avail;
      if (used > 0) {
        provStock[g] -= used;
        n.stocks[g] -= used;
        inputUsed[g] = used;
        provGoods(provBuildingConsumed, p.provId)[g] += used;
        provGoods(provBuildingDemand, p.provId)[g] += need; // 价格信号用「期望输入」
      }
    }
    if (chosenAny) {
      const need = 1.2 * skillFactor;
      const used = need * avail;
      provStock[chosenAny] -= used;
      n.stocks[chosenAny] -= used;
      inputUsed[chosenAny] = used;
      provGoods(provBuildingConsumed, p.provId)[chosenAny] += used;
      provGoods(provBuildingDemand, p.provId)[chosenAny] += need;
    }
    // 运力加强项（省级自动启用）：运力需求并入 avail（不足则减产），预扣同普通输入
    const isInfra = def.category === 'infra';
    const boosted = !isInfra && !!provTEnabled[p.provId];
    const tNeed = boosted ? ((TRANSPORT_USE[def.category] ?? 0.3) * def.capacity) * skillFactor : 0;
    if (tNeed > 1e-9) {
      avail = Math.min(avail, Math.max(0, provStock.transport ?? 0) / tNeed);
    }
    avail = clamp(avail, 0, 1);
    if (boosted && tNeed > 1e-9) {
      const tUse = tNeed * avail;
      if (tUse > 1e-9) {
        provStock.transport = Math.max(0, (provStock.transport ?? 0) - tUse);
        n.stocks.transport = Math.max(0, (n.stocks.transport ?? 0) - tUse);
        inputUsed.transport = tUse;
        provGoods(provBuildingConsumed, p.provId).transport += tUse;
        provGoods(provBuildingDemand, p.provId).transport += tNeed;
      }
    }
    // 地形乘数（基建）+ 运力加强项产能加成
    const provB = map.provinceById.get(p.provId);
    const terrain = isInfra && mainOutput && provB ? transportTerrainFactor(map, def.kind, provB) : 1;
    const boost = boosted ? (TRANSPORT_BOOST[def.category] ?? 1.25) : 1;
    let output = mainOutput ? def.capacity * skillFactor * avail * terrain * boost : 0;
    // 运力限额（产出端）：基建产出不超省地形容量，守恒成立
    if (mainOutput === 'transport' && provB) {
      const cap = provinceTransportCap(map, provB);
      const cur = provStock.transport ?? 0;
      output = Math.max(0, Math.min(output, Math.max(0, cap - cur)));
    }
    if (mainOutput) provGoods(provFactorySupply, p.provId)[mainOutput] += output;
    // 建造部门：产建造力池（非市场资源，全国通用不耗运力）
    if (def.buildPowerPer) {
      const bp = def.buildPowerPer * skillFactor * avail;
      n.buildPower += bp;
      output = bp;
    }
    p.lastSkillFactor = skillFactor;
    p.lastRunFactor = avail;
    p.lastOutput = output;
    p.lastInputUsed = inputUsed;
    p.lastInputCost = 0;
    p.lastRevenue = 0;
  }
  // ---- 6. 市场（v0.8 省为结算单元）+ 国际贸易（建筑输入参与省价格形成与守恒） ----
  const marketState: MarketState = {
    national: n.market,
    province: n.provinceMarkets,
    county: n.countyMarkets,
  };
  const snap = settleMarket(
    {
      counties,
      provFactorySupply,
      provBuildingDemand,
      provBuildingConsumed,
      govDemand,
      provStocks: n.provStocks,
      routeCoef: routeCoef(n) * transpAdequacy, // 运力不足 → 贸易容量收缩
      tariffRate: tax.rates.tariff,
      goodsTax: tax.goods,
      producers: GOOD_PRODUCERS,
      crossFreight,
      natFreight: avgFreight,
      openTrade: n.openTrade,
      exportRights: n.exportRights,
    },
    marketState,
  );
  // 国家聚合库存 = Σ 省库存（市场已原地更新 provStocks）
  for (const g of GOODS_LIST) {
    let sum = 0;
    for (const pid of Object.keys(n.provStocks)) sum += n.provStocks[Number(pid)][g];
    n.stocks[g] = sum;
  }
  n.foodStock = n.stocks.food; // 镜像到 v0.0.0 字段

  // ---- 7. 建筑现金（v0.9 双轨+资本池）：国营利润入国库；私营利润 60% 分红入池（给资本侧当收入）40% 留存本金（再投资） ----
  let investReturn = 0;
  let privateDividend = 0; // 私营分红池（当月分给资本家/商人/银行家/贵族）
  const bankrupt: InvestmentProject[] = [];
  for (const p of n.projects) {
    if (p.status === 'active' && !newlyCompleted.has(p.id)) {
      const def = BUILDING_DEFS[p.kind];
      const varDef = (def.variants ?? [])[p.variant ?? 0];
      const mainOutput = varDef?.output ?? def.output;
      if (!mainOutput) continue; // 服务类建筑（学校/银行/市场）无产出现金流
      const provM = n.provinceMarkets[p.provId];
      const outPrice = provM ? provM[mainOutput].price : n.market[mainOutput].price;
      p.lastRevenue = p.lastOutput * outPrice;
      let inputCost = 0;
      for (const g of Object.keys(p.lastInputUsed) as GoodId[]) {
        // v0.4 传导账：输入按「税后有效价」（含商品税与上游成本传导）
        inputCost += (p.lastInputUsed[g] ?? 0) * (provM ? provM[g].effPrice : n.market[g].effPrice);
      }
      p.lastInputCost = inputCost;
      const idleScale = 0.3 + 0.7 * p.lastRunFactor * p.lastSkillFactor;
      const profit = p.lastRevenue - inputCost - def.opCost * idleScale;
      if (p.owner === 'private') {
        privateDividend += profit; // 私营利润 100% 进分红池（投资池从分红按贡献比例抽取）
        p.lossMonths = profit < -1 ? p.lossMonths + 1 : 0;
        if (p.lossMonths >= 3) bankrupt.push(p); // 连续 3 月亏损 → 破产
      } else {
        investReturn += profit; // 国营利润入国库
      }
    }
  }
  // 私营破产：移除项目（失业由省 POP 自然反映）
  for (const p of bankrupt) {
    const idx = n.projects.indexOf(p);
    if (idx >= 0) {
      n.projects.splice(idx, 1);
      addChronicle(state, `「${BUILDING_DEFS[p.kind].label}」破产倒闭（连续亏损）`, `行省 #${p.provId + 1} · 私营`);
    }
  }

  // ---- 7.5 私营自动投资：资本池充裕 → 投利润/成本比最高的可建建筑（不超上限） ----
  if (n.capitalWealth >= 150) {
    let best: { kind: BuildingKind; provId: number; cost: number; ratio: number } | null = null;
    for (const kind of BUILDING_KINDS) {
      const def = BUILDING_DEFS[kind];
      if (!def.output) continue; // 只投商品建筑（服务加成阶段 D 不自动投）
      if (GOOD_CATEGORY[def.output] === 'semi') continue; // 中间品无直接需求，资本家不建卖不动的厂
      const estProfit = def.capacity * n.market[def.output].price - def.opCost;
      if (estProfit <= 0) continue;
      for (const pid of provIds) {
        const prov = map.provinceById.get(pid);
        if (!prov) continue;
        const unlock = buildingUnlock(map, kind, prov, n.infra, { stocks: n.stocks, projects: n.projects, literacy: n.literacy });
        if (!unlock.ok) continue;
        const cost = def.cost * terrainCostFactor(map, kind, prov);
        if (cost > n.capitalWealth) continue;
        const ratio = estProfit / cost;
        if (!best || ratio > best.ratio) best = { kind, provId: pid, cost, ratio };
      }
    }
    if (best && best.cost <= n.capitalWealth) {
      startInvestment(state, map, best.kind, best.provId, undefined, 'private');
      n.capitalWealth -= best.cost;
      addChronicle(state, `资本家投资新建「${BUILDING_DEFS[best.kind].label}」`, `行省 #${best.provId + 1} · 私营`);
    }
  }

  // ---- 8. 劳动力市场：工资 ----
  // ---- 8. 劳动力市场：工资（v0.9 按省供需比——物以稀为贵：省岗位供需比决定工资，首都稀缺技能岗位供需比高 → 工资高） ----
  const wages = computeWages(zeroJobMix(), zeroJobMix()); // 全国兜底（极少用到）
  const provWages: Record<number, Record<JobId, number>> = {};
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    const s = zeroJobMix();
    const d = zeroJobMix();
    for (const pop of ps.pops) s[pop.job] += pop.size;
    for (const job of JOBS) d[job] += prov.cellIds.length * LABOR_DEMAND_PER_CELL[job];
    // 军人/官僚俸禄挂钩军费/行政开支（按省摊）：开支低 → 俸禄低 → 穷官僚/军饷不足
    d.soldier += (n.spending.military * 0.02) / Math.max(1, provIds.length);
    d.bureaucrat += (n.spending.admin * 0.02) / Math.max(1, provIds.length);
    provWages[pid] = computeWages(s, d);
  }
  // 低俸禄改行移至幸福度段（pop.wage 按省设定后判断）

  // ---- 8.5 义务兵役（v0.9 仅战时）：按政体强度从自耕农/工人强制征兵；平时禁止强制转职 ----
  if (n.warTime) {
    const govRate = /独裁|帝国/.test(n.gov) ? 0.006 : /共和|城邦/.test(n.gov) ? 0.002 : 0.003;
    for (const pid of provIds) {
      const ps = state.provinces[pid];
      for (const pop of ps.pops) {
        if (pop.job !== 'peasant' && pop.job !== 'worker') continue;
        if (pop.class > 6) continue; // 奴役(7) 不征兵
        const amount = pop.size * govRate;
        if (amount <= 0.01) continue;
        pop.size -= amount;
        const t = ps.pops.find((p2) => p2.job === 'soldier' && p2.race === pop.race && p2.class === pop.class);
        if (t) t.size += amount;
        else ps.pops.push({ ...pop, job: 'soldier', size: amount, expected: EXPECTED_STD.soldier, unrest: 0 });
      }
    }
  }

  // ---- 9. 资本回报池（分红）：私营利润 60% 分红 + 贸易顺差 40% —— 国营利润归国库，不参与分红 ----
  const tradeSurplus = Math.max(0, snap.exportValue - snap.importValue);
  const capitalPool = tradeSurplus * CAPITAL_POOL_TRADE + privateDividend;
  let eliteWealth = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      eliteWealth += pop.size * classDef(pop.class).wealthCoef;
    }
  }
  const perUnit = eliteWealth > 1e-9 ? capitalPool / eliteWealth : 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      // v0.9 分红只给资本侧职业 + 贵族：银行家 1.4 / 资本家 1.2 / 商人 1.0 / 贵族（阶级1-2）按 wealthCoef
      const CAP_JOB: Partial<Record<JobId, number>> = { banker: 1.4, capitalist: 1.2, merchant: 1.0 };
      const isCapitalist = pop.job === 'merchant' || pop.job === 'capitalist' || pop.job === 'banker' || pop.class <= 2;
      const wc = isCapitalist ? (CAP_JOB[pop.job] ?? 1.0) * classDef(pop.class).wealthCoef : 0;
      pop.investIncome = wc > 0 ? pop.size * wc * perUnit : 0;
    }
  }

  // ---- 9.5 投资池流入（端明ちゃん 模型）：Σ(分红/经营盈余 × 贡献比例 × 投资效率) → 汇入投资池（私营再投资本金）
  // 记账口径：不实际扣减 POP 分红（避免生活水平连锁触发改行导致市场账本抖动）
  const law = n.policies.economicLaw;
  // 全国平均收入（pop 加权，生活水平参照系）
  let natIncSum = 0, natIncW = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      natIncSum += (provWages[pid]?.[pop.job] ?? 0) * pop.size;
      natIncW += pop.size;
    }
  }
  const natAvgIncome = natIncW > 0 ? natIncSum / natIncW : 3;
  n.avgIncome = natAvgIncome; // 阶级流动参照系
  const effOf = (job: JobId, cls: ClassId): number => {
    const key: JobId | 'noble' | 'landlord' =
      cls <= 2 ? 'noble' : job === 'peasant' && cls <= 3 ? 'landlord' : job;
    return INVEST_EFF[law][key as never] ?? 1;
  };
  let investPoolIn = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      const isCap = pop.job === 'banker' || pop.job === 'capitalist' || pop.job === 'merchant' || pop.class <= 2;
      if (isCap) {
        const rateKey: JobId | 'noble' =
          pop.job === 'banker' || pop.job === 'capitalist' || pop.job === 'merchant' ? pop.job : 'noble';
        const rate = INVEST_RATE[rateKey] ?? 0;
        investPoolIn += pop.investIncome * rate * effOf(pop.job, pop.class);
      } else if (pop.job === 'shopkeeper' || pop.job === 'peasant') {
        // 店主/自耕农/地主：经营盈余（收入 − 基准生活成本） × 比例 × 效率
        const surplus = Math.max(0, pop.wage - BASE_WAGE.peasant * 0.8);
        const rateKey: JobId | 'landlord' = pop.job === 'peasant' && pop.class <= 3 ? 'landlord' : pop.job;
        const rate = INVEST_RATE[rateKey] ?? 0;
        investPoolIn += surplus * rate * effOf(pop.job, pop.class);
      }
    }
  }
  n.capitalWealth += investPoolIn; // 汇入投资池（私营自动建设本金）

  // ---- 9.5 省农业产出价值（v0.9 农民以卖产品收入，非工资；首都基建好/卖价高 → 农民不穷） ----
  // 分配：地主（阶级≤3 的 peasant）先拿 40% 大份（土地资本），其余 60% 按人口分（农民 1 / 奴隶 0.1 权重）
  const AGRI_GOODS: GoodId[] = ['food', 'wheat', 'meat', 'fish', 'sugar', 'cotton', 'timber', 'fur'];
  const agriValue: Record<number, number> = {};
  const landlordPop: Record<number, number> = {};
  const farmerPopW: Record<number, number> = {};
  for (const pid of provIds) {
    const ps0 = state.provinces[pid];
    const provM0 = n.provinceMarkets[pid];
    let v = 0;
    if (ps0 && provM0) {
      for (const g of AGRI_GOODS) v += (ps0.output[g] ?? 0) * (provM0[g]?.price ?? 0);
    }
    agriValue[pid] = v;
    let ld = 0, fm = 0;
    for (const pop of ps0.pops) {
      if (pop.job === 'peasant' || pop.job === 'slave') {
        if (pop.class <= 3) ld += pop.size;
        else fm += pop.size * (pop.job === 'slave' ? 0.1 : 1);
      }
    }
    landlordPop[pid] = ld;
    farmerPopW[pid] = fm;
  }

  // ---- 10. 幸福度 & 效率（按省：三级市场消费/需求；阶级基础幸福/税负/政策修正；奴隶恒低） ----
  // v0.4 税负基数：综合惩罚 + 人头/消费税档（按阶级负担矩阵分摊；累进税改写）
  const taxBurdenBase =
    penalty * 0.6 +
    (tax.rates.poll + tax.rates.consumption) * 100 * 0.08;
  const freightPenalty = Math.min(12, avgFreight * 3);
  let happSum = 0;
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const provDemandG = snap.provDemand[pid] ?? null;
    const provConsumedG = snap.provConsumed[pid] ?? null;
    const satOf = (g: GoodId): number => {
      if (!provDemandG || !provConsumedG) return 1;
      const d = provDemandG[g];
      return d > 0 ? clamp(provConsumedG[g] / d, 0, 1) : 1;
    };
    const satFoodBase = satOf('food');
    const satCloth = satOf('clothing');
    const satFuel = satOf('coal');
    // 渔获作为粮食替代：粮饱 = (粮 + 渔×0.35) / 粮需（封顶 1）
    const satFood = provDemandG && provConsumedG && provDemandG.food > 1e-9
      ? clamp((provConsumedG.food + provConsumedG.fish * 0.35) / provDemandG.food, 0, 1)
      : satFoodBase;
    const housingSat = clamp(ps.housingCap / Math.max(ps.popTotal, 1e-9), 0, 1);
    // v0.9 省物价指数（粮 50% / 衣 30% / 煤 20% 省价 ÷ 基准价）
    const provM0 = n.provinceMarkets[pid];
    const priceIdx = provM0
      ? (provM0.food.price / 2.0) * 0.5 + (provM0.clothing.price / 1.8) * 0.3 + (provM0.coal.price / 1.5) * 0.2
      : 1;
    let hSum = 0;
    for (const pop of ps.pops) {
      // ---- v0.9 收入按职业来源分流 ----
      if (pop.job === 'peasant' || pop.job === 'slave') {
        // 农业：地主（阶级≤3）拿农业价值 40% 大份（土地资本）；农民/奴隶分 60%（奴隶 0.1 权重）——首都卖价高 → 地主农民都不穷
        if (pop.class <= 3) {
          pop.wage = landlordPop[pid] > 1e-9 ? (agriValue[pid] * 12 * 0.55) / landlordPop[pid] : 0;
        } else {
          const w = pop.job === 'slave' ? 0.1 : 1;
          pop.wage = farmerPopW[pid] > 1e-9 ? (agriValue[pid] * 12 * 0.45 * w) / farmerPopW[pid] : 0;
        }
      } else if (pop.job === 'shopkeeper') {
        // 店主：工资 × 物价综合（物价高 → 店主赚更多）
        pop.wage = (provWages[pid]?.shopkeeper ?? wages.shopkeeper ?? 0) * (0.7 + 0.3 * priceIdx);
      } else if (pop.job === 'merchant' || pop.job === 'capitalist' || pop.job === 'banker') {
        // 资本侧：工资为基准（主要收入来自 investIncome 资本池分成）
        pop.wage = (provWages[pid]?.[pop.job] ?? wages[pop.job] ?? 0) * 0.6;
      } else {
        pop.wage = provWages[pid]?.[pop.job] ?? wages[pop.job] ?? 0;
      }
      // 贵族多源：土地/经营附加
      if (pop.class <= 2) pop.wage += 0.3 * classDef(pop.class).landCoef;
      // v0.9 阶级财富乘数：收入 = 职业收入 × 阶级乘数（贵族 ×2.5 / 奴役 ×0.3）——财富地位直接变现
      pop.wage *= CLASS_WAGE_MULT[pop.class] ?? 1;
      // 收入 = 工资（劳动） + 投资收入（上层；年化计入）
      const effWage = pop.wage + (pop.investIncome * 12) / Math.max(pop.size, 1e-9);
      const wageFactor = effWage / BASE_WAGE[pop.job];
      const needsSat = 0.35 * satFood + 0.2 * satCloth + 0.15 * satFuel + 0.3 * housingSat;
      pop.sat = { food: satFood, clothing: satCloth, housing: housingSat, fuel: satFuel };
      // ---- v0.9 生活水平 = 实际收入/生活成本 × 0.5 + 满足度 × 0.5 ----
      // 首都悖论解法：首都优渥来自三件事——①稀缺技能岗位供需比高（物以稀为贵）→ 名义工资高；
      // ②物价溢价（商品贵 → 农民卖价高/店主营业额高/名义工资货币化）；③资本集中（贸易金融在首都 → 资本池分成集中）。
      // 生活水平 = 省名义收入 × 省物价溢价 / 全国均价 → 首都实际购买力高于边远；边远省工资低×物价低 → 更贫困
      const natPriceIdx = provIds.length > 0
        ? provIds.reduce((s2, pid2) => {
            const m2 = n.provinceMarkets[pid2];
            return s2 + (m2 ? (m2.food.price / 2.0) * 0.5 + (m2.clothing.price / 1.8) * 0.3 + (m2.coal.price / 1.5) * 0.2 : 1);
          }, 0) / provIds.length
        : 1;
      const realIncome = effWage * (priceIdx / Math.max(0.4, natPriceIdx)); // 省工资 × 物价溢价 / 全国均价
      const incomeRatio = realIncome / Math.max(1e-9, natAvgIncome); // 相对全国平均收入（高低分化）
      // v0.9 满足度含成瘾品（咖啡/烟草）与服装：成瘾品缺货 → 生活水平降（需求非摆设；刚性 = 固定量不随价变）
      const satCoffee = satOf('coffee');
      const satTobacco = satOf('tobacco');
      const satAvg = (pop.sat.food + pop.sat.clothing + pop.sat.housing + pop.sat.fuel + satCoffee * 0.5 + satTobacco * 0.5) / 6;
      // v0.9 阶级分化：收入端（相对全国均值）+ 阶级偏移（贵族 +35 / 奴役 -28）→ 贵族生活 ≈ 奴隶 5-10 倍
      const shift = CLASS_STD_SHIFT[pop.class] ?? 0;
      pop.livingStd = clamp(clamp(incomeRatio, 0, 2) * 50 + satAvg * 20 + shift, 0, 100);
      pop.expected = EXPECTED_STD[pop.job];
      // 不满：低于预期每点缺口 +1/月；满意则缓释
      if (pop.livingStd < pop.expected) pop.unrest += pop.expected - pop.livingStd;
      else pop.unrest = Math.max(0, pop.unrest - 2);
      // 低俸禄改行：官僚/军人俸禄 < 0.75×基准 → 每月 2% 转回平民（穷官僚/军饷不足，非强制）
      if ((pop.job === 'soldier' && pop.wage < BASE_WAGE.soldier * 0.75) ||
          (pop.job === 'bureaucrat' && pop.wage < BASE_WAGE.bureaucrat * 0.75)) {
        const leave = pop.size * 0.02;
        if (leave > 0.01) {
          const fallback: JobId = pop.job === 'soldier' ? 'worker' : 'clerk';
          pop.size -= leave;
          const t = ps.pops.find((p2) => p2.job === fallback && p2.race === pop.race && p2.class === pop.class);
          if (t) t.size += leave;
          else ps.pops.push({ ...pop, job: fallback, size: leave });
        }
      }
      // ---- 自发改行：不满 + 省内存在高薪可得岗位 → 概率转职（不满越高越积极；转职后不满减半） ----
      if (pop.unrest >= 5) {
        const options: JobId[] = [];
        const up = JOB_LADDER[pop.job];
        if (up) options.push(up);
        options.push(...(JOB_LATERAL[pop.job] ?? []));
        let best: JobId | null = null;
        let bestW = -1;
        for (const o of options) {
          const w = provWages[pid]?.[o] ?? wages[o] ?? 0;
          if (w > bestW) { bestW = w; best = o; }
        }
        if (best && bestW > pop.wage * 1.05) {
          const chance = Math.min(0.02, 0.001 + pop.unrest / 1500);
          const amount = pop.size * chance;
          if (amount > 0.01) {
            pop.size -= amount;
            const t = ps.pops.find((p2) => p2.job === best && p2.race === pop.race && p2.class === pop.class);
            if (t) t.size += amount;
            else ps.pops.push({ ...pop, job: best, size: amount, expected: EXPECTED_STD[best], unrest: 0 });
            pop.unrest *= 0.5;
          }
        }
      }
      // 苛税打在下层：税负 × 阶级负担矩阵（人头+消费均摊；累进税改写上层↑下层↓）
      const tc =
        (classTaxCoefFor('poll', pop.class, n.policies.progressiveTax) +
          classTaxCoefFor('consumption', pop.class, n.policies.progressiveTax)) /
        2;
      const taxBurden = taxBurdenBase * tc;
      const polHap =
        (n.policies.progressiveTax ? PROGRESSIVE_HAPPINESS[pop.class] : 0) +
        (n.policies.universalSuffrage ? SUFFRAGE_HAPPINESS[pop.class] : 0);
      let happiness = clamp(
        0, 100,
        classDef(pop.class).baseHappiness +
          55 * (needsSat - 0.85) +
          12 * (wageFactor - 1) -
          taxBurden -
          freightPenalty +
          (n.stability - 70) * 0.15 +
          polHap,
      );
      if (pop.class === 7) happiness = Math.min(happiness, 45); // 奴隶恒低
      pop.happiness = happiness;
      hSum += happiness * pop.size;
    }
    ps.happiness = ps.popTotal > 0 ? hSum / ps.popTotal : 50;
    ps.efficiency = 0.5 + 0.7 * (ps.happiness / 100);
    happSum += ps.happiness;
  }
  const avgHappiness = provIds.length > 0 ? happSum / provIds.length : 50;
  // 动乱指数（下层不满加权）→ 稳定度漂移
  let unrestSum = 0;
  let unrestTotal = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      unrestSum += pop.size * ((100 - pop.happiness) / 100) * classDef(pop.class).unrestWeight;
      unrestTotal += pop.size;
    }
  }
  n.unrest = unrestTotal > 1e-9 ? unrestSum / unrestTotal : 0;

  // ---- 11. 人口增长（粮食盈余 × 和平系数 × 政策系数） + 迁移/住房上限 ----
  const foodConsumed = n.market.food.consumed;
  const foodSupplyEff = prodAgg.food + n.market.food.imported;
  const foodSurplusRatio = clamp((foodSupplyEff - foodConsumed) / Math.max(foodConsumed, 1e-9), -1, 1);
  const peaceCoef = n.stability / 100;
  const policyCoef = policyGrowthCoef(tax);
  const annualGrowth = foodSurplusRatio * peaceCoef * policyCoef * 0.045;
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const local = 0.5 + ps.happiness / 100;
    const grow = (annualGrowth * local) / 12;
    for (const pop of ps.pops) pop.size = Math.max(0, pop.size * (1 + grow));
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
  }
  // 迁移（v0.5 软化）：月上限（单省 2% 容量）+ 推拉因子（拥挤度差/幸福度差），不再首月大额流亡
  //  推：过挤省（pop > cap）每月最多挤出 min(超额, 容量×2%)，进入迁移池
  //  拉：空余容量 × (0.5 + 幸福度/200) 权重 → 按比例分配给迁入省（确定性：省 id 序）
  //  剩余池 = 流民（emigration，代表流向他国/失踪人口；国家人口守恒 = 流出=迁入+流民）
  let migrationOut = 0;
  let migrationIn = 0;
  let pool = 0;
  // 1) 推：过挤省按上限流出
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const excess = ps.popTotal - ps.housingCap;
    if (excess > 1e-9) {
      const outflow = Math.min(excess, ps.housingCap * MIGRATION_CAP);
      if (outflow > 1e-9) {
        const ratio = 1 - outflow / Math.max(ps.popTotal, 1e-9);
        for (const pop of ps.pops) pop.size *= ratio;
        ps.popTotal -= outflow;
        pool += outflow;
        migrationOut += outflow;
      }
    }
  }
  // 2) 拉：按 空余容量 × 拉引系数（幸福度越高越有吸引力）分配迁移池
  if (pool > 1e-9) {
    const pulls: { pid: number; weight: number }[] = [];
    for (const pid of provIds) {
      const ps = state.provinces[pid];
      const free = ps.housingCap - ps.popTotal;
      if (free > 1e-9) {
        const w = free * (0.5 + ps.happiness / 200);
        if (w > 1e-9) pulls.push({ pid, weight: w });
      }
    }
    if (pulls.length > 0) {
      const wSum = pulls.reduce((s, x) => s + x.weight, 0);
      let rem = pool;
      for (let i = 0; i < pulls.length && rem > 1e-9; i++) {
        const { pid, weight } = pulls[i];
        const ps = state.provinces[pid];
        const free = ps.housingCap - ps.popTotal;
        if (free <= 1e-9) continue;
        const share = i === pulls.length - 1 ? rem : (weight / wSum) * pool;
        const take = Math.min(free, share);
        if (take <= 1e-9) continue;
        const addRatio = 1 + take / Math.max(ps.popTotal, 1e-9);
        for (const pop of ps.pops) pop.size *= addRatio;
        ps.popTotal += take;
        rem -= take;
        migrationIn += take;
      }
      pool = Math.max(0, rem);
    }
    // 3) 兜底：剩余池按省 id 序填满所有空余（确定性）
    for (const pid of provIds) {
      if (pool <= 1e-9) break;
      const ps = state.provinces[pid];
      const free = ps.housingCap - ps.popTotal;
      if (free > 1e-9) {
        const take = Math.min(free, pool);
        const addRatio = 1 + take / Math.max(ps.popTotal, 1e-9);
        for (const pop of ps.pops) pop.size *= addRatio;
        ps.popTotal += take;
        pool -= take;
        migrationIn += take;
      }
    }
  }
  n.emigration = pool;
  n.popWan = provIds.reduce((s, pid) => s + state.provinces[pid].popTotal, 0);

  // ---- 12. 阶级流动（识字率 + 财富；奴隶不流动） ----
  applyClassMobility(state, map);
  // 流动后重算省人口
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
  }
  n.popWan = provIds.reduce((s, pid) => s + state.provinces[pid].popTotal, 0);

  // ---- 13. 财政（v0.4 六税种：土地/人头/消费/关税/特别/商品税；含建筑现金流） ----
  let pollTax = 0;
  let consumptionTax = 0;
  let landOwnerW = 0;
  let landPopTotal = 0;
  let landValue = 0;
  for (const pid of provIds) {
    const prov = map.provinceById.get(pid);
    if (prov) landValue += prov.cellIds.length * LAND_VALUE_PER_CELL * prov.productivity;
    for (const pop of state.provinces[pid].pops) {
      // 人头税：全体自由民（奴隶系数 0 免征）；消费税：消费者按阶级系数
      pollTax +=
        (pop.size * PER_CAPITA_INCOME * tax.rates.poll * classTaxCoefFor('poll', pop.class, n.policies.progressiveTax)) / 12;
      consumptionTax +=
        (pop.size * PER_CAPITA_INCOME * tax.rates.consumption * classTaxCoefFor('consumption', pop.class, n.policies.progressiveTax)) / 12;
      landOwnerW += pop.size * classTaxCoefFor('land', pop.class, n.policies.progressiveTax);
      landPopTotal += pop.size;
    }
  }
  const landOwnerFactor = landPopTotal > 1e-9 ? landOwnerW / landPopTotal : 1;
  const landTax = (landValue * tax.rates.land * landOwnerFactor) / 12;
  const tariff = snap.tariff;
  // 其他特别税：运力/港口/印花——按贸易与运输量（进出口额 × 1.2 作运输量代理）
  const otherTax = tax.rates.other * (snap.exportValue + snap.importValue) * 1.2;
  const goodsTax = snap.commodityTax;
  const income = pollTax + landTax + consumptionTax + tariff + otherTax + goodsTax;
  const spending = n.spending.military + n.spending.admin + n.spending.infra + n.spending.court + n.spending.health;

  const investCost = n.investCostAcc;
  const investRefund = n.investRefundAcc;
  n.investCostAcc = 0;
  n.investRefundAcc = 0;

  // 投资成本/退款已在 startInvestment/cancelInvestment 操作发生时入账，此处只记账不重复入账
  // v0.9 政府分红：国企利润按经济体制效率注入国库（传统 -10% / 自由放任 中性 / 龙本 +15%）
  const govDiv = investReturn * (GOV_DIV_EFF[n.policies.economicLaw] ?? 1);
  n.treasury += income - spending + govDiv;
  n.monthly = {
    income,
    spending,
    pollTax,
    landTax,
    consumptionTax,
    tariff,
    otherTax,
    goodsTax,
    exportValue: snap.exportValue,
    importValue: snap.importValue,
    tradeBalance: snap.exportValue - snap.importValue,
    foodProd: prodAgg.food,
    foodConsumed,
    foodSurplus: foodSurplusRatio,
    growthRate: annualGrowth,
    investIncome: capitalPool,
    investReturn: govDiv, // 政府分红后净值（守恒断言口径）
    investCost,
    investRefund,
    migrationOut,
    migrationIn,
  };

  // ---- 14. 识字率 & 健康（教育/卫生支出） ----
  const adminRatio = n.spending.admin / Math.max(1, def.sliderMax);
  const healthRatio = n.spending.health / Math.max(1, def.sliderMax);
  n.literacy = clamp(0, 1, n.literacy + (0.003 + 0.005 * adminRatio) / 12);
  n.health = clamp(0, 1, n.health + (0.002 + 0.004 * healthRatio) / 12);

  // ---- 15. 稳定度漂移（综合税负 + 缺粮 + 低幸福度 + 下层动乱） ----
  const satFoodNat = n.market.food.demand > 0 ? clamp(n.market.food.consumed / n.market.food.demand, 0, 1) : 1;
  const foodPenalty = (1 - satFoodNat) * 25;
  const happPenalty = Math.max(0, (55 - avgHappiness) * 0.25);
  const unrestPenalty = n.unrest * 10;
  const target = clamp(15, 100, 72 - penalty - foodPenalty - happPenalty - unrestPenalty);
  n.stability += (target - n.stability) * 0.05;
  n.stability = clamp(0, 100, n.stability);
}

/** 初始职业构成（导出供 UI/存档校验） */
export const INITIAL_JOBS = INITIAL_JOB_MIX;

/** 建筑在产状态（UI/断言辅助） */
export function activeBuildingProjects(n: NationState): InvestmentProject[] {
  return n.projects.filter((p) => p.status === 'active');
}

/** 省份是否有某资源（economy 便捷导出，供 UI 复用） */
export { provinceHasResource };

// ---- v0.4 税制 UI 辅助（阶级负担明细 / 传导提示） ----

export interface ClassTaxBurdenRow {
  land: number;
  poll: number;
  consumption: number;
  tariff: number;
  other: number;
  goods: number;
}

/**
 * 阶级负担明细：各阶级在六税种下各交多少（万₭/月）。
 * 与财政结算同公式；关税/特别税/商品税按上月账本总额按阶级权重分摊（显示用）。
 */
export function nationClassTaxBurden(
  map: GameMap,
  state: GameState,
  nationId: NationId,
): Record<ClassId, ClassTaxBurdenRow> {
  const n = state.nations[nationId];
  const tax = n.tax;
  const prog = n.policies.progressiveTax;
  const zero = (): ClassTaxBurdenRow => ({ land: 0, poll: 0, consumption: 0, tariff: 0, other: 0, goods: 0 });
  const rows: Record<ClassId, ClassTaxBurdenRow> = { 1: zero(), 2: zero(), 3: zero(), 4: zero(), 5: zero(), 6: zero(), 7: zero() };
  const landW: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const tariffW: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const otherW: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const goodsW: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  let landValue = 0;
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const prov = map.provinceById.get(p.id);
    if (prov) landValue += prov.cellIds.length * LAND_VALUE_PER_CELL * prov.productivity;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) {
      const c = pop.class;
      rows[c].poll +=
        (pop.size * PER_CAPITA_INCOME * tax.rates.poll * classTaxCoefFor('poll', c, prog)) / 12;
      rows[c].consumption +=
        (pop.size * PER_CAPITA_INCOME * tax.rates.consumption * classTaxCoefFor('consumption', c, prog)) / 12;
      landW[c] += pop.size * classTaxCoefFor('land', c, prog);
      tariffW[c] += pop.size * classTaxCoefFor('tariff', c, prog);
      otherW[c] += pop.size * classTaxCoefFor('other', c, prog);
      goodsW[c] += pop.size * classDef(c).consumptionMult;
    }
  }
  const wSum = (w: Record<ClassId, number>): number => {
    let s = 0;
    for (const c of [1, 2, 3, 4, 5, 6, 7] as ClassId[]) s += w[c];
    return s;
  };
  const landTotal = (landValue * tax.rates.land) / 12;
  const landWSum = wSum(landW);
  const tariffWSum = wSum(tariffW);
  const otherWSum = wSum(otherW);
  const goodsWSum = wSum(goodsW);
  for (const c of [1, 2, 3, 4, 5, 6, 7] as ClassId[]) {
    rows[c].land = landWSum > 1e-9 ? landTotal * (landW[c] / landWSum) : 0;
    rows[c].tariff = tariffWSum > 1e-9 ? n.monthly.tariff * (tariffW[c] / tariffWSum) : 0;
    rows[c].other = otherWSum > 1e-9 ? n.monthly.otherTax * (otherW[c] / otherWSum) : 0;
    rows[c].goods = goodsWSum > 1e-9 ? n.monthly.goodsTax * (goodsW[c] / goodsWSum) : 0;
  }
  return rows;
}

export interface TransmissionHint {
  from: GoodId;
  to: GoodId;
  pct: number;
  depth: number;
}

/**
 * 传导提示：对每个已征税商品，沿产业链（建筑输入链）BFS 找下游受影响商品，
 * 估算成本上浮百分比（如「煤炭税 15% → 钢材成本 +12%」）。显示用，最多返回 12 条。
 */
export function taxTransmissionHints(state: GameState): TransmissionHint[] {
  const n = state.nations[state.playerNation];
  const tax = n.tax;
  const hints: TransmissionHint[] = [];
  for (const from of GOODS) {
    const r = tax.goods[from];
    if (r <= 0.0001) continue;
    const queue: { g: GoodId; weight: number; depth: number }[] = [];
    for (const to of GOODS) {
      const prod = GOOD_PRODUCERS[to];
      if (!prod || !(prod.inputs[from] ?? 0)) continue;
      queue.push({ g: to, weight: (prod.inputs[from] ?? 0) / Math.max(1e-9, prod.capacity), depth: 1 });
    }
    while (queue.length > 0) {
      const cur = queue.shift() as { g: GoodId; weight: number; depth: number };
      const prod = GOOD_PRODUCERS[cur.g];
      const base = BASE_PRICE[cur.g];
      const pct = r * cur.weight * (n.market[from].price / Math.max(1e-9, base)) * 100;
      if (pct > 0.05) hints.push({ from, to: cur.g, pct, depth: cur.depth });
      if (cur.depth >= 3 || !prod) continue;
      for (const next of GOODS) {
        const np = GOOD_PRODUCERS[next];
        if (!np || !(np.inputs[cur.g] ?? 0)) continue;
        queue.push({ g: next, weight: cur.weight * ((np.inputs[cur.g] ?? 0) / Math.max(1e-9, np.capacity)), depth: cur.depth + 1 });
      }
    }
  }
  return hints.sort((a, b) => b.pct - a.pct).slice(0, 12);
}
