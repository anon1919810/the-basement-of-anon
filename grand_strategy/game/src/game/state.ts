/**
 * 游戏状态机：新游戏 / 日 tick / 月度结算 / 事件生成与处理 / 存档。
 * 纯逻辑、无 DOM 依赖，浏览器 UI 与无头模拟（scripts/sim.ts）共用。
 * 确定性：所有随机均来自 game.rngState 恢复的 Rng（mulberry32）。
 */
import { Rng } from './rng';
import type { GameMap } from './map';
import type { EventInstance, EventTemplate } from './events';
import { EVENT_TEMPLATES, templateById } from './events';
import type { NationId, ProvinceOwner, Speed, TaxLevel } from './types';
import { DAYS_PER_MONTH, monthIndex } from './clock';
import { NATIONS } from './nations';
import {
  TAX_RATES,
  nationMonthlyIncome,
  nationMonthlySpending,
  nationMonthlyGrain,
  nationGrainConsumption,
} from './economy';

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'kalt-save-v1';

export interface NationState {
  popWan: number; // 人口（万人）
  literacy: number; // 识字率 0-1
  treasury: number; // 国库（万₭）
  foodStock: number; // 粮食储备（万吨）
  stability: number; // 稳定度 0-100
  taxLevel: TaxLevel;
  spending: { military: number; admin: number; infra: number }; // 万₭/月
  cells: number; // 所辖陆地格数（静态）
}

export interface ProvinceState {
  owner: ProvinceOwner;
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
  /** 调试统计：累计生成/处理事件数 */
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
    nations[id] = {
      popWan: def.popWan,
      literacy: def.literacy,
      treasury: def.treasury,
      foodStock: (consYear / 12) * def.foodMonths,
      stability: def.stability,
      taxLevel: 'medium',
      spending: { ...def.defaultSpending },
      cells: nationCellCount(map, id),
    };
  });
  const provinces: Record<number, ProvinceState> = {};
  for (const p of map.provinces) provinces[p.id] = { owner: p.owner };

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

/** 应用选项效果（按国家规模缩放） */
function applyEffects(state: GameState, map: GameMap, effects: {
  treasuryFrac?: number;
  stability?: number;
  popFrac?: number;
  literacy?: number;
  foodFrac?: number;
}): void {
  const id = state.playerNation;
  const n = state.nations[id];
  const incomeM = nationMonthlyIncome(map, state, id);
  const consYear = nationGrainConsumption(state, id);
  if (effects.treasuryFrac) n.treasury += effects.treasuryFrac * incomeM;
  if (effects.popFrac) n.popWan = Math.max(50, n.popWan * (1 + effects.popFrac));
  if (effects.literacy) n.literacy = Math.min(1, Math.max(0, n.literacy + effects.literacy));
  if (effects.foodFrac) n.foodStock += effects.foodFrac * consYear;
  if (effects.stability) n.stability = Math.min(100, Math.max(0, n.stability + effects.stability));
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
  const def = NATIONS[id];
  const tax = TAX_RATES[n.taxLevel];

  // 1) 财政：税收 - 支出 → 国库
  const incomeM = nationMonthlyIncome(map, state, id);
  const spendM = nationMonthlySpending(state, id);
  n.treasury += incomeM - spendM;

  // 2) 粮食：产出 - 消耗 → 储备；缺粮 → 稳定度下降
  const grainM = nationMonthlyGrain(map, state, id); // 万吨/月（正=盈余）
  const consYear = nationGrainConsumption(state, id);
  n.foodStock += grainM;
  const deficitCap = consYear; // 缺粮最多记一年亏空
  if (n.foodStock < -deficitCap) n.foodStock = -deficitCap;
  const consM = consYear / 12;
  const surplusRatio = grainM / Math.max(consM, 1e-6);

  // 3) 人口：盈余缓慢增长，缺粮缓慢下降
  if (surplusRatio >= 0) {
    n.popWan *= 1 + (0.004 * Math.min(surplusRatio, 1.5)) / 12;
  } else {
    n.popWan *= 1 + (0.006 * Math.max(surplusRatio, -1)) / 12;
  }

  // 4) 稳定度：向目标漂移（税率 + 缺粮惩罚）
  const foodPenalty = n.foodStock < 0 ? Math.min(25, (-n.foodStock / deficitCap) * 25) : 0;
  const target = Math.max(15, 72 - tax.penalty - foodPenalty);
  n.stability += (target - n.stability) * 0.05;
  n.stability = Math.min(100, Math.max(0, n.stability));

  // 5) 识字率：随行政投入缓慢增长
  const adminRatio = n.spending.admin / Math.max(1, def.sliderMax);
  n.literacy = Math.min(1, Math.max(0, n.literacy + (0.003 + 0.005 * adminRatio) / 12));

  // 6) 事件：稳定度低触发起义；计划事件（每 1-3 月）
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
    for (const v of [n.popWan, n.literacy, n.treasury, n.foodStock, n.stability]) {
      if (!Number.isFinite(v)) return false;
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
