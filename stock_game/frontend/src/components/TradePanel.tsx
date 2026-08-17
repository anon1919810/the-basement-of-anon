import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { feeOf } from "../game/state";
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

export default function TradePanel({ state, code, onTrade, onCancelOrder }: Props) {
  const [side, setSide] = useState<OrderSide>("buy");
  const [kind, setKind] = useState<OrderKind>("market");
  const [qtyStr, setQtyStr] = useState("100");
  const [limitStr, setLimitStr] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const market = state.market[code];
  const bar = market ? lastBar(market) : null;
  const price = bar ? bar.close : 0;
  const hold = state.holdings.find((h) => h.code === code);
  const sellable = hold ? hold.sellable : 0;

  const qty = parseInt(qtyStr, 10);
  const limit = parseFloat(limitStr);
  const validQty = Number.isInteger(qty) && qty > 0;
  const fee = validQty && price > 0 ? feeOf(qty, price) : 0;
  const amount = validQty ? qty * price : 0;

  const atLimitUp = bar ? bar.changePct >= 0.0999 : false;
  const atLimitDown = bar ? bar.changePct <= -0.0999 : false;

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
      <h2 className="panel-title">交易 · {market ? market.def.name : code}</h2>

      <div className="quote-row">
        <span className={`price ${bar && bar.changePct >= 0 ? "up" : "down"}`}>
          {bar ? price.toFixed(2) : "-"}
        </span>
        <span className={`pct ${bar && bar.changePct >= 0 ? "up" : "down"}`}>
          {bar ? fmtPct(bar.changePct) : "-"}
        </span>
      </div>
      <div className="quote-meta">
        可用资金 <b>{fmtMoney(state.cash)}</b>
        {hold ? `　持仓 ${hold.qty}（可卖 ${sellable}）` : ""}
        {atLimitUp ? "　⚠ 今日涨停" : ""}
        {atLimitDown ? "　⚠ 今日跌停" : ""}
      </div>

      <div className="seg">
        <button
          className={`seg-btn ${side === "buy" ? "active buy" : ""}`}
          onClick={() => setSide("buy")}
        >
          <ArrowDownToLine size={13} /> 买入
        </button>
        <button
          className={`seg-btn ${side === "sell" ? "active sell" : ""}`}
          onClick={() => setSide("sell")}
        >
          <ArrowUpFromLine size={13} /> 卖出
        </button>
      </div>

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

      {kind === "limit" && (
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
        <div>预估金额：{validQty ? amount.toFixed(2) : "-"}</div>
        <div>手续费：{fee}（双向 0.1%，最低 1）</div>
        <div className="t1">T+1：当日买入，次日方可卖出</div>
        {kind === "limit" && <div className="t1">限价单于下一交易日撮合，未达价则继续挂单</div>}
      </div>

      <button className={`btn trade-submit ${side}`} onClick={submit} disabled={state.phase === "settled"}>
        {side === "buy" ? "买入" : "卖出"}
      </button>

      {notice && <div className="notice">{notice}</div>}

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
          {state.messages.slice(-4).reverse().map((msg, i) => (
            <div key={`${msg}_${i}`} className="log-line">
              {msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
