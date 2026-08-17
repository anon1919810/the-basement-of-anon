/**
 * 游戏状态机（v0.2）：新游戏 / 日 tick / 月度结算（经济全循环：三级市场 + 奢侈品 + 投资回报）。
 * 纯逻辑、无 DOM 依赖，浏览器 UI 与无头模拟（scripts/sim.ts）共用。
 * 确定性：v0.2 移除自动事件后，月度结算完全无随机（纯函数式演化）；
 * 仅玩家操作（sim 中的随机策略 / UI 的政令）经 game.rngState 恢复的 Rng（mulberry32）。
 */
import { Rng } from './rng';
import type { GameMap } from './map';
import type { GoodId, NationId, ProvinceOwner, Speed, TaxLevel } from './types';
import { DAYS_PER_MONTH, monthIndex } from './clock';
import { NATIONS } from './nations';
import {
  BANKRUPTCY_COOLDOWN,
  BANKRUPTCY_THRESHOLD,
  settleEconomyMonth,
  zeroLedger,
} from './economy';
import type { MonthlyLedger } from './economy';
import { initProvinceEcon } from './pops';
import type { Pop } from './pops';
import { newMarket } from './market';
import type { CountyMarket, MarketGood, ProvinceMarket } from './market';
import type { InvestmentProject } from './investment';
import { MANUAL_EVENTS } from './manualEvents';

export const SAVE_VERSION = 3;
export const SAVE_KEY = 'kalt-save-v3';

export interface NationState {
  popWan: number; // 人口（万人）
  literacy: number; // 识字率 0-1
  health: number; // 健康水平 0-1（人口质量）
  treasury: number; // 国库（万₭）
  foodStock: number; // 粮食储备（万吨，== stocks.food 镜像）
  stability: number; // 稳定度 0-100
  taxLevel: TaxLevel;
  spending: { military: number; admin: number; infra: number; court: number; health: number }; // 万₭/月
  cells: number; // 所辖陆地格数（静态）
  // ---- 三级市场（v0.2） ----
  stocks: Record<GoodId, number>; // 国家市场库存（单位）
  market: Record<GoodId, MarketGood>; // 国家市场状态（价格/供需/趋势）
  provinceMarkets: Record<number, Record<GoodId, ProvinceMarket>>; // 区域市场（省）
  countyMarkets: Record<number, Record<GoodId, CountyMarket>>; // 本地市场（县）
  // ---- 投资（v0.2） ----
  projects: InvestmentProject[]; // 在建/已投产项目
  nextProjectId: number;
  investCostAcc: number; // 本月投资支出累计（结算时并入账本并清零）
  investRefundAcc: number; // 本月取消退款累计
  infra: { roads: number; ports: number }; // 基建水平 0-100
  emigration: number; // 上月流亡人口（万人）
  monthly: MonthlyLedger; // 上月账本（UI/断言）
  bankruptMonths: number; // 破产冷却（月）
}

export interface ProvinceState {
  owner: ProvinceOwner;
  // ---- v0.1 省经济 ----
  pops: Pop[];
  popTotal: number; // 万人
  housingCap: number; // 万人
  efficiency: number; // 0.5-1.2
  happiness: number; // 0-100
  output: Record<GoodId, number>;
  demand: Record<GoodId, number>;
  freight: number; // 运费系数
}

/** 大事记条目（v0.2：被动信息，非交互事件） */
export interface ChronicleEntry {
  month: number;
  day: number;
  title: string;
  detail?: string;
}

export interface GameState {
  version: number;
  seed: number;
  day: number;
  speed: Speed;
  prevSpeed: Speed;
  playerNation: NationId;
  rngState: number;
  nations: Record<NationId, NationState>;
  provinces: Record<number, ProvinceState>;
  chronicle: ChronicleEntry[];
  lastAutosaveMonth: number;
}

