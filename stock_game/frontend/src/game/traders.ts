// 交易者分层：散户（数百，羊群+过度反应）/ 机构（5-10 家，趋势+基本面）/ 游资（2-3 路，隔日拉高出货）
// 产出：每股三类成交构成（手）+ 价格扰动（bias）+ 龙虎榜信号素材

import { STOCKS } from "./stocks";
import { fundamentalValue } from "./macro";
import { newsImpactFor } from "./news";
import { clamp, lastBar, lastClose, rand, round2 } from "./util";
import type { GameState, Institution, PoolTrader } from "./types";

export interface TraderImpact {
  retailBias: number; // 散户扰动（羊群追涨杀跌）
  instBias: number; // 机构扰动（基本面 ±1~3%）
  hotBias: number; // 游资扰动（拉高出货 ±2~4%）
  retailVol: number; // 手
  instVol: number;
  hotVol: number;
  hotPhase: "pump" | "dump" | "idle";
}

const INST_NAMES = [
  "华夏磐石基金",
  "南方稳进资管",
  "中金先锋投资",
  "嘉实成长基金",
  "东方量化私募",
  "博时价值基金",
];

export function createInstitutions(): Institution[] {
  return INST_NAMES.map((name, i) => ({
    id: `inst_${i}`,
    name,
    cash: 10000,
    holdings: {},
    avgCost: {},
    history: [],
  }));
}

export function createPools(): { retail: PoolTrader; hot: PoolTrader } {
  return {
    retail: { cash: 60000, holdings: {}, avgCost: {}, history: [] },
    hot: { cash: 40000, holdings: {}, avgCost: {}, history: [] },
  };
}

function poolAssets(state: GameState, pool: PoolTrader): number {
  return round2(
    pool.cash +
      STOCKS.reduce((s, def) => s + (pool.holdings[def.code] ?? 0) * lastClose(state.market[def.code]), 0),
  );
}

function instAssets(state: GameState, inst: Institution): number {
  return round2(
    inst.cash +
      STOCKS.reduce(
        (s, def) => s + (inst.holdings[def.code] ?? 0) * lastClose(state.market[def.code]),
        0,
      ),
  );
}

function poolBuy(pool: PoolTrader, code: string, qty: number, price: number): void {
  if (qty <= 0) return;
  const cost = qty * price;
  if (pool.cash < cost) qty = Math.floor(pool.cash / price);
  if (qty <= 0) return;
  pool.cash -= qty * price;
  const old = pool.holdings[code] ?? 0;
  const oldCost = pool.avgCost[code] ?? 0;
  pool.holdings[code] = old + qty;
  pool.avgCost[code] = old > 0 ? (old * oldCost + cost) / (old + qty) : price;
}

function poolSell(pool: PoolTrader, code: string, qty: number, price: number): void {
  if (qty <= 0) return;
  const have = pool.holdings[code] ?? 0;
  qty = Math.min(qty, have);
  if (qty <= 0) return;
  pool.cash += qty * price;
  pool.holdings[code] = have - qty;
  if (pool.holdings[code] <= 0) {
    delete pool.holdings[code];
    delete pool.avgCost[code];
  }
}

function instBuy(inst: Institution, code: string, qty: number, price: number): void {
  if (qty <= 0) return;
  const cost = qty * price;
  if (inst.cash < cost) qty = Math.floor(inst.cash / price);
  if (qty <= 0) return;
  inst.cash -= cost;
  const old = inst.holdings[code] ?? 0;
  const oldCost = inst.avgCost[code] ?? 0;
  inst.holdings[code] = old + qty;
  inst.avgCost[code] = old > 0 ? (old * oldCost + cost) / (old + qty) : price;
}

function instSell(inst: Institution, code: string, qty: number, price: number): void {
  if (qty <= 0) return;
  const have = inst.holdings[code] ?? 0;
  qty = Math.min(qty, have);
  if (qty <= 0) return;
  inst.cash += qty * price;
  inst.holdings[code] = have - qty;
  if (inst.holdings[code] <= 0) {
    delete inst.holdings[code];
    delete inst.avgCost[code];
  }
}

interface Score {
  code: string;
  sector: string;
  price: number;
  fund: number; // 宏观调整后的基础价值
  dev: number; // price/fund - 1
  mom: number; // 上一交易日涨跌幅
  cum: number; // 3 日累计
  news: number; // 当日新闻影响
}

function scoreAll(state: GameState): Score[] {
  return STOCKS.map((def) => {
    const m = state.market[def.code];
    const bar = lastBar(m);
    const h = m.history;
    let cum = 0;
    if (h.length >= 4) {
      const last3 = h.slice(-3);
      const first = last3[0].close;
      if (first > 0) cum = last3[last3.length - 1].close / first - 1;
    }
    const fund = fundamentalValue(state, def);
    return {
      code: def.code,
      sector: def.sector,
      price: bar.close,
      fund,
      dev: bar.close / fund - 1,
      mom: bar.changePct,
      cum,
      news: newsImpactFor(state.news, def.code, def.sector),
    };
  });
}

/**
 * 当日交易者决策：
 * 1) 游资周期（拉高→出货→蛰伏）更新
 * 2) 按基准占比 + 随机波动生成三类成交构成（手）
 * 3) 散户：羊群净买卖（池内记账）；机构：基本面+趋势买卖（逐家记账）；游资：脉冲买卖
 * 4) 返回每股 bias 与成交量构成
 */
