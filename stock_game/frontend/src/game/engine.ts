// 核心引擎：日循环整合 宏观事件 / AI 新闻 / 交易者分层 / 多资产价格 / 做空强平 / 龙虎榜 / 结算复盘

import { STOCKS, TOTAL_DAYS } from "./stocks";
import { computeIndices, simulateAssetPrices } from "./assets";
import { fetchDailyNews } from "./api";
import { newsImpactFor } from "./news";
import { fundamentalValue, stepMacro } from "./macro";
import { simulateTraders, type TraderImpact } from "./traders";
import { chargeBorrowFees, forceCloseShorts } from "./short";
import { buildReport } from "./report";
import { computeAssets, currentPrice, matchLimitOrders, pushMessage, unlockSellable } from "./state";
import { clamp, lastBar, lastClose, lastOf, rand, round2 } from "./util";
import type { GameState, StockMarket } from "./types";

/** 过去 3 日累计涨跌幅（小数） */
function threeDayCum(m: StockMarket): number {
  const h = m.history;
  if (h.length < 4) return 0;
  const last3 = h.slice(-3);
  const first = last3[0].close;
  return first > 0 ? last3[last3.length - 1].close / first - 1 : 0;
}

/** 给后端 AI 新闻的市场概况（含指数与商品） */
export function buildMarketSummary(state: GameState): string {
  const stocks = STOCKS.map((def) => {
    const bar = lastBar(state.market[def.code]);
    return `${def.name}(${def.code}) ${bar.close.toFixed(2)} ${(bar.changePct * 100).toFixed(1)}%`;
  }).join("；");
  const fcx = lastOf(state.indices["FCX"].history);
  const gold = lastBar(state.market["GOLD"]);
  const oil = lastBar(state.market["OIL"]);
  return `覆巢指数 ${fcx.close.toFixed(2)}(${(fcx.changePct * 100).toFixed(1)}%)；黄金 ${gold.close.toFixed(2)}；原油 ${oil.close.toFixed(2)}；利率 ${(state.macro.rateValue * 100).toFixed(0)}% 通胀 ${(state.macro.inflationValue * 100).toFixed(0)}%；${stocks}`;
}

/**
 * 当日股票价格生成：随机游走 + 趋势 + 均值回归（宏观基础价值）+ 新闻 + 交易者扰动 + 涨跌停
 */
function simulateDayPrices(state: GameState, trader: Record<string, TraderImpact>): void {
  const params = state.params;
  for (const def of STOCKS) {
    const m = state.market[def.code];
    const prev = lastClose(m);

    let drift = rand(-0.015, 0.015);
    // 趋势因子
    const cum = threeDayCum(m);
    if (cum > 0) drift += rand(0.003, 0.008);
    else if (cum < 0) drift -= rand(0.003, 0.008);
    // 均值回归：相对宏观基础价值偏离 >15% 拉回（利率↑→中枢↓→杀估值）
    const fund = fundamentalValue(state, def);
    const dev = prev / fund - 1;
    if (dev > 0.15) drift -= clamp(dev * 0.03, 0.01, 0.035);
    else if (dev < -0.15) drift += clamp(-dev * 0.03, 0.01, 0.035);
    // 新闻影响
    drift += newsImpactFor(state.news, def.code, def.sector);
    // 危机：流动性冻结，股市系统性下跌（叠加宏观新闻，形成 -10~-20% 窗口）
    if (state.macro.crisisRemaining > 0) drift -= rand(0.015, 0.03);
    // 交易者分层扰动
    const t = trader[def.code];
    if (t) {
      drift += t.retailBias + t.instBias + t.hotBias;
    }

    const pct = clamp(drift, -params.limitPct, params.limitPct);
    const limitUp = prev * (1 + params.limitPct);
    const limitDown = prev * (1 - params.limitPct);
    const close = clamp(round2(prev * (1 + pct)), limitDown, limitUp);
    const actualPct = close / prev - 1;
    const open = round2(prev * (1 + rand(-0.004, 0.004)));
    const high = clamp(round2(Math.max(open, close) * (1 + rand(0, 0.004))), limitDown, limitUp);
    const low = clamp(round2(Math.min(open, close) * (1 - rand(0, 0.004))), limitDown, limitUp);
    const volume = t
      ? Math.round(t.retailVol + t.instVol + t.hotVol)
      : Math.round(rand(1000, 20000));
    m.history.push({
      day: state.day,
      close,
      high,
      low,
      volume,
      changePct: actualPct,
      volBreakdown: t
        ? {
            retail: Math.round(t.retailVol),
            inst: Math.round(t.instVol),
            hot: Math.round(t.hotVol),
          }
        : { retail: 0, inst: 0, hot: 0 },
    });
  }
}

