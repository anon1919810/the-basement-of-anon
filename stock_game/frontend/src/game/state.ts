// 状态管理：初始状态（v2）/ 存档 / 交易撮合 / 资产计算 / 成交流水

import { INITIAL_CASH, STOCKS, TOTAL_DAYS } from "./stocks";
import { BONDS, COMMODITIES, INDICES } from "./assets";
import { createInitialMacro } from "./macro";
import { DEFAULT_PARAMS } from "./params";
import { createInstitutions, createPools } from "./traders";
import { lastClose, round2 } from "./util";
import type {
  GameState,
  Holding,
  OrderSide,
  PendingOrder,
  StockMarket,
  TradeableDef,
  TradeAction,
  TradeLogItem,
  TunableParams,
} from "./types";

export const SAVE_KEY = "fucao_stock_game_v2";
export const STATE_VERSION = 2;

export function createInitialState(): GameState {
  const market: Record<string, StockMarket> = {};
  const makeHist = (def: TradeableDef) => ({
    def,
    history: [{ day: 0, close: def.base, high: def.base, low: def.base, volume: 0, changePct: 0 }],
  });
  for (const def of [...STOCKS, ...BONDS, ...COMMODITIES]) market[def.code] = makeHist(def);

  const indices: GameState["indices"] = {};
  for (const def of INDICES) {
    indices[def.code] = { def, history: [{ day: 0, close: 100, changePct: 0 }] };
  }

  const pools = createPools();
  return {
    version: STATE_VERSION,
    day: 0,
    phase: "playing",
    cash: INITIAL_CASH,
    holdings: [],
    shorts: [],
    borrowed: {},
    marginReserved: 0,
    orders: [],
    market,
    indices,
    news: [],
    macro: createInitialMacro(),
    params: { ...DEFAULT_PARAMS },
    pendingParams: null,
    institutions: createInstitutions(),
    retail: pools.retail,
    hot: pools.hot,
    hotCycles: {},
    playerHistory: [{ day: 0, assets: INITIAL_CASH }],
    institutionAvgHistory: [{ day: 0, assets: INITIAL_CASH }],
    tradeLog: [],
    tradeStats: {
      totalTrades: 0,
      winTrades: 0,
      totalFee: 0,
      buyCount: 0,
      sellCount: 0,
      shortCount: 0,
      coverCount: 0,
      realized: {},
    },
    signals: [],
    report: null,
    initialCash: INITIAL_CASH,
    messages: ["欢迎来到《覆巢之下》深度版！点击「下一日」开始第 1 个交易日。"],
  };
}

export function pushMessage(state: GameState, msg: string): void {
  state.messages.push(msg);
  if (state.messages.length > 12) state.messages.splice(0, state.messages.length - 12);
}

/** 逐笔成交流水记录（买卖/做空/平仓/强平/借券费/手续费） */
export function recordTrade(
  state: GameState,
  action: TradeAction,
  code: string,
  qty: number,
  price: number,
  fee: number,
  note?: string,
): void {
  const name = state.market[code]?.def.name ?? code;
  const item: TradeLogItem = {
    id: `tr_${state.day}_${state.tradeLog.length}_${Math.random().toString(36).slice(2, 6)}`,
    day: state.day,
    code,
    name,
    action,
    qty,
    price,
    amount: round2(qty * price),
    fee,
    note,
  };
  state.tradeLog.push(item);
  if (state.tradeLog.length > 500) state.tradeLog.splice(0, state.tradeLog.length - 500);
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
    // v1 旧存档 version=1 与 key 不同，直接忽略；结构不完整同样忽略（优雅重置）
    if (
      !parsed ||
      parsed.version !== STATE_VERSION ||
      !parsed.market ||
      !Array.isArray(parsed.institutions) ||
      !parsed.macro ||
      !parsed.params ||
      !parsed.indices
    )
      return null;
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

/** 总资产 = 现金 + 多头市值 - 空头负债（空头按当前市价计入负债） */
export function computeAssets(state: GameState): number {
  let assets = state.cash;
  for (const h of state.holdings) assets += h.qty * currentPrice(state, h.code);
  for (const s of state.shorts) assets -= s.qty * currentPrice(state, s.code);
  return round2(assets);
}

/** 手续费：双向 feeRate，最低 minFee */
export function feeOf(params: TunableParams, qty: number, price: number): number {
  return Math.max(params.minFee, Math.round(qty * price * params.feeRate));
}

export interface TradeResult {
  ok: boolean;
  message: string;
}

/** 市价单（买入/卖出）：T+1、涨跌停、资金/持仓校验 */
export function placeMarketOrder(
  state: GameState,
  side: OrderSide,
  code: string,
  qty: number,
): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知资产代码" };
  const bar = m.history[m.history.length - 1];
  const price = bar.close;
  const params = state.params;
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: "数量必须是正整数" };
  if (bar.changePct >= params.limitPct - 1e-9 && side === "buy")
    return { ok: false, message: "该标的今日涨停，无法买入" };
  if (bar.changePct <= -params.limitPct + 1e-9 && side === "sell")
    return { ok: false, message: "该标的今日跌停，无法卖出" };

  const fee = feeOf(params, qty, price);
  if (side === "buy") {
    const cost = round2(qty * price + fee);
    if (state.cash - state.marginReserved < cost)
      return {
        ok: false,
        message: `资金不足：需 ${cost.toFixed(2)}，可用 ${(state.cash - state.marginReserved).toFixed(2)}`,
      };
    state.cash = round2(state.cash - cost);
    buyHolding(state, code, qty, price, fee);
    state.tradeStats.buyCount += 1;
    state.tradeStats.totalTrades += 1;
    state.tradeStats.totalFee += fee;
    recordTrade(state, "buy", code, qty, price, fee);
    pushMessage(state, `买入 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}，手续费 ${fee}（T+1：明日可卖）`);
    return { ok: true, message: `已买入 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}` };
  }

  const sellable = holdingOf(state, code)?.sellable ?? 0;
  if (sellable < qty)
    return { ok: false, message: `可卖数量不足（T+1）：可卖 ${sellable} 股` };
  const income = round2(qty * price - fee);
  state.cash = round2(state.cash + income);
  const hold = holdingOf(state, code)!;
  const realized = round2(qty * price - fee - qty * hold.avgCost);
  sellHolding(state, code, qty);
  state.tradeStats.sellCount += 1;
  state.tradeStats.totalTrades += 1;
  state.tradeStats.totalFee += fee;
  state.tradeStats.realized[code] = round2((state.tradeStats.realized[code] ?? 0) + realized);
  if (realized > 0) state.tradeStats.winTrades += 1;
  recordTrade(state, "sell", code, qty, price, fee);
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

