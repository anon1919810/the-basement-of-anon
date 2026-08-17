// 宏观经济层：通胀×利率状态机 + 宏观事件 + 黑天鹅危机 + 基础价值公式

import { STOCKS } from "./stocks";
import { clamp, rand, round2 } from "./util";
import type { GameState, InflationLevel, MacroState, NewsItem, RateLevel, StockDef } from "./types";

export const INFLATION_LEVELS: Record<InflationLevel, number> = {
  low: 0.01,
  mid: 0.03,
  high: 0.08,
};

export const RATE_LEVELS: Record<RateLevel, number> = {
  loose: 0.01,
  neutral: 0.03,
  tight: 0.06,
};

export const INFLATION_ORDER: InflationLevel[] = ["low", "mid", "high"];
export const RATE_ORDER: RateLevel[] = ["loose", "neutral", "tight"];

export function createInitialMacro(): MacroState {
  return {
    inflation: "mid",
    rate: "neutral",
    inflationValue: INFLATION_LEVELS.mid,
    rateValue: RATE_LEVELS.neutral,
    nextEventDay: Math.round(rand(5, 8)),
    inflationHighStreak: 0,
    crisisUsed: false,
    crisisRemaining: 0,
    oilBoostDays: 0,
    events: [],
  };
}

export interface MacroEventDef {
  type: string;
  title: string;
  summary: string;
  inflationDelta: -1 | 0 | 1;
  rateDelta: -1 | 0 | 1;
  impactStock: string; // 新闻影响标的
  impactRange: string;
  duration: number;
  weight: number;
}

export const MACRO_EVENTS: MacroEventDef[] = [
  {
    type: "rate_cut",
    title: "央行宣布降息，流动性宽松",
    summary: "央行下调政策利率，无风险利率回落，权益资产估值中枢上移，债市走强。",
    inflationDelta: 0,
    rateDelta: -1,
    impactStock: "ALL",
    impactRange: "+2%~+4%",
    duration: 2,
    weight: 2,
  },
  {
    type: "rate_hike",
    title: "央行超预期加息，市场承压",
    summary: "为抑制通胀央行上调政策利率，无风险利率上行，杀估值行情开启，成长板块首当其冲。",
    inflationDelta: 0,
    rateDelta: 1,
    impactStock: "ALL",
    impactRange: "-3%~-5%",
    duration: 2,
    weight: 2,
  },
  {
    type: "inflation_up",
    title: "通胀抬头，企业成本压力加大",
    summary: "CPI 超预期上行，企业利润率承压，周期股与消费股敏感，央行后续或被迫收紧。",
    inflationDelta: 1,
    rateDelta: 0,
    impactStock: "ALL",
    impactRange: "-1.5%~-2.5%",
    duration: 2,
    weight: 2,
  },
  {
    type: "inflation_down",
    title: "需求回落，通胀降温",
    summary: "大宗与核心商品价格回落，通胀压力缓解，企业成本端改善，利率预期下行。",
    inflationDelta: -1,
    rateDelta: 0,
    impactStock: "ALL",
    impactRange: "+1%~+2%",
    duration: 2,
    weight: 1,
  },
  {
    type: "gdp_beat",
    title: "GDP 超预期，经济复苏确认",
    summary: "最新经济数据全面超预期，企业盈利预期上修，风险偏好回升。",
    inflationDelta: 0,
    rateDelta: 0,
    impactStock: "ALL",
    impactRange: "+1.5%~+3%",
    duration: 2,
    weight: 2,
  },
  {
    type: "oil_shock",
    title: "油价冲击：地缘风险推高原油",
    summary: "供应端扰动加剧，原油价格大幅上行，能源板块受益，其余行业成本承压，通胀预期升温。",
    inflationDelta: 0,
    rateDelta: 0,
    impactStock: "ENE",
    impactRange: "+4%~+7%",
    duration: 2,
    weight: 1.5,
  },
  {
    type: "jobs_report",
    title: "就业报告：劳动力市场强劲",
    summary: "非农就业超预期，经济韧性十足，但强化了央行维持高利率的预期。",
    inflationDelta: 0,
    rateDelta: 0,
    impactStock: "ALL",
    impactRange: "+1%~+2%",
    duration: 1,
    weight: 1,
  },
  {
    type: "black_swan",
    title: "黑天鹅危机：流动性冻结",
    summary: "系统性风险爆发，市场流动性骤然冻结，股市恐慌性抛售，股债双杀，避险资金涌入黄金。",
    inflationDelta: 0,
    rateDelta: 0,
    impactStock: "ALL",
    impactRange: "-5%~-8%",
    duration: 3,
    weight: 0.5,
  },
];

function stepLevel<T extends string>(order: T[], cur: T, delta: -1 | 0 | 1): T {
  const idx = order.indexOf(cur);
  const next = clamp(idx + delta, 0, order.length - 1);
  return order[next];
}

function makeMacroNews(day: number, def: MacroEventDef): NewsItem {
  return {
    id: `macro_${day}_${def.type}_${Math.random().toString(36).slice(2, 8)}`,
    day,
    title: def.title,
    summary: def.summary,
    impactStock: def.impactStock,
    impactRange: def.impactRange,
    duration: def.duration,
    source: "macro",
    kind: "macro",
    remaining: def.duration,
  };
}

