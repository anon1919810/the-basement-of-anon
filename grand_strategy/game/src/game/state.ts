/**
 * 游戏状态机（v0.1）：新游戏 / 日 tick / 月度结算（经济全循环）/ 事件生成与处理 / 存档。
 * 纯逻辑、无 DOM 依赖，浏览器 UI 与无头模拟（scripts/sim.ts）共用。
 * 确定性：所有随机均来自 game.rngState 恢复的 Rng（mulberry32）；
 * 经济结算本身无随机（纯函数式演化），仅事件/起义/政策扰动经 Rng。
 */
import { Rng } from './rng';
import type { GameMap } from './map';
import type { EventInstance, EventTemplate } from './events';
import { EVENT_TEMPLATES, templateById } from './events';
import type { GoodId, NationId, ProvinceOwner, Speed, TaxLevel } from './types';
import { DAYS_PER_MONTH, monthIndex } from './clock';
import { NATIONS } from './nations';
import {
  BANKRUPTCY_COOLDOWN,
  BANKRUPTCY_THRESHOLD,
  nationGrainConsumption,
  nationMonthlyIncome,
  settleEconomyMonth,
  zeroLedger,
} from './economy';
import type { MonthlyLedger } from './economy';
import { initProvinceEcon } from './pops';
import type { Pop } from './pops';
import { newMarket } from './market';
import type { MarketGood } from './market';

export const SAVE_VERSION = 2;
export const SAVE_KEY = 'kalt-save-v2';

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
  // ---- v0.1 经济 ----
  stocks: Record<GoodId, number>; // 国家市场库存（单位）
  market: Record<GoodId, MarketGood>; // 国家市场状态（价格/供需/趋势）
  infra: { roads: number; ports: number }; // 基建水平 0-100
  emigration: number; // 上月流亡人口（万人）
  monthly: MonthlyLedger; // 上月账本（UI/断言）
  bankruptMonths: number; // 破产事件冷却（月）
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