/** 单日异动超阈值 → 龙虎榜风格信号 */
function generateSignals(state: GameState, trader: Record<string, TraderImpact>): void {
  for (const def of STOCKS) {
    const bar = lastBar(state.market[def.code]);
    const t = trader[def.code];
    if (!t) continue;
    const total = t.retailVol + t.instVol + t.hotVol;
    const retailShare = total > 0 ? t.retailVol / total : 0;
    const bigMove = Math.abs(bar.changePct) >= 0.05;
    const hotActive = t.hotPhase === "pump" || t.hotPhase === "dump";
    if (!bigMove && !hotActive) continue;

    let text = "";
    let kind: "inst" | "hot" | "retail" = "retail";
    if (t.hotPhase === "pump") {
      text = "游资抢筹，谨防次日出货";
      kind = "hot";
    } else if (t.hotPhase === "dump") {
      text = "游资出逃";
      kind = "hot";
    } else if (t.instBias > 0.008) {
      text = "机构净买入";
      kind = "inst";
    } else if (t.instBias < -0.008) {
      text = "机构净卖出";
      kind = "inst";
    } else if (retailShare > 0.55) {
      text = "散户主导，情绪化波动";
      kind = "retail";
    } else {
      text = "异动";
      kind = "retail";
    }
    state.signals.push({ day: state.day, code: def.code, name: def.name, text, kind });
  }
  if (state.signals.length > 40) state.signals.splice(0, state.signals.length - 40);
}

/**
 * 推进一个交易日：参数生效 → 宏观 → AI 新闻 → 交易者 → 价格 → 指数 → 借券费/强平
 * → 龙虎榜 → T+1 解锁 → 限价撮合 → 新闻衰减 → 净值历史。
 * 第 60 天后进入结算并生成复盘报告。
 */
export async function advanceDay(prev: GameState): Promise<GameState> {
  const state = structuredClone(prev);
  state.day += 1;

  // 0) 调参面板改动从下一交易日生效
  if (state.pendingParams) {
    state.params = { ...state.pendingParams };
    state.pendingParams = null;
    pushMessage(state, "新参数已生效（手续费/涨跌停/保证金等）。");
  }

  // 1) 宏观事件（每 5-8 天）
  stepMacro(state);

  // 2) 当日 AI 新闻（后端优先生成，失败前端模板兜底）
  const summary = buildMarketSummary(state);
  const newsList = await fetchDailyNews(state.day, summary);
  state.news.push(...newsList);

  // 3) 交易者分层决策（散户/机构/游资）
  const trader = simulateTraders(state);

  // 4) 价格引擎：股票 + 债券/商品
  simulateDayPrices(state, trader);
  simulateAssetPrices(state);

  // 5) 指数行情（市值加权）
  computeIndices(state);

  // 6) 做空：借券费 + 强平检查
  chargeBorrowFees(state);
  forceCloseShorts(state);

  // 7) 龙虎榜信号
  generateSignals(state, trader);

  // 8) 新的一天：解除 T+1 锁定，撮合上一日的限价单
  unlockSellable(state);
  const matchMsgs = matchLimitOrders(state);

  // 9) 新闻/危机/油价影响衰减
  for (const n of state.news) n.remaining -= 1;
  if (state.macro.crisisRemaining > 0) state.macro.crisisRemaining -= 1;
  if (state.macro.oilBoostDays > 0) state.macro.oilBoostDays -= 1;

  // 10) 净值曲线历史
  state.playerHistory.push({ day: state.day, assets: computeAssets(state) });
  const instLast = state.institutions
    .map((i) => i.history[i.history.length - 1]?.assets ?? 0)
    .reduce((s, v) => s + v, 0);
  state.institutionAvgHistory.push({
    day: state.day,
    assets: round2(instLast / Math.max(1, state.institutions.length)),
  });

  // 11) 收尾
  pushMessage(
    state,
    `第 ${state.day} 个交易日结束${matchMsgs.length ? `：${matchMsgs.join("；")}` : ""}`,
  );
  if (state.day >= TOTAL_DAYS) {
    state.phase = "settled";
    state.report = buildReport(state);
    pushMessage(state, `${TOTAL_DAYS} 个交易日结束，结算完成！`);
  }
  return state;
}

export interface RankRow {
  name: string;
  assets: number;
  ret: number; // 收益率（小数）
  isPlayer: boolean;
}

/** 结算排名（保留兼容）：玩家 vs 各机构（收益率降序） */
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
  for (const inst of state.institutions) {
    const assets = round2(
      inst.cash +
        STOCKS.reduce(
          (sum, def) => sum + (inst.holdings[def.code] ?? 0) * currentPrice(state, def.code),
          0,
        ),
    );
    rows.push({ name: inst.name, assets, ret: assets / state.initialCash - 1, isPlayer: false });
  }
  return rows.sort((a, b) => b.ret - a.ret);
}