/**
 * 核心公式：股票基础价值 = 预期股息 / 无风险利率
 * 利率↑ → 基础价值↓（杀估值）；通胀↑ → 利润率↓（周期股更敏感）
 */
export function fundamentalValue(state: GameState, def: StockDef): number {
  const { rateValue, inflationValue } = state.macro;
  const rateFactor = 0.03 / rateValue;
  const sens = def.cyclical ? 1.5 : 1;
  const profitFactor = 1 - (inflationValue - 0.03) * 2 * sens;
  return round2(def.base * rateFactor * profitFactor);
}

/** 覆巢指数最近 5 日涨跌幅（衰退信号判断用） */
export function indexRecentChange(state: GameState): number {
  const im = state.indices["FCX"];
  const h = im?.history ?? [];
  if (h.length < 6) return 0;
  const last5 = h.slice(-5);
  const first = last5[0].close;
  return first > 0 ? last5[last5.length - 1].close / first - 1 : 0;
}

/**
 * 触发一次宏观事件（导出供测试强制触发）。
 * 返回事件类型。
 */
export function triggerMacroEvent(state: GameState, type: string): string {
  const def = MACRO_EVENTS.find((e) => e.type === type) ?? MACRO_EVENTS[0];
  const day = state.day;

  // 状态迁移
  if (def.inflationDelta !== 0) {
    state.macro.inflation = stepLevel(INFLATION_ORDER, state.macro.inflation, def.inflationDelta);
    state.macro.inflationValue = INFLATION_LEVELS[state.macro.inflation];
  }
  if (def.rateDelta !== 0) {
    state.macro.rate = stepLevel(RATE_ORDER, state.macro.rate, def.rateDelta);
    state.macro.rateValue = RATE_LEVELS[state.macro.rate];
  }

  // 高通胀持续期数
  if (state.macro.inflation === "high") state.macro.inflationHighStreak += 1;
  else state.macro.inflationHighStreak = 0;
  if (type === "rate_hike") state.macro.inflationHighStreak = 0; // 加息落地后重新计数

  // 黑天鹅特殊处理
  if (type === "black_swan") {
    state.macro.crisisUsed = true;
    state.macro.crisisRemaining = 3;
  }
  if (type === "oil_shock") {
    state.macro.oilBoostDays = 2;
    if (Math.random() < 0.3) {
      state.macro.inflation = stepLevel(INFLATION_ORDER, state.macro.inflation, 1);
      state.macro.inflationValue = INFLATION_LEVELS[state.macro.inflation];
    }
  }

  // 宏观新闻进新闻流
  state.news.push(makeMacroNews(day, def));
  state.macro.events.push({ day, type: def.type, title: def.title });

  // 下一个事件日
  const p = state.params;
  state.macro.nextEventDay =
    day + Math.round(rand(Math.max(1, p.macroMinDays), Math.max(2, p.macroMaxDays)));
  return def.type;
}

/** 按规则挑选下一个宏观事件（央行反应规则优先） */
function pickEventType(state: GameState): string {
  // 央行反应规则：高通胀持续 2 期 → 被迫加息
  if (state.macro.inflation === "high" && state.macro.inflationHighStreak >= 2) {
    return "rate_hike";
  }
  // 衰退信号：覆巢指数 5 日跌幅超 6% → 降息
  if (indexRecentChange(state) < -0.06) {
    return "rate_cut";
  }
  // 黑天鹅：每局最多 1 次，约 20% 概率
  if (!state.macro.crisisUsed && Math.random() < state.params.crisisProb) {
    return "black_swan";
  }
  const last = state.macro.events[state.macro.events.length - 1];
  let pick = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const total = MACRO_EVENTS.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    let chosen = MACRO_EVENTS[0].type;
    for (const e of MACRO_EVENTS) {
      r -= e.weight;
      if (r <= 0) {
        chosen = e.type;
        break;
      }
    }
    // 避免与上次同类型连续重复（利率方向来回震荡）
    if (last && (last.type === "rate_hike" || last.type === "rate_cut") && chosen === last.type) {
      continue;
    }
    pick = chosen;
    break;
  }
  return pick || "gdp_beat";
}

/**
 * 宏观步进：到事件日则触发事件。
 * 返回是否发生事件。
 */
export function stepMacro(state: GameState): boolean {
  if (state.day < state.macro.nextEventDay) return false;
  const type = pickEventType(state);
  triggerMacroEvent(state, type);
  return true;
}

/** 供 UI 展示宏观状态 */
export function macroStatusText(state: GameState): { rate: string; inflation: string } {
  const rateMap: Record<RateLevel, string> = { loose: "宽松 1%", neutral: "中性 3%", tight: "紧缩 6%" };
  const infMap: Record<InflationLevel, string> = { low: "低 1%", mid: "中 3%", high: "高 8%" };
  return {
    rate: rateMap[state.macro.rate],
    inflation: infMap[state.macro.inflation],
  };
}

/** 股票行业中文名（科技/消费/能源/医药/金融/原材料/公用事业） */
export function sectorName(sector: string): string {
  return sector;
}

/** 供外部使用：全部股票代码（报告归因等） */
export function allStockCodes(): string[] {
  return STOCKS.map((s) => s.code);
}
