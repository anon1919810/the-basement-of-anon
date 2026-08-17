// 核心引擎：每日价格生成（随机游走/趋势/均值回归/新闻/涨跌停/成交量）+ 日循环 + 结算

import { LIMIT_PCT, STOCKS, TOTAL_DAYS } from "./stocks";
import { fetchDailyNews } from "./api";
import { newsImpactFor } from "./news";
import { simulateAI, type AIDecision } from "./ai";
import { computeAssets, currentPrice, matchLimitOrders, pushMessage, unlockSellable } from "./state";
import { clamp, lastBar, lastClose, rand, round2 } from "./util";
import type { GameState, StockMarket } from "./types";

/** 过去 3 日累计涨跌幅（小数） */
function threeDayCum(m: StockMarket): number {
  const h = m.history;
  if (h.length < 4) return 0;
  const last3 = h.slice(-3);
  const first = last3[0].close;
  return first > 0 ? last3[last3.length - 1].close / first - 1 : 0;
}

/** 给市场概况文本（供后端 AI 新闻参考） */
export function buildMarketSummary(state: GameState): string {
  return STOCKS.map((def) => {
    const bar = lastBar(state.market[def.code]);
    return `${def.name}(${def.code}) ${bar.close.toFixed(2)} ${(bar.changePct * 100).toFixed(1)}%`;
  }).join("；");
}

/**
 * 为当日生成 8 只股票的价格（基于前收盘）。
 * 1) 随机游走 ±1.5%
 * 2) 趋势因子：过去 3 日累计上涨则 +0.3%~0.8% 顺延，下跌反向
 * 3) 均值回归：偏离基础价值 >15% 拉回
 * 4) 新闻影响（按 impact_range 中值，持续 duration 天）
 * 5) AI 交易者额外扰动 ±0.5%~2% + 成交量放大
 * 6) 涨跌停 clamp ±10%
 */
function simulateDayPrices(state: GameState, aiAgg: Record<string, AIDecision>): void {
  for (const def of STOCKS) {
    const m = state.market[def.code];
    const prev = lastClose(m);

    // 1) 随机游走
    let drift = rand(-0.015, 0.015);
    // 2) 趋势因子
    const cum = threeDayCum(m);
    if (cum > 0) drift += rand(0.003, 0.008);
    else if (cum < 0) drift -= rand(0.003, 0.008);
    // 3) 均值回归
    const dev = prev / def.base - 1;
    if (dev > 0.15) drift -= rand(0.002, 0.01);
    else if (dev < -0.15) drift += rand(0.002, 0.01);
    // 4) 新闻影响
    drift += newsImpactFor(state.news, def.code, def.sector);
    // 5) AI 扰动与成交量放大
    let volume = Math.round(rand(1000, 20000));
    const ai = aiAgg[def.code];
    if (ai) {
      drift += ai.bias;
      volume = Math.round(volume * rand(1.2, 2.0));
    }
    // 6) 涨跌停：先钳制漂移，再对四舍五入后的收盘价二次钳制（避免舍入越界）
    const pct = clamp(drift, -LIMIT_PCT, LIMIT_PCT);
    const limitUp = prev * (1 + LIMIT_PCT);
    const limitDown = prev * (1 - LIMIT_PCT);
    const closeRaw = prev * (1 + pct);
    const close = clamp(round2(closeRaw), limitDown, limitUp);
    const actualPct = close / prev - 1;
    const open = round2(prev * (1 + rand(-0.004, 0.004)));
    const high = clamp(round2(Math.max(open, close) * (1 + rand(0, 0.004))), limitDown, limitUp);
    const low = clamp(round2(Math.min(open, close) * (1 - rand(0, 0.004))), limitDown, limitUp);
    m.history.push({ day: state.day, close, high, low, volume, changePct: actualPct });
  }
}

/**
 * 推进一个交易日：生成新闻 → AI 决策 → 价格引擎 → 解锁 T+1 → 撮合限价单 → 新闻衰减。
 * 第 30 天后进入结算。
 */
export async function advanceDay(prev: GameState): Promise<GameState> {
  const state = structuredClone(prev);
  state.day += 1;

  // 1) 当日新闻（优先后端 AI，失败用前端模板）
  const summary = buildMarketSummary(state);
  const newsList = await fetchDailyNews(state.day, summary);
  state.news.push(...newsList);

  // 2) AI 交易者决策（基于前收盘 + 当日新闻）
  const aiAgg = simulateAI(state);
  // 3) 价格引擎生成当日行情
  simulateDayPrices(state, aiAgg);
  // 4) 新的一天：解除 T+1 锁定，撮合上一日的限价单
  unlockSellable(state);
  const matchMsgs = matchLimitOrders(state);
  // 5) 新闻影响天数衰减（保留历史供新闻流展示）
  for (const n of state.news) n.remaining -= 1;
  // 6) 收尾消息
  pushMessage(
    state,
    `第 ${state.day} 个交易日结束${matchMsgs.length ? `：${matchMsgs.join("；")}` : ""}`,
  );
  if (state.day >= TOTAL_DAYS) {
    state.phase = "settled";
    pushMessage(state, "30 个交易日结束，结算完成！");
  }
  return state;
}

export interface RankRow {
  name: string;
  assets: number;
  ret: number; // 收益率（小数）
  isPlayer: boolean;
}

/** 结算排名：玩家 vs 3 名 AI（收益率降序） */
export function computeRanking(state: GameState): RankRow[] {
  const playerAssets = computeAssets(state);
  const rows: RankRow[] = [
    {
      name: "你（投资经理）",
      assets: playerAssets,
      ret: playerAssets / state.initialCash - 1,
      isPlayer: true,
    },
  ];
  for (const trader of state.ai) {
    const assets = round2(
      trader.cash +
        STOCKS.reduce(
          (sum, def) => sum + (trader.holdings[def.code] ?? 0) * currentPrice(state, def.code),
          0,
        ),
    );
    rows.push({ name: trader.name, assets, ret: assets / state.initialCash - 1, isPlayer: false });
  }
  return rows.sort((a, b) => b.ret - a.ret);
}
