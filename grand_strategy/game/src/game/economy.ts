/**
 * 财政与经济全循环（v0.3）：
 *  - 税种：土地/人头/关税/盐税 × 税率档 × 阶级负担系数（苛税打在下层，上层可豁免）
 *  - 支出：军/行政/基建/宫廷/卫生 滑杆 → 行政提识字率、卫生提健康、基建提产能与降运费
 *  - 三级市场（17 商品：资源→半成品→成品）+ 国际贸易 + 建筑输入/产出接入
 *  - 产业链建筑：技能要求（无对应职业 POP → 产能打折）、输入消耗、加工损耗、产出进市场
 *  - 阶级系统：税收负担/奢侈品消费/政治影响力/幸福度/动乱倾向；奴隶恒低幸福
 *  - 投资回报：上层阶级 POP 投资收入（全国资本回报池按阶级财富占比分配）+ 玩家建筑月度回报
 *  - 阶级流动：识字率 + 财富驱动（labor.applyClassMobility，确定性）
 *  - 月度结算顺序（确定性，无随机）：
 *    基建演化 → 物流运费 → 生产/消费（含省资源与奢侈品）→ 建筑进度与运营（预扣输入）
 *    → 三级市场+贸易 → 建筑现金 → 工资 → POP 投资收入 → 幸福度/动乱/效率
 *    → 人口增长+迁移 → 阶级流动 → 财政（含建筑现金流）→ 识字率/健康 → 稳定度
 */
import type { GameMap } from './map';
import type { GameState, NationState } from './state';
import { addChronicle } from './state';
import type { GoodId, JobId, NationId, TaxLevel } from './types';
import type { ClassId } from './types';
import { NATIONS } from './nations';
import {
  BASE_HOUSING_PER_CELL,
  BASE_WAGE,
  GOODS,
  INITIAL_JOB_MIX,
  JOBS,
  JOB_OUTPUT_PER_WAN,
  LUXURY_NEED_BASE,
  LUXURY_OUTPUT_PER_WAN,
  NEED_PER_WAN,
  POLICY_GROWTH,
  RETRAIN_OUTPUT_PENALTY,
  clamp,
  classDef,
  farmerOutput,
  luxuryWealthCoef,
  minerOutput,
  provinceLuxuryPotential,
} from './pops';
import { classPoliticalWeight, classTaxCoef, PROGRESSIVE_HAPPINESS, SUFFRAGE_HAPPINESS } from './classes';
import { LABOR_DEMAND_PER_CELL, applyClassMobility, computeWages } from './labor';
import { settleMarket } from './market';
import type { CountyFlow, MarketState } from './market';
import { zeroGoods } from './market';
import { countyFreightFactor, provinceFreightFactor } from './logistics';
import { BUILDING_DEFS, buildingSkillReqPop } from './buildings';
import type { InvestmentProject } from './buildings';
import { provinceHasResource } from './resources';

// ---- 税率档（v0.0.0 四档扩展：rate 保留用于显示；rates 为四税种细率） ----
export interface TaxRates {
  land: number;
  poll: number;
  tariff: number;
  salt: number;
}
export const TAX_RATES: Record<TaxLevel, { label: string; rate: number; penalty: number; rates: TaxRates }> = {
  light: { label: '轻税', rate: 0.2, penalty: 0, rates: { land: 0.15, poll: 0.15, tariff: 0.1, salt: 0.1 } },
  medium: { label: '中税', rate: 0.3, penalty: 5, rates: { land: 0.25, poll: 0.3, tariff: 0.15, salt: 0.2 } },
  heavy: { label: '重税', rate: 0.42, penalty: 15, rates: { land: 0.35, poll: 0.42, tariff: 0.22, salt: 0.3 } },
  oppressive: { label: '苛税', rate: 0.55, penalty: 28, rates: { land: 0.45, poll: 0.55, tariff: 0.3, salt: 0.4 } },
};

export const TAX_LEVELS: TaxLevel[] = ['light', 'medium', 'heavy', 'oppressive'];

