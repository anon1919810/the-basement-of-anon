// 无头完整对局模拟（开发期校验用）：跑满 30 天并断言核心不变量
// 运行：cd frontend && npx tsx scripts/sim.ts
import { createInitialState, computeAssets, placeMarketOrder } from "../src/game/state";
import { advanceDay, computeRanking } from "../src/game/engine";
import { LIMIT_PCT, STOCKS, TOTAL_DAYS } from "../src/game/stocks";
import type { GameState, OrderSide } from "../src/game/types";

// mock 后端新闻（走 "ai" 分支）
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      news: [
        { title: "测试利好", summary: "摘要", impact_stock: "STK", impact_range: "+3%~+5%", duration: 2 },
        { title: "测试利空", summary: "摘要", impact_stock: "能源", impact_range: "-4%~-2%", duration: 2 },
      ],
    }),
    { status: 200 },
  );

// 在克隆上撮合后把结果写回当前局（模拟玩家当日操作）
function trade(s: GameState, side: OrderSide, code: string, qty: number): string {
  const clone = structuredClone(s);
  const r = placeMarketOrder(clone, side, code, qty);
  if (r.ok) {
    s.cash = clone.cash;
    s.holdings = clone.holdings;
    s.messages = clone.messages;
    s.orders = clone.orders;
  }
  return r.message;
}

let state = createInitialState();
for (let d = 1; d <= TOTAL_DAYS; d++) {
  state = await advanceDay(state);
  for (const def of STOCKS) {
    const m = state.market[def.code];
    const h = m.history;
    const bar = h[h.length - 1];
    const prev = h[h.length - 2]?.close ?? def.base;
    const chg = bar.close / prev - 1;
    if (Math.abs(chg) > LIMIT_PCT + 1e-6) throw new Error(`涨跌停超限 ${def.code} 第${d}天: ${chg}`);
    if (!(bar.close > 0)) throw new Error(`非正价格 ${def.code}`);
    if (!(bar.volume >= 0)) throw new Error(`负成交量 ${def.code}`);
  }
  if (state.cash < 0) throw new Error("现金为负");
  for (const hold of state.holdings) {
    if (hold.sellable > hold.qty) throw new Error(`可卖>持仓 ${hold.code}`);
  }
  // 模拟玩家每天市价买一点、卖可卖部分
  const buyCode = STOCKS[d % STOCKS.length].code;
  const price = state.market[buyCode].history.at(-1)!.close;
  if (state.cash > 1000 && state.cash >= 100 * price * 1.001) {
    trade(state, "buy", buyCode, 100);
  }
  const hold = state.holdings[0];
  if (hold && hold.sellable >= 100) {
    trade(state, "sell", hold.code, 100);
  }
}

if (state.phase !== "settled") throw new Error("未进入结算");
const rank = computeRanking(state);
if (rank.length !== 4) throw new Error(`排名行数 ${rank.length} != 4`);
const assets = computeAssets(state);
console.log("SIM OK");
console.log("  天数:", state.day, "| 新闻累计:", state.news.length, "| 玩家总资产:", assets.toFixed(2));
console.log("  排名:", rank.map((r) => `${r.name} ${(r.ret * 100).toFixed(2)}%`).join(" / "));
console.log("  结算后现金:", state.cash.toFixed(2), "| 持仓:", state.holdings.length, "只");
