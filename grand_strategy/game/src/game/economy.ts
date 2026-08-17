/**
 * 财政与经济全循环（v0.2）：
 *  - 税种：土地/人头/关税/盐税 × 税率档 → 国库
 *  - 支出：军/行政/基建/宫廷/卫生 滑杆 → 行政提识字率、卫生提健康、基建提产能与降运费
 *  - 三级市场：本地（县）→ 区域（省）→ 国家 + 国际贸易；奢侈品（工匠/工程师生产，高收入消费）
 *  - 投资回报：精英/富裕 POP 投资收入（全国资本回报池按财富占比分配）；玩家投资项目（建造成本+工期→月度回报）
 *  - 月度结算顺序（确定性，无随机）：
 *    基建演化 → 物流运费 → 生产/消费（含奢侈品）→ 工厂进度 → 三级市场+贸易
 *    → 工资 → POP 投资收入 → 幸福度/效率 → 人口增长+迁移 → 财政（含投资现金流）→ 识字率/健康 → 稳定度
 */
import type { GameMap } from './map';
import type { GameState, NationState } from './state';
import { addChronicle } from './state';
import type { GoodId, JobId, NationId, TaxLevel } from './types';
import { NATIONS } from './nations';
import {
  BASE_HOUSING_PER_CELL,
  BASE_WAGE,
  GOODS,
  INITIAL_JOB_MIX,
  JOBS,
  JOB_GOOD,
  JOB_OUTPUT_PER_WAN,
  LUXURY_NEED_BASE,
  LUXURY_OUTPUT_PER_WAN,
  NEED_PER_WAN,
  POLICY_GROWTH,
  RETRAIN_OUTPUT_PENALTY,
  WEALTH_BASE,
  clamp,
  luxuryWealthCoef,
  provinceLuxuryPotential,
} from './pops';
import { LABOR_DEMAND_PER_CELL, computeWages } from './labor';
import { settleMarket } from './market';
import type { CountyFlow, MarketState } from './market';
import { countyFreightFactor, provinceFreightFactor } from './logistics';
import { PROJECT_DEFS } from './investment';

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