/** 人均年收入（₭/人/年）≈ 1780 年代水平 */
export const PER_CAPITA_INCOME = 3.0;
/** 人均年粮食消耗（吨/人/年）→ 每万人 0.09 万吨/年 */
export const GRAIN_PER_WAN_PERSON = 0.09;
/** 每陆地格基础年产粮（万吨/年，× 省份 grainMod） */
export const CELL_GRAIN_BASE = 0.9;
/** 每格土地年价值（万₭/格/年，× 产出修正） */
export const LAND_VALUE_PER_CELL = 2.4;
/** 人均盐税基数（₭/人/年） */
export const SALT_BASE = 0.25;
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

/** 农奴制效率惩罚（未废奴且存在奴隶 → 产出 ×0.9） */
export const SERFDOM_PENALTY = 0.9;

/** 月度账本（结算后写入 nation.monthly，UI 与守恒断言读取） */
export interface MonthlyLedger {
  income: number;
  spending: number;
  pollTax: number;
  landTax: number;
  saltTax: number;
  tariff: number;
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
}

export function zeroLedger(): MonthlyLedger {
  return {
    income: 0, spending: 0, pollTax: 0, landTax: 0, saltTax: 0, tariff: 0,
    exportValue: 0, importValue: 0, tradeBalance: 0,
    foodProd: 0, foodConsumed: 0, foodSurplus: 0, growthRate: 0,
    investIncome: 0, investReturn: 0, investCost: 0, investRefund: 0,
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

/** 月度经济全循环（只结算玩家国家；无随机，确定性） */
export function settleEconomyMonth(state: GameState, map: GameMap): void {
  const id = state.playerNation;
  const n = state.nations[id];
  const def = NATIONS[id];
  const tax = TAX_RATES[n.taxLevel];
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
      if (pop.job === 'farmer') {
        const o = farmerOutput(prov, pop.size, eff);
        for (const g of GOODS) out[g] += o[g];
      } else if (pop.job === 'miner') {
        const o = minerOutput(prov, pop.size, eff);
        for (const g of GOODS) out[g] += o[g];
      } else if (pop.job === 'artisan') {
        out.clothing += pop.size * JOB_OUTPUT_PER_WAN.artisan * eff;
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
    // 需求（阶级消费倍率；渔获为粮食替代）
    const d = zeroGoods();
    for (const pop of ps.pops) {
      const cons = classDef(pop.class).consumptionMult;
      d.food += pop.size * NEED_PER_WAN.food * cons;
      d.clothing += pop.size * NEED_PER_WAN.clothing * cons;
      d.coal += pop.size * NEED_PER_WAN.coal * cons;
      d.fish += pop.size * NEED_PER_WAN.fish * cons;
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
  govDemand.weapons = n.spending.military * 0.003;
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

  // ---- 5. 建筑进度与运营（v0.3 产业链） ----
  const factorySupply = zeroGoods();
  const buildingDemand = zeroGoods();
  const buildingConsumed = zeroGoods();
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
  // 已投产（含上月投产）的建筑：技能要求 → 预扣输入 → 产出进国家市场供给
  for (const p of n.projects) {
    if (p.status !== 'active' || newlyCompleted.has(p.id)) continue;
    const def = BUILDING_DEFS[p.kind];
    const ps = state.provinces[p.provId];
    let skillPop = 0;
    if (ps) for (const pop of ps.pops) if (pop.job === def.skill) skillPop += pop.size;
    const skillFactor = clamp(skillPop / buildingSkillReqPop(def), 0, 1);
    // 输入可用性：按当前库存（建筑按项目 id 序确定性占用）
    let avail = 1;
    const inputGoods = Object.keys(def.inputs) as GoodId[];
    for (const g of inputGoods) {
      const need = (def.inputs[g] ?? 0) * skillFactor;
      if (need > 0) {
        const have = Math.max(0, n.stocks[g] ?? 0);
        avail = Math.min(avail, have / need);
      }
    }
    avail = clamp(avail, 0, 1);
    // 预扣输入（从国家库存；守恒 = 生产+进口 = 消费+出口+Δ库存+建筑消耗）
    const inputUsed = {} as Record<GoodId, number>;
    for (const g of inputGoods) {
      const need = (def.inputs[g] ?? 0) * skillFactor;
      const used = need * avail;
      if (used > 0) {
        n.stocks[g] -= used;
        inputUsed[g] = used;
        buildingConsumed[g] += used;
        buildingDemand[g] += need; // 价格信号用「期望输入」
      }
    }
    const output = def.capacity * skillFactor * avail;
    factorySupply[def.output] += output;
    p.lastSkillFactor = skillFactor;
    p.lastRunFactor = avail;
    p.lastOutput = output;
    p.lastInputUsed = inputUsed;
    p.lastInputCost = 0;
    p.lastRevenue = 0;
  }

  // ---- 6. 三级市场 + 国际贸易（建筑输入参与价格形成与未满足修正） ----
  const marketState: MarketState = {
    national: n.market,
    province: n.provinceMarkets,
    county: n.countyMarkets,
  };
  const snap = settleMarket(
    {
      counties,
      factorySupply,
      govDemand,
      buildingDemand,
      buildingConsumed,
      stocks: n.stocks,
      routeCoef: routeCoef(n),
      tariffRate: tax.rates.tariff,
      crossFreight,
      natFreight: avgFreight,
    },
    marketState,
  );
  n.foodStock = n.stocks.food; // 镜像到 v0.0.0 字段

  // ---- 7. 建筑现金：产出 × 结算后市价 − 输入 × 结算后市价 − 运营成本（闲置维护费） ----
  let investReturn = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && !newlyCompleted.has(p.id)) {
      const def = BUILDING_DEFS[p.kind];
      p.lastRevenue = p.lastOutput * n.market[def.output].price;
      let inputCost = 0;
      for (const g of Object.keys(p.lastInputUsed) as GoodId[]) {
        inputCost += (p.lastInputUsed[g] ?? 0) * n.market[g].price;
      }
      p.lastInputCost = inputCost;
      const idleScale = 0.3 + 0.7 * p.lastRunFactor * p.lastSkillFactor;
      investReturn += p.lastRevenue - inputCost - def.opCost * idleScale;
    }
  }

  // ---- 8. 劳动力市场：工资 ----
  const supply: Record<JobId, number> = { farmer: 0, miner: 0, artisan: 0, engineer: 0 };
  const demand: Record<JobId, number> = { farmer: 0, miner: 0, artisan: 0, engineer: 0 };
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    for (const pop of ps.pops) supply[pop.job] += pop.size;
    for (const job of JOBS) demand[job] += prov.cellIds.length * LABOR_DEMAND_PER_CELL[job];
  }
  const wages = computeWages(supply, demand);

  // ---- 9. POP 投资收入：上层阶级（1-4）按国家财富占比分得资本回报池 ----
  // 池 = 贸易顺差一部分 + 建筑工业利润一部分（万₭/月）
  const tradeSurplus = Math.max(0, snap.exportValue - snap.importValue);
  let buildingProfit = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && !newlyCompleted.has(p.id)) {
      buildingProfit += Math.max(0, p.lastRevenue - p.lastInputCost);
    }
  }
  const capitalPool = tradeSurplus * CAPITAL_POOL_TRADE + buildingProfit * CAPITAL_POOL_INDUSTRY;
  let eliteWealth = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      eliteWealth += pop.size * classDef(pop.class).wealthCoef;
    }
  }
  const perUnit = eliteWealth > 1e-9 ? capitalPool / eliteWealth : 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      const wc = classDef(pop.class).wealthCoef;
      pop.investIncome = wc > 0 ? pop.size * wc * perUnit : 0;
    }
  }

  // ---- 10. 幸福度 & 效率（按省：三级市场消费/需求；阶级基础幸福/税负/政策修正；奴隶恒低） ----
  const taxBurdenBase =
    tax.penalty * 0.6 +
    tax.rates.poll * 100 * 0.1 +
    tax.rates.salt * 100 * 0.04;
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
    let hSum = 0;
    for (const pop of ps.pops) {
      pop.wage = wages[pop.job];
      // 收入 = 工资（劳动） + 投资收入（上层；年化计入）
      const effWage = pop.wage + (pop.investIncome * 12) / Math.max(pop.size, 1e-9);
      const wageFactor = effWage / BASE_WAGE[pop.job];
      const needsSat = 0.35 * satFood + 0.2 * satCloth + 0.15 * satFuel + 0.3 * housingSat;
      pop.sat = { food: satFood, clothing: satCloth, housing: housingSat, fuel: satFuel };
      // 苛税打在下层：税负 × 阶级系数（上层低/下层高；累进税改写）
      const taxBurden = taxBurdenBase * classTaxCoef(pop.class, n.policies.progressiveTax);
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
  const policyCoef = POLICY_GROWTH[n.taxLevel];
  const annualGrowth = foodSurplusRatio * peaceCoef * policyCoef * 0.045;
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const local = 0.5 + ps.happiness / 100;
    const grow = (annualGrowth * local) / 12;
    for (const pop of ps.pops) pop.size = Math.max(0, pop.size * (1 + grow));
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
  }
  // 迁移：超容量 → 池；按省 id 序填充空缺；剩余 = 流亡流失
  let pool = 0;
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    if (ps.popTotal > ps.housingCap) {
      const excess = ps.popTotal - ps.housingCap;
      const ratio = ps.housingCap / Math.max(ps.popTotal, 1e-9);
      for (const pop of ps.pops) pop.size *= ratio;
      ps.popTotal = ps.housingCap;
      pool += excess;
    }
  }
  for (const pid of provIds) {
    if (pool <= 0) break;
    const ps = state.provinces[pid];
    const free = ps.housingCap - ps.popTotal;
    if (free > 0) {
      const take = Math.min(free, pool);
      const addRatio = 1 + take / Math.max(ps.popTotal, 1e-9);
      for (const pop of ps.pops) pop.size *= addRatio;
      ps.popTotal += take;
      pool -= take;
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

  // ---- 13. 财政（含建筑现金流；投资成本/退款已在操作发生时入账；阶级税负） ----
  let pollTax = 0;
  let saltTax = 0;
  let landOwnerW = 0;
  let landPopTotal = 0;
  let landValue = 0;
  for (const pid of provIds) {
    const prov = map.provinceById.get(pid);
    if (prov) landValue += prov.cellIds.length * LAND_VALUE_PER_CELL * prov.productivity;
    for (const pop of state.provinces[pid].pops) {
      const tc = classTaxCoef(pop.class, n.policies.progressiveTax);
      pollTax += (pop.size * PER_CAPITA_INCOME * tax.rates.poll * tc) / 12;
      saltTax += (pop.size * SALT_BASE * tax.rates.salt * tc) / 12;
      landOwnerW += pop.size * classDef(pop.class).landCoef;
      landPopTotal += pop.size;
    }
  }
  const landOwnerFactor = landPopTotal > 1e-9 ? landOwnerW / landPopTotal : 1;
  const landTax = (landValue * tax.rates.land * landOwnerFactor) / 12;
  const tariff = snap.tariff;
  const income = pollTax + landTax + saltTax + tariff;
  const spending = n.spending.military + n.spending.admin + n.spending.infra + n.spending.court + n.spending.health;

  const investCost = n.investCostAcc;
  const investRefund = n.investRefundAcc;
  n.investCostAcc = 0;
  n.investRefundAcc = 0;

  // 投资成本/退款已在 startInvestment/cancelInvestment 操作发生时入账，此处只记账不重复入账
  n.treasury += income - spending + investReturn;
  n.monthly = {
    income,
    spending,
    pollTax,
    landTax,
    saltTax,
    tariff,
    exportValue: snap.exportValue,
    importValue: snap.importValue,
    tradeBalance: snap.exportValue - snap.importValue,
    foodProd: prodAgg.food,
    foodConsumed,
    foodSurplus: foodSurplusRatio,
    growthRate: annualGrowth,
    investIncome: capitalPool,
    investReturn,
    investCost,
    investRefund,
  };

  // ---- 14. 识字率 & 健康（教育/卫生支出） ----
  const adminRatio = n.spending.admin / Math.max(1, def.sliderMax);
  const healthRatio = n.spending.health / Math.max(1, def.sliderMax);
  n.literacy = clamp(0, 1, n.literacy + (0.003 + 0.005 * adminRatio) / 12);
  n.health = clamp(0, 1, n.health + (0.002 + 0.004 * healthRatio) / 12);

  // ---- 15. 稳定度漂移（税率 + 缺粮 + 低幸福度 + 下层动乱） ----
  const satFoodNat = n.market.food.demand > 0 ? clamp(n.market.food.consumed / n.market.food.demand, 0, 1) : 1;
  const foodPenalty = (1 - satFoodNat) * 25;
  const happPenalty = Math.max(0, (55 - avgHappiness) * 0.25);
  const unrestPenalty = n.unrest * 10;
  const target = clamp(15, 100, 72 - tax.penalty - foodPenalty - happPenalty - unrestPenalty);
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
