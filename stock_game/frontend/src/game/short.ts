// 做空机制：借券卖空 / 保证金 / 强平 / 借券费 / 可借余量

import { canShort } from "./assets";
import { currentPrice, feeOf, pushMessage, recordTrade } from "./state";
import { round2 } from "./util";
import type { GameState, ShortPosition } from "./types";

export interface TradeResult {
  ok: boolean;
  message: string;
}

/** 某股可借余量 = 上限 - 玩家已借入 */
export function borrowableOf(state: GameState, code: string): number {
  const def = state.market[code]?.def;
  if (!def || def.kind !== "stock") return 0;
  return Math.max(0, def.borrowLimit - (state.borrowed[code] ?? 0));
}

/** 玩家可用现金（扣除冻结保证金） */
export function availableCash(state: GameState): number {
  return state.cash - state.marginReserved;
}

/** 某空头仓位的浮亏（正数 = 亏损） */
export function shortLoss(pos: ShortPosition, price: number): number {
  return Math.max(0, (price - pos.avgPrice) * pos.qty);
}

/** 强平价：浮亏达保证金×强平线时的价格 = avgPrice × (1 + 保证金率 × 强平线) */
export function forceClosePrice(state: GameState, pos: ShortPosition): number {
  return pos.avgPrice * (1 + state.params.shortMarginRate * state.params.forceCloseLine);
}

/** 做空开仓（仅股票，市价）：可借余量 / 保证金 / 现金校验 */
export function openShort(state: GameState, code: string, qty: number): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知资产代码" };
  const def = m.def;
  if (!canShort(def)) return { ok: false, message: "债券/商品暂不支持做空" };
  const bar = m.history[m.history.length - 1];
  const price = bar.close;
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: "数量必须是正整数" };
  if (bar.changePct <= -state.params.limitPct + 1e-9)
    return { ok: false, message: "该股今日跌停，无法借券做空" };

  const avail = borrowableOf(state, code);
  if (avail <= 0) return { ok: false, message: "该股可借余量为 0，无法做空" };
  if (qty > avail) return { ok: false, message: `可借余量不足：仅剩 ${avail} 股可借` };

  const margin = round2(qty * price * state.params.shortMarginRate);
  const fee = feeOf(state.params, qty, price);
  const need = margin + fee;
  if (availableCash(state) < need)
    return {
      ok: false,
      message: `保证金不足：需冻结 ${margin.toFixed(2)} + 手续费 ${fee}，可用 ${availableCash(state).toFixed(2)}`,
    };
  // 杠杆上限：总冻结保证金 ≤ 2× 初始资金（保证极端行情强平后现金仍非负）
  const maxMargin = state.initialCash * 2;
  if (state.marginReserved + margin > maxMargin)
    return {
      ok: false,
      message: `做空杠杆超限：总保证金上限 ${maxMargin.toFixed(2)}，当前 ${state.marginReserved.toFixed(2)} + ${margin.toFixed(2)}`,
    };

  // 卖空：收入计入现金，冻结保证金
  state.cash = round2(state.cash + qty * price - fee);
  state.marginReserved = round2(state.marginReserved + margin);
  state.borrowed[code] = (state.borrowed[code] ?? 0) + qty;
  state.shorts.push({ code, qty, avgPrice: price, margin, openDay: state.day });
  state.tradeStats.shortCount += 1;
  state.tradeStats.totalTrades += 1;
  state.tradeStats.totalFee += fee;
  recordTrade(state, "short", code, qty, price, fee, `保证金 ${margin.toFixed(2)}，T+1 后可平仓`);
  pushMessage(
    state,
    `做空 ${def.name} ${qty} 股 @ ${price.toFixed(2)}，冻结保证金 ${margin.toFixed(2)}，手续费 ${fee}`,
  );
  return { ok: true, message: `已做空 ${def.name} ${qty} 股 @ ${price.toFixed(2)}` };
}