/** 全国资本回报池系数（v0.2 POP 投资收入） */
export const CAPITAL_POOL_TRADE = 0.4; // 贸易顺差计入比例
export const CAPITAL_POOL_INDUSTRY = 0.25; // 工业产值利润率

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
  /** 玩家投资回报（工厂月度回报，万₭/月，可为负=亏损） */
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

  // ---- 3. 生产与消费（逐省，含奢侈品） ----
  const prodAgg: Record<GoodId, number> = { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 };
  const consAgg: Record<GoodId, number> = { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 };
  const wealthCoef = luxuryWealthCoef(n);
  for (const pid of provIds) {
    const ps = state.provinces[pid];
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    const luxPot = provinceLuxuryPotential(prov);
    for (const g of GOODS) ps.output[g] = 0;
    let luxDemand = 0;
    for (const pop of ps.pops) {
      const good = JOB_GOOD[pop.job];
      const provMod = good === 'food' ? prov.grainMod : good === 'industrial' ? prov.productivity : 1;
      const retrainMult = pop.retrainMonths > 0 ? RETRAIN_OUTPUT_PENALTY : 1;
      const out = pop.size * JOB_OUTPUT_PER_WAN[pop.job] * provMod * ps.efficiency * infraCap * retrainMult;
      ps.output[good] += out;
      prodAgg[good] += out;
      // 奢侈品：工匠/工程师附加产出（× 省奢侈品潜力）
      const luxOut = pop.size * LUXURY_OUTPUT_PER_WAN[pop.job] * luxPot * ps.efficiency * infraCap * retrainMult;
      ps.output.luxury += luxOut;
      prodAgg.luxury += luxOut;
      // 奢侈品需求：高收入 POP（职业财富 × 幸福度系数 × 国家财富系数）
      const wf = WEALTH_BASE[pop.job];
      if (wf > 0) {
        luxDemand += pop.size * wf * (0.35 + 0.65 * (pop.happiness / 100));
      }
    }
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
    ps.demand = {
      food: ps.popTotal * NEED_PER_WAN.food,
      clothing: ps.popTotal * NEED_PER_WAN.clothing,
      fuel: ps.popTotal * NEED_PER_WAN.fuel,
      industrial: 0,
      luxury: luxDemand * LUXURY_NEED_BASE * wealthCoef,
    };
    for (const g of GOODS) consAgg[g] += ps.demand[g];
    ps.housingCap = prov.cellIds.length * BASE_HOUSING_PER_CELL * (1 + (n.infra.roads + n.infra.ports) * 0.006);
  }
  // 政府需求：军费耗工业品、基建耗钢、行政耗衣物（微量）
  const govDemand: Record<GoodId, number> = {
    food: 0,
    clothing: n.spending.admin * 0.004,
    fuel: 0,
    industrial: n.spending.military * 0.006 + n.spending.infra * 0.01,
    luxury: 0,
  };

  // ---- 4. 三级市场输入：县流量（按格数分摊省产/省需） ----
  const counties: CountyFlow[] = [];
  for (const pid of provIds) {
    const prov = map.provinceById.get(pid);
    const ps = state.provinces[pid];
    if (!prov || !ps) continue;
    const provCells = Math.max(1, prov.cellIds.length);
    for (const county of prov.counties) {
      const share = county.cellIds.length / provCells;
      counties.push({
        countyId: county.id,
        provId: pid,
        production: {
          food: ps.output.food * share,
          clothing: ps.output.clothing * share,
          fuel: ps.output.fuel * share,
          industrial: ps.output.industrial * share,
          luxury: ps.output.luxury * share,
        },
        demand: {
          food: ps.demand.food * share,
          clothing: ps.demand.clothing * share,
          fuel: ps.demand.fuel * share,
          industrial: ps.demand.industrial * share,
          luxury: ps.demand.luxury * share,
        },
        intraFreight: countyFreightFactor(map, county, prov, n.infra),
      });
    }
  }

  // ---- 5. 工厂进度与供给（v0.2 投资） ----
  const factorySupply: Record<GoodId, number> = { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 };
  const newlyCompleted = new Set<number>();
  for (const p of n.projects) {
    if (p.status === 'building') {
      p.monthsLeft -= 1;
      if (p.monthsLeft <= 0) {
        p.status = 'active';
        p.monthsLeft = 0;
        newlyCompleted.add(p.id);
        const prov = map.provinceById.get(p.provId);
        addChronicle(state, `「${PROJECT_DEFS[p.kind].label}」落成`, prov ? `行省 #${p.provId + 1} · ${prov.counties.length} 县` : `行省 #${p.provId + 1}`);
      }
    }
  }
  // 已投产（含上月投产）的工厂进入国家市场供给
  for (const p of n.projects) {
    if (p.status === 'active' && !newlyCompleted.has(p.id)) {
      factorySupply[PROJECT_DEFS[p.kind].good] += PROJECT_DEFS[p.kind].capacity;
    }
  }

  // ---- 6. 三级市场 + 国际贸易 ----
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
      stocks: n.stocks,
      routeCoef: routeCoef(n),
      tariffRate: tax.rates.tariff,
      crossFreight,
      natFreight: avgFreight,
    },
    marketState,
  );
  n.foodStock = n.stocks.food; // 镜像到 v0.0.0 字段

  // ---- 7. 劳动力市场：工资 ----
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

  // ---- 8. POP 投资收入：精英/富裕 POP 按国家财富占比分得资本回报池 ----
  // 池 = 贸易顺差一部分 + 工业利润一部分（万₭/月）
  const tradeSurplus = Math.max(0, snap.exportValue - snap.importValue);
  const industrialProfit = prodAgg.industrial * n.market.industrial.price * CAPITAL_POOL_INDUSTRY;
  const capitalPool = tradeSurplus * CAPITAL_POOL_TRADE + industrialProfit;
  let eliteWealth = 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      if (pop.job === 'artisan' || pop.job === 'engineer') {
        eliteWealth += pop.size * WEALTH_BASE[pop.job];
      }
    }
  }
  const perUnit = eliteWealth > 1e-9 ? capitalPool / eliteWealth : 0;
  for (const pid of provIds) {
    for (const pop of state.provinces[pid].pops) {
      if (pop.job === 'artisan' || pop.job === 'engineer') {
        pop.investIncome = pop.size * WEALTH_BASE[pop.job] * perUnit;
      } else {
        pop.investIncome = 0;
      }
    }
  }

  // ---- 9. 幸福度 & 效率（按省：三级市场消费/需求） ----
  const taxBurden =
    tax.penalty * 0.6 +
    tax.rates.poll * 100 * 0.1 +
    tax.rates.land * 100 * 0.05 +
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
    const satFood = satOf('food');
    const satCloth = satOf('clothing');
    const satFuel = satOf('fuel');
    const housingSat = clamp(ps.housingCap / Math.max(ps.popTotal, 1e-9), 0, 1);
    let hSum = 0;
    for (const pop of ps.pops) {
      pop.wage = wages[pop.job];
      // 收入 = 工资（劳动） + 投资收入（精英；年化计入）
      const effWage = pop.wage + (pop.investIncome * 12) / Math.max(pop.size, 1e-9);
      const wageFactor = effWage / BASE_WAGE[pop.job];
      const needsSat = 0.35 * satFood + 0.2 * satCloth + 0.15 * satFuel + 0.3 * housingSat;
      pop.sat = { food: satFood, clothing: satCloth, housing: housingSat, fuel: satFuel };
      const happiness = clamp(
        0, 100,
        64 + 55 * (needsSat - 0.85) + 12 * (wageFactor - 1) - taxBurden - freightPenalty + (n.stability - 70) * 0.15,
      );
      pop.happiness = happiness;
      hSum += happiness * pop.size;
    }
    ps.happiness = ps.popTotal > 0 ? hSum / ps.popTotal : 50;
    ps.efficiency = 0.5 + 0.7 * (ps.happiness / 100);
    happSum += ps.happiness;
  }
  const avgHappiness = provIds.length > 0 ? happSum / provIds.length : 50;

  // ---- 10. 人口增长（粮食盈余 × 和平系数 × 政策系数） + 迁移/住房上限 ----
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

  // ---- 11. 财政（含投资现金流；投资成本/退款已在操作发生时入账） ----
  const pollTax = (n.popWan * PER_CAPITA_INCOME * tax.rates.poll) / 12;
  const landValue = provIds.reduce((s, pid) => {
    const prov = map.provinceById.get(pid);
    return s + (prov ? prov.cellIds.length * LAND_VALUE_PER_CELL * prov.productivity : 0);
  }, 0);
  const landTax = (landValue * tax.rates.land) / 12;
  const saltTax = (n.popWan * SALT_BASE * tax.rates.salt) / 12;
  const tariff = snap.tariff;
  const income = pollTax + landTax + saltTax + tariff;
  const spending = n.spending.military + n.spending.admin + n.spending.infra + n.spending.court + n.spending.health;

  // 工厂月度回报 = 产能 × (国家市场价 - 单位运营成本)，随市价波动（低市价 → 亏损）
  let investReturn = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && !newlyCompleted.has(p.id)) {
      const d = PROJECT_DEFS[p.kind];
      investReturn += d.capacity * (n.market[d.good].price - d.opCost);
    }
  }
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

  // ---- 12. 识字率 & 健康（教育/卫生支出） ----
  const adminRatio = n.spending.admin / Math.max(1, def.sliderMax);
  const healthRatio = n.spending.health / Math.max(1, def.sliderMax);
  n.literacy = clamp(0, 1, n.literacy + (0.003 + 0.005 * adminRatio) / 12);
  n.health = clamp(0, 1, n.health + (0.002 + 0.004 * healthRatio) / 12);

  // ---- 13. 稳定度漂移（税率 + 缺粮 + 低幸福度） ----
  const satFoodNat = n.market.food.demand > 0 ? clamp(n.market.food.consumed / n.market.food.demand, 0, 1) : 1;
  const foodPenalty = (1 - satFoodNat) * 25;
  const happPenalty = Math.max(0, (55 - avgHappiness) * 0.25);
  const target = clamp(15, 100, 72 - tax.penalty - foodPenalty - happPenalty);
  n.stability += (target - n.stability) * 0.05;
  n.stability = clamp(0, 100, n.stability);
}

/** 初始职业构成（导出供 UI/存档校验） */
export const INITIAL_JOBS = INITIAL_JOB_MIX;