export function simulateTraders(state: GameState): Record<string, TraderImpact> {
  const params = state.params;
  const scores = scoreAll(state);
  const impact: Record<string, TraderImpact> = {};

  for (const s of scores) {
    // ---- 游资周期 ----
    const cycle = state.hotCycles[s.code];
    let phase: "pump" | "dump" | "idle" = "idle";
    if (cycle) {
      if (cycle.phase === "pump" && state.day > cycle.day) {
        cycle.phase = "dump";
        cycle.day = state.day;
      } else if (cycle.phase === "dump" && state.day > cycle.day) {
        cycle.phase = "idle";
        cycle.untilDay = state.day + Math.round(rand(3, 6));
      } else if (cycle.phase === "idle" && state.day >= cycle.untilDay && Math.random() < 0.15) {
        cycle.phase = "pump";
        cycle.day = state.day;
      }
      phase = cycle.phase;
    } else if (Math.random() < 0.08) {
      state.hotCycles[s.code] = { phase: "pump", day: state.day, untilDay: state.day + 1 };
      phase = "pump";
    } else {
      state.hotCycles[s.code] = { phase: "idle", day: state.day, untilDay: state.day + Math.round(rand(3, 6)) };
    }

    // ---- 成交量构成（手）----
    const baseVol = rand(800, 18000);
    let retailVol = baseVol * params.retailShare * rand(0.75, 1.25);
    let instVol = baseVol * params.instShare * rand(0.75, 1.25);
    let hotVol =
      baseVol *
      params.hotShare *
      rand(0.5, 1.5) *
      (phase === "pump" ? 3 : 1) *
      (phase === "dump" ? 2 : 1);
    if (state.macro.crisisRemaining > 0) {
      retailVol *= 1.5; // 危机恐慌放量
      instVol *= 1.2;
    }
    retailVol = Math.round(retailVol);
    instVol = Math.round(instVol);
    hotVol = Math.round(hotVol);

    // ---- 散户：羊群追涨杀跌 + 新闻过度反应 ----
    const herd = clamp((s.mom + s.news * 2) * 3, -0.6, 0.6);
    const retailNetQty = Math.round(retailVol * 100 * herd); // 净买入股数（其余为对手盘换手）
    if (retailNetQty > 0) poolBuy(state.retail, s.code, retailNetQty, s.price);
    else if (retailNetQty < 0) poolSell(state.retail, s.code, -retailNetQty, s.price);
    const retailBias = clamp(herd * 0.015, -0.01, 0.01) + rand(-0.002, 0.002);

    // ---- 机构：基本面（估值中枢）+ 趋势 ----
    // 利率紧缩时回避成长（科技）板块；危机期间风险偏好骤降（risk-off）
    const tight = state.macro.rate === "tight";
    const crisis = state.macro.crisisRemaining > 0;
    const rateBias = tight ? -0.004 : state.macro.rate === "loose" ? 0.003 : 0;
    const riskOff = crisis ? -rand(0.005, 0.015) : 0;
    const instBias = clamp(s.dev * -0.5, -0.03, 0.03) + clamp(s.cum * 0.1, -0.006, 0.006) + rateBias + riskOff;
    for (const inst of state.institutions) {
      const budget = inst.cash * rand(0.04, 0.12);
      let acted = false;
      // 低估（dev < -5%）买入；危机期间不买入
      if (s.dev < -0.05 && !crisis && !(tight && s.sector === "科技")) {
        let qty = Math.floor((instVol * 100 * rand(0.1, 0.25)) / 100) * 100;
        qty = Math.max(100, Math.min(qty, Math.floor(budget / s.price / 100) * 100));
        if (qty >= 100 && inst.cash >= qty * s.price) {
          instBuy(inst, s.code, qty, s.price);
          acted = true;
        }
      }
      // 高估（dev > 10%）或止盈 >15% 卖出
      const holdQty = inst.holdings[s.code] ?? 0;
      const cost = inst.avgCost[s.code] ?? 0;
      if (!acted && holdQty >= 100 && (s.dev > 0.1 || (cost > 0 && s.price / cost - 1 > 0.15))) {
        const qty = Math.floor((holdQty * rand(0.3, 0.5)) / 100) * 100;
        if (qty >= 100) instSell(inst, s.code, qty, s.price);
      }
    }

    // ---- 游资：拉高出货 ----
    let hotBias = rand(-0.004, 0.004);
    if (phase === "pump") {
      const qty = Math.round(hotVol * 100);
      poolBuy(state.hot, s.code, qty, s.price);
      hotBias = rand(0.02, 0.04);
    } else if (phase === "dump") {
      const qty = Math.round(hotVol * 100 * 0.8);
      poolSell(state.hot, s.code, qty, s.price);
      hotBias = -rand(0.02, 0.04);
    }

    impact[s.code] = {
      retailBias,
      instBias,
      hotBias,
      retailVol,
      instVol,
      hotVol,
      hotPhase: phase,
    };
  }

  // 记录机构/资金池净值历史
  for (const inst of state.institutions) {
    inst.history.push({ day: state.day, assets: instAssets(state, inst) });
  }
  state.retail.history.push({ day: state.day, assets: poolAssets(state, state.retail) });
  state.hot.history.push({ day: state.day, assets: poolAssets(state, state.hot) });
  return impact;
}
