// AI 交易者：激进 / 稳健 / 趋势 三种风格，基于动量 + 新闻做买卖决策

import { INITIAL_CASH, STOCKS } from "./stocks";
import { newsImpactFor } from "./news";
import { lastBar, lastClose, rand } from "./util";
import type { AITrader, GameState } from "./types";

export interface AIDecision {
  code: string;
  bias: number; // 价格扰动（小数，正=推高）
  volume: number; // 手
}

export function createAITraders(): AITrader[] {
  return [
    { id: "ai_agg", name: "陈锐（激进）", style: "aggressive", cash: INITIAL_CASH, holdings: {}, avgCost: {}, history: [] },
    { id: "ai_steady", name: "李安（稳健）", style: "steady", cash: INITIAL_CASH, holdings: {}, avgCost: {}, history: [] },
    { id: "ai_trend", name: "王趋势（趋势）", style: "trend", cash: INITIAL_CASH, holdings: {}, avgCost: {}, history: [] },
  ];
}

interface Score {
  code: string;
  price: number;
  mom: number; // 上一交易日涨跌幅
  cum: number; // 过去 3 日累计涨跌幅
  news: number; // 当日新闻影响（小数）
  dev: number; // 相对基础价值偏离
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
    return {
      code: def.code,
      price: bar.close,
      mom: bar.changePct,
      cum,
      news: newsImpactFor(state.news, def.code, def.sector),
      dev: bar.close / def.base - 1,
    };
  });
}

function aiBuy(
  trader: AITrader,
  s: Score,
  cashFrac: number,
  decisions: AIDecision[],
): void {
  const budget = trader.cash * cashFrac;
  const qty = Math.floor(budget / s.price / 100) * 100; // 整手
  if (qty < 100) return;
  const cost = qty * s.price;
  trader.cash -= cost;
  const old = trader.holdings[s.code] ?? 0;
  trader.holdings[s.code] = old + qty;
  const oldCost = trader.avgCost[s.code] ?? 0;
  trader.avgCost[s.code] = old > 0 ? (old * oldCost + cost) / (old + qty) : s.price;
  decisions.push({ code: s.code, bias: rand(0.005, 0.02), volume: Math.max(1, Math.round(qty / 100)) });
}

function aiSell(
  trader: AITrader,
  s: Score,
  frac: number,
  decisions: AIDecision[],
): void {
  const qty = Math.floor(((trader.holdings[s.code] ?? 0) * frac) / 100) * 100;
  if (qty < 100) return;
  trader.cash += qty * s.price;
  trader.holdings[s.code] = (trader.holdings[s.code] ?? 0) - qty;
  if ((trader.holdings[s.code] ?? 0) <= 0) {
    delete trader.holdings[s.code];
    delete trader.avgCost[s.code];
  }
  decisions.push({ code: s.code, bias: rand(-0.02, -0.005), volume: Math.max(1, Math.round(qty / 100)) });
}

function recordAssets(state: GameState, trader: AITrader): void {
  const assets =
    trader.cash +
    STOCKS.reduce(
      (sum, def) => sum + (trader.holdings[def.code] ?? 0) * lastClose(state.market[def.code]),
      0,
    );
  trader.history.push({ day: state.day, assets });
}

/**
 * 让 3 名 AI 交易者基于当前行情 + 新闻做当日决策，并返回聚合的
 * 每股净扰动（±0.5%~2%）与成交量（手），供价格引擎使用。
 * 本函数会直接修改 state.ai（现金/持仓/历史）。
 */
export function simulateAI(state: GameState): Record<string, AIDecision> {
  const decisions: AIDecision[] = [];
  const scores = scoreAll(state);

  for (const trader of state.ai) {
    if (state.day < 2) continue; // 至少需要 1 个交易日数据
    const boughtToday = new Set<string>();

    switch (trader.style) {
      case "aggressive": {
        // 追动量 + 新闻：买得分前 2，卖动量转弱的仓位
        const ranked = [...scores].sort((a, b) => b.mom + b.news - (a.mom + a.news));
        let buys = 0;
        for (const s of ranked) {
          if (buys >= 2) break;
          if (s.mom + s.news <= 0.005) continue;
          aiBuy(trader, s, 0.35, decisions);
          boughtToday.add(s.code);
          buys += 1;
        }
        for (const s of scores) {
          if (s.mom < -0.02 && !boughtToday.has(s.code)) {
            aiSell(trader, s, 0.3, decisions);
          }
        }
        break;
      }
      case "trend": {
        // 跟随 3 日趋势：强则买龙头，弱则清仓最差
        const ranked = [...scores].sort((a, b) => b.cum - a.cum);
        const top = ranked[0];
        if (top && top.cum > 0.03) {
          aiBuy(trader, top, 0.3, decisions);
          boughtToday.add(top.code);
        }
        const worst = ranked[ranked.length - 1];
        if (worst && worst.cum < -0.03 && !boughtToday.has(worst.code)) {
          aiSell(trader, worst, 1, decisions);
        }
        break;
      }
      case "steady": {
        // 左侧低吸：低于基础价值 ≥10% 买入；盈利 >12% 分批止盈
        const dips = scores.filter((s) => s.dev < -0.1).sort((a, b) => a.dev - b.dev);
        if (dips[0]) {
          aiBuy(trader, dips[0], 0.15, decisions);
          boughtToday.add(dips[0].code);
        }
        for (const s of scores) {
          const qty = trader.holdings[s.code] ?? 0;
          const cost = trader.avgCost[s.code] ?? 0;
          if (qty >= 100 && cost > 0 && s.price / cost - 1 > 0.12 && !boughtToday.has(s.code)) {
            aiSell(trader, s, 0.5, decisions);
          }
        }
        break;
      }
    }

    recordAssets(state, trader);
  }

  // 聚合每股净扰动与成交量
  const agg: Record<string, AIDecision> = {};
  for (const d of decisions) {
    const cur = agg[d.code] ?? { code: d.code, bias: 0, volume: 0 };
    cur.bias += d.bias;
    cur.volume += d.volume;
    agg[d.code] = cur;
  }
  return agg;
}