/** 追加一条大事记（破产/工厂落成等被动信息） */
export function addChronicle(state: GameState, title: string, detail?: string): void {
  state.chronicle.push({ month: monthIndex(state.day), day: state.day, title, detail });
  if (state.chronicle.length > 500) state.chronicle.splice(0, state.chronicle.length - 500);
}

function nationCellCount(map: GameMap, id: NationId): number {
  let n = 0;
  for (const p of map.provinces) {
    if (p.owner === id && !p.isUndiscovered) n += p.cellIds.length;
  }
  return n;
}

export function newGameState(playerNation: NationId, seed: number, map: GameMap): GameState {
  const rng = new Rng(seed);
  const nations = {} as Record<NationId, NationState>;
  (Object.keys(NATIONS) as NationId[]).forEach((id) => {
    const def = NATIONS[id];
    const consYear = def.popWan * 0.09;
    const market = newMarket();
    const stocks: Record<GoodId, number> = {
      food: (consYear / 12) * def.foodMonths,
      clothing: def.popWan * 0.006 * def.foodMonths,
      fuel: def.popWan * 0.005 * def.foodMonths,
      industrial: def.popWan * 0.0005 * def.foodMonths,
      luxury: def.popWan * 0.0004 * def.foodMonths,
    };
    nations[id] = {
      popWan: def.popWan,
      literacy: def.literacy,
      health: 0.6,
      treasury: def.treasury,
      foodStock: stocks.food,
      stability: def.stability,
      taxLevel: 'medium',
      spending: { ...def.defaultSpending, court: 15, health: 10 },
      cells: nationCellCount(map, id),
      stocks,
      market,
      provinceMarkets: {},
      countyMarkets: {},
      projects: [],
      nextProjectId: 1,
      investCostAcc: 0,
      investRefundAcc: 0,
      infra: { roads: 10, ports: 10 },
      emigration: 0,
      monthly: zeroLedger(),
      bankruptMonths: 0,
    };
  });

  const provinces: Record<number, ProvinceState> = {};
  for (const p of map.provinces) {
    const owner = p.owner;
    if (owner !== 'undiscovered') {
      const def = NATIONS[owner];
      const econ = initProvinceEcon(p, owner, def.popWan, nations[owner].cells, def.stability);
      provinces[p.id] = { owner, ...econ };
    } else {
      provinces[p.id] = {
        owner,
        pops: [],
        popTotal: 0,
        housingCap: 0,
        efficiency: 1,
        happiness: 50,
        output: { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 },
        demand: { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 },
        freight: 1,
      };
    }
  }

  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    day: 0,
    speed: 3,
    prevSpeed: 3,
    playerNation,
    rngState: rng.state,
    nations,
    provinces,
    chronicle: [],
    lastAutosaveMonth: 0,
  };
  state.rngState = rng.state;
  return state;
}

function makeRng(state: GameState): Rng {
  return new Rng(state.rngState);
}

function commitRng(state: GameState, rng: Rng): void {
  state.rngState = rng.state;
}

/** 月度结算（仅玩家国家；他国为静态背景） */
export function settleMonth(state: GameState, map: GameMap): void {
  const rng = makeRng(state);
  const id = state.playerNation;
  const n = state.nations[id];

  // 1) 经济全循环（三级市场/奢侈品/投资回报/财政/识字率/稳定度）——纯函数式，无随机
  settleEconomyMonth(state, map);

  // 2) 破产保护：国库允许为负，但记入大事记（带冷却，避免刷屏）
  if (n.treasury < BANKRUPTCY_THRESHOLD && n.bankruptMonths <= 0) {
    addChronicle(state, '国库破产', `国库跌破 ${BANKRUPTCY_THRESHOLD} 万₭，朝野震动，需设法扭转财政`);
    n.stability = Math.max(0, n.stability - 6);
    n.bankruptMonths = BANKRUPTCY_COOLDOWN;
  }
  if (n.bankruptMonths > 0) n.bankruptMonths--;

  // 3) 人工事件预留（v0.2 休眠检查点）：MANUAL_EVENTS 为空 → no-op。
  //    日后在 manualEvents.ts 填入事件后，此处在每月结算时按 triggerMonth 派发。
  const mi = monthIndex(state.day);
  for (const ev of MANUAL_EVENTS) {
    if (ev.triggerMonth >= 0 && ev.triggerMonth === mi) {
      // 预留：填充后在此将 ev 加入「待处理队列」或直接应用 effect（见 manualEvents.ts 注释）
      addChronicle(state, ev.title, ev.desc);
    }
  }

  commitRng(state, rng);
}

