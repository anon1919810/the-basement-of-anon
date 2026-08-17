// 状态管理：初始状态 / 存档 / 交易撮合 / 资产计算

import { INITIAL_CASH, LIMIT_PCT, STOCKS } from "./stocks";
import { createAITraders } from "./ai";
import { lastClose, round2 } from "./util";
import type { GameState, Holding, OrderSide, PendingOrder, StockMarket } from "./types";

export const SAVE_KEY = "fucao_stock_game_v1";

export function createInitialState(): GameState {
  const market: Record<string, StockMarket> = {};
  for (const def of STOCKS) {
    market[def.code] = {
      def,
      history: [{ day: 0, close: def.base, high: def.base, low: def.base, volume: 0, changePct: 0 }],
    };
  }
  return {
    version: 1,
    day: 0,
    phase: "playing",
    cash: INITIAL_CASH,
    holdings: [],
    orders: [],
    market,
    news: [],
    ai: createAITraders(),
    initialCash: INITIAL_CASH,
    messages: ["欢迎来到《覆巢之下》！点击「下一日」开始第 1 个交易日。"],
  };
}

export function pushMessage(state: GameState, msg: string): void {
  state.messages.push(msg);
  if (state.messages.length > 10) state.messages.splice(0, state.messages.length - 10);
}

export function saveState(state: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等场景下静默失败
  }
}

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (!parsed || parsed.version !== 1 || !parsed.market || !Array.isArray(parsed.ai)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}

export function holdingOf(state: GameState, code: string): Holding | undefined {
  return state.holdings.find((h) => h.code === code);
}

export function currentPrice(state: GameState, code: string): number {
  const m = state.market[code];
  return m ? lastClose(m) : 0;
}

export function computeAssets(state: GameState): number {
  return round2(
    state.cash + state.holdings.reduce((sum, h) => sum + h.qty * currentPrice(state, h.code), 0),
  );
}

/** 手续费：双向 0.1%，最低 1 */
export function feeOf(qty: number, price: number): number {
  return Math.max(1, Math.round(qty * price * 0.001));
}

export interface TradeResult {
  ok: boolean;
  message: string;
}

/** 市价单：立即按当前价成交（T+1、涨跌停、资金/持仓校验） */
export function placeMarketOrder(
  state: GameState,
  side: OrderSide,
  code: string,
  qty: number,
): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知股票代码" };
  const bar = m.history[m.history.length - 1];
  const price = bar.close;
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: "数量必须是正整数" };
  if (bar.changePct >= LIMIT_PCT - 1e-9 && side === "buy")
    return { ok: false, message: "该股今日涨停，无法买入" };
  if (bar.changePct <= -LIMIT_PCT + 1e-9 && side === "sell")
    return { ok: false, message: "该股今日跌停，无法卖出" };

  const fee = feeOf(qty, price);
  if (side === "buy") {
    const cost = round2(qty * price + fee);
    if (state.cash < cost)
      return { ok: false, message: `资金不足：需 ${cost.toFixed(2)}，可用 ${state.cash.toFixed(2)}` };
    state.cash = round2(state.cash - cost);
    buyHolding(state, code, qty, price, fee);
    pushMessage(state, `买入 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}，手续费 ${fee}（T+1：明日可卖）`);
    return { ok: true, message: `已买入 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}` };
  }

  const sellable = holdingOf(state, code)?.sellable ?? 0;
  if (sellable < qty)
    return { ok: false, message: `可卖数量不足（T+1）：可卖 ${sellable} 股` };
  const income = round2(qty * price - fee);
  state.cash = round2(state.cash + income);
  sellHolding(state, code, qty);
  pushMessage(state, `卖出 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}，手续费 ${fee}`);
  return { ok: true, message: `已卖出 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}` };
}

function buyHolding(state: GameState, code: string, qty: number, price: number, fee: number): void {
  const hold = holdingOf(state, code);
  if (hold) {
    const totalCost = hold.qty * hold.avgCost + qty * price + fee;
    hold.qty += qty;
    // sellable 不变：当日买入不计入可卖（T+1）
    hold.avgCost = round2(totalCost / hold.qty);
  } else {
    state.holdings.push({ code, qty, sellable: 0, avgCost: round2(price + fee / qty) });
  }
}

