// 结算复盘报告：总资产/收益率/跑赢指数 + 收益归因 + 交易统计

import { STOCKS } from "./stocks";
import { currentPrice, computeAssets } from "./state";
import { round2 } from "./util";
import type { GameState, ReportAttribution, ReportData } from "./types";

/** 生成结算复盘报告（在最后一日后调用） */
export function buildReport(state: GameState): ReportData {
  const totalAssets = computeAssets(state);
  const ret = totalAssets / state.initialCash - 1;

  // 覆巢指数收益率（起点 100）
  const fcx = state.indices["FCX"]?.history;
  const indexClose = fcx && fcx.length > 0 ? fcx[fcx.length - 1].close : 100;
  const indexRet = indexClose / 100 - 1;
  const alpha = ret - indexRet;

  // 机构平均收益率
  const instAvg = state.institutionAvgHistory[state.institutionAvgHistory.length - 1]?.assets ?? 0;
  const instAvgRet = instAvg / state.initialCash - 1;

  // 收益归因：已实现 + 未实现（多空）
  const pnlMap: Record<string, number> = {};
  for (const code of Object.keys(state.tradeStats.realized ?? {})) {
    pnlMap[code] = (pnlMap[code] ?? 0) + (state.tradeStats.realized[code] ?? 0);
  }
  for (const h of state.holdings) {
    pnlMap[h.code] = (pnlMap[h.code] ?? 0) + (currentPrice(state, h.code) - h.avgCost) * h.qty;
  }
  for (const s of state.shorts) {
    pnlMap[s.code] = (pnlMap[s.code] ?? 0) + (s.avgPrice - currentPrice(state, s.code)) * s.qty;
  }
  const codes = new Set<string>([...STOCKS.map((s) => s.code), ...Object.keys(pnlMap)]);
  const attribution: ReportAttribution[] = [...codes]
    .map((code) => ({
      code,
      name: state.market[code]?.def.name ?? code,
      pnl: round2(pnlMap[code] ?? 0),
    }))
    .filter((a) => Math.abs(a.pnl) > 0.005)
    .sort((a, b) => b.pnl - a.pnl);

  const winRate =
    state.tradeStats.totalTrades > 0
      ? state.tradeStats.winTrades / state.tradeStats.totalTrades
      : 0;

  return {
    totalAssets,
    ret,
    indexRet,
    alpha,
    instAvgRet,
    attribution,
    winRate,
    tradeStats: { ...state.tradeStats, realized: { ...state.tradeStats.realized } },
  };
}