/** 平空（市价）：T+1 校验 + 资金校验（可用现金 + 该仓保证金 ≥ 买回成本） */
export function coverShort(state: GameState, code: string, qty: number): TradeResult {
  const m = state.market[code];
  if (!m) return { ok: false, message: "未知资产代码" };
  const price = currentPrice(state, code);
  const pos = state.shorts.find((p) => p.code === code);
  if (!pos) return { ok: false, message: "该标的没有空头持仓" };
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: "数量必须是正整数" };
  if (state.day <= pos.openDay)
    return { ok: false, message: "做空 T+1：当日开仓次日才能平仓" };
  if (qty > pos.qty) return { ok: false, message: `平仓数量超过空头持仓 ${pos.qty} 股` };

  const fee = feeOf(state.params, qty, price);
  const cost = round2(qty * price + fee);
  // 平仓买回需现金支付（保证金本身仍在现金中，只是被冻结标记）
  if (state.cash < cost)
    return {
      ok: false,
      message: `资金不足：买回需 ${cost.toFixed(2)}，现金 ${state.cash.toFixed(2)}`,
    };

  state.cash = round2(state.cash - cost);
  const marginShare = round2((pos.margin / pos.qty) * qty);
  state.marginReserved = round2(state.marginReserved - marginShare);
  state.borrowed[code] = Math.max(0, (state.borrowed[code] ?? 0) - qty);
  pos.qty -= qty;
  pos.margin = round2(pos.margin - marginShare);
  if (pos.qty <= 0) state.shorts = state.shorts.filter((p) => p !== pos);

  // 已实现盈亏（含开仓手续费，平仓手续费计入总费用）
  const realized = round2(qty * pos.avgPrice - qty * price - fee);
  state.tradeStats.coverCount += 1;
  state.tradeStats.totalTrades += 1;
  state.tradeStats.totalFee += fee;
  state.tradeStats.realized[code] = round2((state.tradeStats.realized[code] ?? 0) + realized);
  if (realized > 0) state.tradeStats.winTrades += 1;
  recordTrade(state, "cover", code, qty, price, fee, `平空盈亏 ${realized >= 0 ? "+" : ""}${realized.toFixed(2)}`);
  pushMessage(
    state,
    `平空 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}，手续费 ${fee}${realized >= 0 ? "，盈利" : "，亏损"} ${Math.abs(realized).toFixed(2)}`,
  );
  return { ok: true, message: `已平空 ${m.def.name} ${qty} 股 @ ${price.toFixed(2)}` };
}

/** 每日借券费：0.02%/日 × 持仓市值，从现金扣（现金不足则按可用扣，保证现金非负） */
export function chargeBorrowFees(state: GameState): void {
  for (const pos of state.shorts) {
    const price = currentPrice(state, pos.code);
    const raw = round2(pos.qty * price * state.params.borrowFeeRate);
    const fee = Math.max(0, Math.min(raw, state.cash));
    if (fee <= 0) continue;
    state.cash = round2(state.cash - fee);
    state.tradeStats.totalFee += fee;
    recordTrade(state, "borrow_fee", pos.code, pos.qty, price, fee, `借券费 ${fee.toFixed(2)}`);
  }
}

/**
 * 强平检查：浮亏 ≥ 保证金 × 强平线 → 自动市价平仓买回。
 * 现金不足时按可用现金部分平仓（现金永不为负），剩余仓位次日继续检查。
 */
export function forceCloseShorts(state: GameState): string[] {
  const msgs: string[] = [];
  const survivors: ShortPosition[] = [];
  for (const pos of state.shorts) {
    const price = currentPrice(state, pos.code);
    const loss = shortLoss(pos, price);
    if (loss < pos.margin * state.params.forceCloseLine) {
      survivors.push(pos);
      continue;
    }
    // 现金可承受的平仓数量（预留 2% 手续费缓冲）
    const maxQty = Math.max(0, Math.floor((state.cash * 0.98) / price));
    const closeQty = Math.min(pos.qty, maxQty);
    if (closeQty <= 0) {
      survivors.push(pos);
      continue;
    }
    const fee = feeOf(state.params, closeQty, price);
    const cost = round2(closeQty * price + fee);
    state.cash = round2(state.cash - cost);
    const marginShare = round2((pos.margin / pos.qty) * closeQty);
    state.marginReserved = round2(state.marginReserved - marginShare);
    state.borrowed[pos.code] = Math.max(0, (state.borrowed[pos.code] ?? 0) - closeQty);
    pos.qty -= closeQty;
    pos.margin = round2(pos.margin - marginShare);
    const realized = round2(closeQty * pos.avgPrice - closeQty * price - fee);
    state.tradeStats.coverCount += 1;
    state.tradeStats.totalTrades += 1;
    state.tradeStats.totalFee += fee;
    state.tradeStats.realized[pos.code] = round2((state.tradeStats.realized[pos.code] ?? 0) + realized);
    if (realized > 0) state.tradeStats.winTrades += 1;
    const name = state.market[pos.code]?.def.name ?? pos.code;
    recordTrade(state, "force_cover", pos.code, closeQty, price, fee, "浮亏达强平线，自动平仓");
    const msg = `强平：${name} 空头 ${closeQty} 股 @ ${price.toFixed(2)}（浮亏达保证金 ${(state.params.forceCloseLine * 100).toFixed(0)}%）`;
    msgs.push(msg);
    pushMessage(state, msg);
    if (pos.qty > 0) survivors.push(pos);
  }
  state.shorts = survivors;
  return msgs;
}