/** 推进一天（月末触发结算） */
export function tickDay(state: GameState, map: GameMap): void {
  state.day += 1;
  if (state.day % DAYS_PER_MONTH === 0) settleMonth(state, map);
}

/** 月度结束时检查所有数值有限（调试/断言用） */
export function allFinite(state: GameState): boolean {
  for (const id of Object.keys(state.nations) as NationId[]) {
    const n = state.nations[id];
    const nums: number[] = [
      n.popWan, n.literacy, n.health, n.treasury, n.foodStock, n.stability,
      n.emigration, n.infra.roads, n.infra.ports,
      n.monthly.income, n.monthly.spending, n.monthly.tariff,
      n.monthly.investIncome, n.monthly.investReturn, n.monthly.investCost, n.monthly.investRefund,
      n.investCostAcc, n.investRefundAcc,
    ];
    for (const v of nums) if (!Number.isFinite(v)) return false;
    for (const g of Object.keys(n.stocks) as GoodId[]) {
      if (!Number.isFinite(n.stocks[g])) return false;
      const m = n.market[g];
      for (const v of [m.price, m.prevPrice, m.supply, m.demand, m.consumed, m.exported, m.imported, m.unmet, m.trend]) {
        if (!Number.isFinite(v)) return false;
      }
    }
    // 区域市场（省）
    for (const pid of Object.keys(n.provinceMarkets)) {
      const pm = n.provinceMarkets[Number(pid)];
      if (!pm) return false;
      for (const g of Object.keys(pm) as GoodId[]) {
        const m = pm[g];
        for (const v of [m.price, m.prevPrice, m.supply, m.demand, m.consumed, m.unmet, m.netFlow, m.trend]) {
          if (!Number.isFinite(v)) return false;
        }
      }
    }
    // 本地市场（县）
    for (const cid of Object.keys(n.countyMarkets)) {
      const cm = n.countyMarkets[Number(cid)];
      if (!cm) return false;
      for (const g of Object.keys(cm) as GoodId[]) {
        const m = cm[g];
        for (const v of [m.price, m.prevPrice, m.supply, m.demand, m.consumed, m.unmet, m.netFlow, m.trend]) {
          if (!Number.isFinite(v)) return false;
        }
      }
    }
    // 投资项目
    for (const p of n.projects) {
      if (!Number.isFinite(p.totalCost) || !Number.isFinite(p.duration) || !Number.isFinite(p.monthsLeft)) return false;
      if (p.monthsLeft < 0 || p.monthsLeft > p.duration) return false;
    }
  }
  for (const p of Object.values(state.provinces)) {
    if (!Number.isFinite(p.popTotal) || !Number.isFinite(p.housingCap) || !Number.isFinite(p.efficiency) || !Number.isFinite(p.happiness)) {
      return false;
    }
    for (const pop of p.pops) {
      if (!Number.isFinite(pop.size) || !Number.isFinite(pop.happiness) || !Number.isFinite(pop.wage) || !Number.isFinite(pop.investIncome)) return false;
      if (pop.size < 0) return false;
    }
  }
  return true;
}

// ---- 存档（localStorage；无 DOM 环境自动跳过） ----
export function saveGame(state: GameState): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): GameState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const text = localStorage.getItem(SAVE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as GameState;
    if (
      parsed &&
      parsed.version === SAVE_VERSION &&
      typeof parsed.day === 'number' &&
      parsed.nations &&
      parsed.nations.lorraine
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // 忽略
  }
}