function sellHolding(state: GameState, code: string, qty: number): void {
  const hold = holdingOf(state, code);
  if (!hold) return;
  hold.qty -= qty;
  hold.sellable -= qty;
  if (hold.qty <= 0) state.holdings = state.holdings.filter((h) => h.code !== code);
}

/** 限价单：挂出，下一交易日撮合 */
export function placeLimitOrder(
  state: GameState,
  side: OrderSide,
  code: string,
  qty: number,
  limitPrice: number,
): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知股票代码" };
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: "数量必须是正整数" };
  if (!(limitPrice > 0)) return { ok: false, message: "限价必须大于 0" };
  if (side === "sell") {
    const sellable = holdingOf(state, code)?.sellable ?? 0;
    if (sellable < qty)
      return { ok: false, message: `可卖数量不足（T+1）：可卖 ${sellable} 股` };
  }
  state.orders.push({
    id: `order_${Date.now().toString(36)}_${state.orders.length}`,
    side,
    code,
    qty,
    limitPrice: round2(limitPrice),
    createdDay: state.day,
  });
  pushMessage(
    state,
    `挂出${side === "buy" ? "买入" : "卖出"}限价单：${m.def.name} ${qty} 股 @ ${limitPrice.toFixed(2)}（下一交易日撮合）`,
  );
  return { ok: true, message: "限价单已挂出，下一交易日撮合" };
}

export function cancelOrder(state: GameState, orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  state.orders = state.orders.filter((o) => o.id !== orderId);
  if (order) {
    const name = state.market[order.code]?.def.name ?? order.code;
    pushMessage(state, `已撤单：${name} ${order.qty} 股 @ ${order.limitPrice.toFixed(2)}`);
  }
}

/** 新的一天开始：所有持仓解除 T+1 锁定（当日买入次日可卖） */
export function unlockSellable(state: GameState): void {
  for (const h of state.holdings) h.sellable = h.qty;
}

/**
 * 撮合上一交易日挂出的限价单（在当日行情生成后调用）。
 * 买入：现价 ≤ 限价才成交；卖出：现价 ≥ 限价才成交；涨跌停不成交。
 * 返回撮合消息列表。
 */
export function matchLimitOrders(state: GameState): string[] {
  const msgs: string[] = [];
  const kept: PendingOrder[] = [];
  for (const order of state.orders) {
    const m = state.market[order.code];
    if (!m) continue;
    const bar = m.history[m.history.length - 1];
    const price = bar.close;
    const name = m.def.name;

    if (order.side === "buy") {
      if (bar.changePct >= LIMIT_PCT - 1e-9) {
        msgs.push(`涨停无法成交，已撤单：${name} 买入限价单`);
        continue;
      }
      if (price <= order.limitPrice) {
        const fee = feeOf(order.qty, order.limitPrice);
        const cost = round2(order.qty * order.limitPrice + fee);
        if (state.cash >= cost) {
          state.cash = round2(state.cash - cost);
          buyHolding(state, order.code, order.qty, order.limitPrice, fee);
          msgs.push(`限价买入成交：${name} ${order.qty} 股 @ ${order.limitPrice.toFixed(2)}`);
        } else {
          msgs.push(`资金不足，已撤单：${name} 买入限价单`);
        }
        continue;
      }
      kept.push(order);
    } else {
      if (bar.changePct <= -LIMIT_PCT + 1e-9) {
        msgs.push(`跌停无法成交，已撤单：${name} 卖出限价单`);
        continue;
      }
      if (price >= order.limitPrice) {
        const hold = holdingOf(state, order.code);
        if (hold && hold.sellable >= order.qty) {
          const fee = feeOf(order.qty, order.limitPrice);
          state.cash = round2(state.cash + order.qty * order.limitPrice - fee);
          sellHolding(state, order.code, order.qty);
          msgs.push(`限价卖出成交：${name} ${order.qty} 股 @ ${order.limitPrice.toFixed(2)}`);
        } else {
          msgs.push(`可卖数量不足，已撤单：${name} 卖出限价单`);
        }
        continue;
      }
      kept.push(order);
    }
  }
  state.orders = kept;
  return msgs;
}
