import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, TrendingDown, Undo2 } from "lucide-react";
import { feeOf } from "../game/state";
import { borrowableOf, availableCash, forceClosePrice } from "../game/short";
import { fmtMoney, fmtPct, lastBar } from "../game/util";
import type { GameState, OrderKind, OrderSide } from "../game/types";

export interface TradeResult {
  ok: boolean;
  message: string;
}

interface Props {
  state: GameState;
  code: string;
  onTrade: (
    side: OrderSide,
    kind: OrderKind,
    qty: number,
    limitPrice?: number,
  ) => TradeResult;
  onCancelOrder: (id: string) => void;
}

const SIDES: { id: OrderSide; label: string; icon: "buy" | "sell" | "short" | "cover" }[] = [
  { id: "buy", label: "买入", icon: "buy" },
  { id: "sell", label: "卖出", icon: "sell" },
  { id: "short", label: "做空", icon: "short" },
  { id: "cover", label: "平空", icon: "cover" },
];

export default function TradePanel({ state, code, onTrade, onCancelOrder }: Props) {
  const [side, setSide] = useState<OrderSide>("buy");
  const [kind, setKind] = useState<OrderKind>("market");
  const [qtyStr, setQtyStr] = useState("100");
  const [limitStr, setLimitStr] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const market = state.market[code];
  const index = state.indices[code];
  const isIndex = !market && !!index;
  const def = market?.def;
  const isStock = def?.kind === "stock";
  const bar = market ? lastBar(market) : null;
  const price = bar ? bar.close : 0;
  const hold = state.holdings.find((h) => h.code === code);
  const sellable = hold ? hold.sellable : 0;
  const shortPos = state.shorts.find((p) => p.code === code);
  const availCash = availableCash(state);

  const qty = parseInt(qtyStr, 10);
  const limit = parseFloat(limitStr);
  const validQty = Number.isInteger(qty) && qty > 0;
  const fee = validQty && price > 0 ? feeOf(state.params, qty, price) : 0;
  const amount = validQty ? qty * price : 0;
  const margin = validQty && price > 0 ? qty * price * state.params.shortMarginRate : 0;
  const borrowable = def ? borrowableOf(state, code) : 0;
  const shortPnl = shortPos ? (shortPos.avgPrice - price) * shortPos.qty : 0;

  const atLimitUp = bar ? bar.changePct >= state.params.limitPct - 1e-9 : false;
  const atLimitDown = bar ? bar.changePct <= -state.params.limitPct + 1e-9 : false;

  const shortUnavailable = !isStock && !isIndex;

  const submit = () => {
    if (!validQty) {
      setNotice("请输入有效的正整数数量");
      return;
    }
    if (kind === "limit" && !(limit > 0)) {
      setNotice("请输入有效的限价");
      return;
    }
    const res = onTrade(side, kind, qty, kind === "limit" ? limit : undefined);
    setNotice(res.message);
  };

  return (
    <div className="panel-inner trade-panel">
      <h2 className="panel-title">交易 · {def ? def.name : index ? index.def.name : code}</h2>

      <div className="quote-row">
        <span className={`price ${bar && bar.changePct >= 0 ? "up" : "down"}`}>
          {bar ? price.toFixed(2) : "-"}
        </span>
        <span className={`pct ${bar && bar.changePct >= 0 ? "up" : "down"}`}>
          {bar ? fmtPct(bar.changePct) : "-"}
        </span>
      </div>
      <div className="quote-meta">
        可用资金 <b>{fmtMoney(availCash)}</b>
        {hold ? `　多头 ${hold.qty}（可卖 ${sellable}）` : ""}
        {shortPos ? `　空头 ${shortPos.qty} 股` : ""}
        {atLimitUp ? "　⚠ 今日涨停" : ""}
        {atLimitDown ? "　⚠ 今日跌停" : ""}
      </div>

      {isIndex ? (
        <div className="notice">指数为市场温度计与业绩基准，不可直接交易。</div>
      ) : (
        <>
          <div className="seg seg-4">
            {SIDES.map((s) => {
              const disabled = (s.id === "short" || s.id === "cover") && shortUnavailable;
              const Icon =
                s.icon === "buy"
                  ? ArrowDownToLine
                  : s.icon === "sell"
                    ? ArrowUpFromLine
                    : s.icon === "short"
                      ? TrendingDown
                      : Undo2;
              return (
                <button
                  key={s.id}
                  className={`seg-btn ${side === s.id ? `active ${s.id}` : ""}`}
                  onClick={() => {
                    setSide(s.id);
                    if (s.id === "short" || s.id === "cover") setKind("market");
                  }}
                  disabled={disabled}
                  title={disabled ? "仅股票支持做空" : ""}
                >
                  <Icon size={13} /> {s.label}
                </button>
              );
            })}
          </div>

          {(side === "buy" || side === "sell") && (
            <div className="seg">
              <button
                className={`seg-btn ${kind === "market" ? "active" : ""}`}
                onClick={() => setKind("market")}
              >
                市价
              </button>
              <button
                className={`seg-btn ${kind === "limit" ? "active" : ""}`}
                onClick={() => setKind("limit")}
              >
                限价
              </button>
            </div>
          )}

          <label className="field">
            <span>数量（股）</span>
            <input
              type="number"
              min={1}
              step={100}
              value={qtyStr}
              onChange={(e) => setQtyStr(e.target.value)}
            />
          </label>

          {kind === "limit" && (side === "buy" || side === "sell") && (
            <label className="field">
              <span>限价</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                placeholder={price > 0 ? price.toFixed(2) : "0.00"}
                value={limitStr}
                onChange={(e) => setLimitStr(e.target.value)}
              />
            </label>
          )}

          <div className="trade-info">
            {side === "buy" && (
              <>
                <div>预估金额：{validQty ? amount.toFixed(2) : "-"}</div>
                <div>手续费：{fee}（双向 {fmtPct(state.params.feeRate)}，最低 {state.params.minFee}）</div>
                <div className="t1">T+1：当日买入，次日方可卖出</div>
              </>
            )}
            {side === "sell" && (
              <>
                <div>预估收入：{validQty ? (amount - fee).toFixed(2) : "-"}</div>
                <div>手续费：{fee}（双向 {fmtPct(state.params.feeRate)}）</div>
                <div className="t1">T+1：当日买入的仓位次日方可卖出</div>
              </>
            )}
            {side === "short" && (
              <>
                <div>借券卖空：收入 {validQty ? amount.toFixed(2) : "-"} 计入现金</div>
                <div>
                  冻结保证金：{margin.toFixed(2)}（{fmtPct(state.params.shortMarginRate)}）
                </div>
                <div>可借余量：{borrowable.toLocaleString()} 股</div>
                <div>借券费：{fmtPct(state.params.borrowFeeRate)}/日 · 强平线：浮亏达保证金 {fmtPct(state.params.forceCloseLine)}</div>
                <div className="t1">做空 T+1：当日开仓次日方可平仓</div>
              </>
            )}
            {side === "cover" && (
              <>
                {shortPos ? (
                  <>
                    <div>空头持仓：{shortPos.qty} 股 @ {shortPos.avgPrice.toFixed(2)}</div>
                    <div>浮动盈亏：<b className={shortPnl >= 0 ? "up" : "down"}>{fmtMoney(shortPnl)}</b></div>
                    <div>强平价：{forceClosePrice(state, shortPos).toFixed(2)}</div>
                    <div className="t1">平仓买回金额：{validQty ? (amount + fee).toFixed(2) : "-"}（含手续费）</div>
                  </>
                ) : (
                  <div>该标的无空头持仓</div>
                )}
              </>
            )}
            {kind === "limit" && side !== "short" && side !== "cover" && (
              <div className="t1">限价单于下一交易日撮合，未达价则继续挂单</div>
            )}
          </div>

          <button
            className={`btn trade-submit ${side}`}
            onClick={submit}
            disabled={state.phase === "settled" || (side === "cover" && !shortPos)}
          >
            {side === "buy" ? "买入" : side === "sell" ? "卖出" : side === "short" ? "做空" : "平空"}
          </button>

          {notice && <div className="notice">{notice}</div>}
        </>
      )}

      {state.orders.length > 0 && (
        <div className="pending-orders">
          <h3>待撮合限价单</h3>
          {state.orders.map((o) => (
            <div key={o.id} className="order-row">
              <span>
                {o.side === "buy" ? "买" : "卖"} {state.market[o.code]?.def.name ?? o.code} {o.qty}股 @{" "}
                {o.limitPrice.toFixed(2)}
              </span>
              <button className="btn small" onClick={() => onCancelOrder(o.id)}>
                撤单
              </button>
            </div>
          ))}
        </div>
      )}

      {state.messages.length > 0 && (
        <div className="action-log">
          <h3>操作日志</h3>
          {state.messages.slice(-5).reverse().map((msg, i) => (
            <div key={`${msg}_${i}`} className="log-line">
              {msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
