import { useMemo, useState } from "react";
import { STOCKS } from "../game/stocks";
import { BONDS, COMMODITIES, INDICES } from "../game/assets";
import { fmtMoney } from "../game/util";
import type { GameState, TradeAction } from "../game/types";

interface Props {
  state: GameState;
}

const ACTION_LABEL: Record<TradeAction, string> = {
  buy: "买入",
  sell: "卖出",
  short: "做空",
  cover: "平空",
  force_cover: "强平",
  borrow_fee: "借券费",
  dividend: "分红",
};

export default function TradeLog({ state }: Props) {
  const [filter, setFilter] = useState<string>("ALL");
  const codes = useMemo(
    () => [
      ...STOCKS.map((s) => s.code),
      ...BONDS.map((b) => b.code),
      ...COMMODITIES.map((c) => c.code),
      ...INDICES.map((i) => i.code),
    ],
    [],
  );

  const rows = useMemo(() => {
    const list = filter === "ALL" ? state.tradeLog : state.tradeLog.filter((t) => t.code === filter);
    return [...list].reverse().slice(0, 120);
  }, [state.tradeLog, filter]);

  return (
    <div className="panel-inner">
      <h2 className="panel-title">成交流水</h2>
      <div className="log-filter">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="ALL">全部标的</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {state.market[c]?.def.name ?? state.indices[c]?.def.name ?? c}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="empty">暂无成交记录</div>
      ) : (
        <div className="trade-log">
          {rows.map((t) => (
            <div key={t.id} className={`tlog-row tlog-${t.action}`}>
              <span className="tlog-day">D{t.day}</span>
              <span className="tlog-action">{ACTION_LABEL[t.action]}</span>
              <span className="tlog-name">{t.name}</span>
              <span className="tlog-qty">
                {t.action === "borrow_fee" ? "" : `${t.qty}股`}
              </span>
              <span className="tlog-price">
                {t.action === "borrow_fee" || t.action === "dividend" ? "" : `@${t.price.toFixed(2)}`}
              </span>
              <span className="tlog-amount">{fmtMoney(t.amount)}</span>
              <span className="tlog-fee">费{t.fee.toFixed(2)}</span>
              {t.note && <span className="tlog-note">{t.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