export interface LogEntry {
  month: number;
  day: number;
  title: string;
  choice: string;
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
  eventQueue: EventInstance[];
  eventLog: LogEntry[];
  nextEventMonth: number; // 计划事件触发月份（0 基）
  uid: number;
  lastAutosaveMonth: number;
  stats: { spawned: number; processed: number };
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
        output: { food: 0, clothing: 0, fuel: 0, industrial: 0 },
        demand: { food: 0, clothing: 0, fuel: 0, industrial: 0 },
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
    eventQueue: [],
    eventLog: [],
    nextEventMonth: 1 + rng.int(0, 3), // 首次事件在 1-3 月内
    uid: 1,
    lastAutosaveMonth: 0,
    stats: { spawned: 0, processed: 0 },
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

/** 生成一条事件并入队（暂停游戏等待抉择；sim 中忽略 speed） */
export function spawnEvent(state: GameState, rng: Rng, templateId?: string): EventInstance {
  let tpl: EventTemplate;
  if (templateId) {
    tpl = templateById(templateId) ?? EVENT_TEMPLATES[0];
  } else {
    tpl = rng.pickWeighted(EVENT_TEMPLATES, (t) => t.weight);
  }
  const ev: EventInstance = {
    uid: state.uid++,
    templateId: tpl.id,
    title: tpl.title,
    text: tpl.text,
    options: tpl.options,
    month: monthIndex(state.day),
  };
  state.eventQueue.push(ev);
  state.stats.spawned++;
  if (state.speed !== 0) {
    state.prevSpeed = state.speed;
    state.speed = 0; // 弹事件卡自动暂停
  }
  return ev;
}

/** 应用选项效果（按国家规模缩放；含 v0.1 的健康/幸福度/商品库存） */
function applyEffects(state: GameState, map: GameMap, effects: {
  treasuryFrac?: number;
  stability?: number;
  popFrac?: number;
  literacy?: number;
  health?: number;
  happiness?: number;
  foodFrac?: number;
  stockFrac?: Partial<Record<GoodId, number>>;
}): void {
  const id = state.playerNation;
  const n = state.nations[id];
  const incomeM = nationMonthlyIncome(map, state, id);
  const consYear = nationGrainConsumption(state, id);
  if (effects.treasuryFrac) n.treasury += effects.treasuryFrac * Math.abs(incomeM);
  if (effects.popFrac) {
    // 移民/瘟疫等：按比例调整玩家国家各省 POP（n.popWan 下次结算时由省份重算）
    const frac = effects.popFrac;
    for (const p of map.provinces) {
      if (p.owner !== id || p.isUndiscovered) continue;
      const ps = state.provinces[p.id];
      if (!ps) continue;
      for (const pop of ps.pops) pop.size = Math.max(0, pop.size * (1 + frac));
    }
  }
  if (effects.literacy) n.literacy = Math.min(1, Math.max(0, n.literacy + effects.literacy));
  if (effects.health) n.health = Math.min(1, Math.max(0, n.health + effects.health));
  if (effects.foodFrac) n.foodStock = Math.max(0, n.foodStock + effects.foodFrac * consYear);
  if (effects.stockFrac) {
    // 各商品库存按比例增减（如开仓平粜 -25% 粮库存）
    for (const g of Object.keys(effects.stockFrac) as GoodId[]) {
      const frac = effects.stockFrac[g];
      if (frac === undefined) continue;
      n.stocks[g] = Math.max(0, n.stocks[g] * (1 + frac));
    }
    n.foodStock = n.stocks.food;
  }
  if (effects.stability) n.stability = Math.min(100, Math.max(0, n.stability + effects.stability));
  if (effects.happiness) {
    for (const p of map.provinces) {
      if (p.owner !== id || p.isUndiscovered) continue;
      const ps = state.provinces[p.id];
      if (!ps) continue;
      for (const pop of ps.pops) {
        pop.happiness = Math.min(100, Math.max(0, pop.happiness + (effects.happiness ?? 0)));
      }
    }
  }
}

/** 处理队首事件（选项由调用方决定：UI 玩家点选 / sim 用 rng 选） */
export function processEvent(state: GameState, map: GameMap, optionIndex: number): void {
  const ev = state.eventQueue.shift();
  if (!ev) return;
  const opt = ev.options[optionIndex] ?? ev.options[0];
  if (opt) applyEffects(state, map, opt.effects);
  state.eventLog.push({ month: ev.month, day: state.day, title: ev.title, choice: opt?.label ?? '' });
  state.stats.processed++;
  if (state.eventQueue.length === 0) state.speed = state.prevSpeed;
}

/** 「稍后处理」：恢复运行，事件留在队列 */
export function deferEvent(state: GameState): void {
  state.speed = state.prevSpeed;
}

/** 月度结算（仅玩家国家；他国为静态背景） */
export function settleMonth(state: GameState, map: GameMap): void {
  const rng = makeRng(state);
  const id = state.playerNation;
  const n = state.nations[id];

  // 1) 经济全循环（生产/市场/贸易/工资/幸福度/人口/财政/识字率/稳定度）
  settleEconomyMonth(state, map);

  // 2) 破产保护：国库允许为负，但触发「破产」事件（带冷却，避免刷屏）
  if (n.treasury < BANKRUPTCY_THRESHOLD && n.bankruptMonths <= 0) {
    spawnEvent(state, rng, 'bankruptcy');
    n.bankruptMonths = BANKRUPTCY_COOLDOWN;
  }
  if (n.bankruptMonths > 0) n.bankruptMonths--;

  // 3) 事件：稳定度低触发起义；计划事件（每 1-3 月）
  if (n.stability < 30 && rng.chance((30 - n.stability) / 150)) {
    spawnEvent(state, rng, 'rebellion');
  }
  if (monthIndex(state.day) >= state.nextEventMonth) {
    spawnEvent(state, rng);
    state.nextEventMonth = monthIndex(state.day) + 1 + rng.int(0, 3); // 1-3 月后
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
    ];
    for (const v of nums) if (!Number.isFinite(v)) return false;
    for (const g of Object.keys(n.stocks) as GoodId[]) {
      if (!Number.isFinite(n.stocks[g])) return false;
      const m = n.market[g];
      for (const v of [m.price, m.prevPrice, m.supply, m.demand, m.consumed, m.exported, m.imported, m.unmet, m.trend]) {
        if (!Number.isFinite(v)) return false;
      }
    }
  }
  for (const p of Object.values(state.provinces)) {
    if (!Number.isFinite(p.popTotal) || !Number.isFinite(p.housingCap) || !Number.isFinite(p.efficiency) || !Number.isFinite(p.happiness)) {
      return false;
    }
    for (const pop of p.pops) {
      if (!Number.isFinite(pop.size) || !Number.isFinite(pop.happiness) || !Number.isFinite(pop.wage)) return false;
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