/** 限价单（买入/卖出）：挂出，下一交易日撮合 */
export function placeLimitOrder(
  state: GameState,
  side: "buy" | "sell",
  code: string,
  qty: number,
  limitPrice: number,
): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知资产代码" };
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

/** 新的一天开始：所有持仓解除 T+1 锁定 */
export function unlockSellable(state: GameState): void {
  for (const h of state.holdings) h.sellable = h.qty;
}

/** 撮合上一交易日挂出的限价单（当日行情生成后调用） */
export function matchLimitOrders(state: GameState): string[] {
  const msgs: string[] = [];
  const kept: PendingOrder[] = [];
  const params = state.params;
  for (const order of state.orders) {
    const m = state.market[order.code];
    if (!m) continue;
    const bar = m.history[m.history.length - 1];
    const price = bar.close;
    const name = m.def.name;

    if (order.side === "buy") {
      if (bar.changePct >= params.limitPct - 1e-9) {
        msgs.push(`涨停无法成交，已撤单：${name} 买入限价单`);
        continue;
      }
      if (price <= order.limitPrice) {
        const fee = feeOf(params, order.qty, order.limitPrice);
        const cost = round2(order.qty * order.limitPrice + fee);
        if (state.cash - state.marginReserved >= cost) {
          state.cash = round2(state.cash - cost);
          buyHolding(state, order.code, order.qty, order.limitPrice, fee);
          state.tradeStats.buyCount += 1;
          state.tradeStats.totalTrades += 1;
          state.tradeStats.totalFee += fee;
          recordTrade(state, "buy", order.code, order.qty, order.limitPrice, fee);
          msgs.push(`限价买入成交：${name} ${order.qty} 股 @ ${order.limitPrice.toFixed(2)}`);
        } else {
          msgs.push(`资金不足，已撤单：${name} 买入限价单`);
        }
        continue;
      }
      kept.push(order);
    } else {
      if (bar.changePct <= -params.limitPct + 1e-9) {
        msgs.push(`跌停无法成交，已撤单：${name} 卖出限价单`);
        continue;
      }
      if (price >= order.limitPrice) {
        const hold = holdingOf(state, order.code);
        if (hold && hold.sellable >= order.qty) {
          const fee = feeOf(params, order.qty, order.limitPrice);
          state.cash = round2(state.cash + order.qty * order.limitPrice - fee);
          const realized = round2(order.qty * order.limitPrice - fee - order.qty * hold.avgCost);
          sellHolding(state, order.code, order.qty);
          state.tradeStats.sellCount += 1;
          state.tradeStats.totalTrades += 1;
          state.tradeStats.totalFee += fee;
          state.tradeStats.realized[order.code] = round2(
            (state.tradeStats.realized[order.code] ?? 0) + realized,
          );
          if (realized > 0) state.tradeStats.winTrades += 1;
          recordTrade(state, "sell", order.code, order.qty, order.limitPrice, fee);
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

/** 结算触发天数（供 UI 显示） */
export function totalDays(): number {
  return TOTAL_DAYS;
}
