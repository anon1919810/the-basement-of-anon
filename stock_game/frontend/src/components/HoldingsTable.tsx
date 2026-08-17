import { fmtMoney, fmtPct, lastClose } from "../game/util";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  onSelect: (code: string) => void;
}

export default function HoldingsTable({ state, onSelect }: Props) {
  const rows = state.holdings.map((h) => {
    const market = state.market[h.code];
    const name = market ? market.def.name : h.code;
    const price = market ? lastClose(market) : 0;
    const mv = h.qty * price;
    const pnl = (price - h.avgCost) * h.qty;
    const pnlPct = h.avgCost > 0 ? price / h.avgCost - 1 : 0;
    return { ...h, name, price, mv, pnl, pnlPct };
  });

  return (
    <div className="panel-inner">
      <h2 className="panel-title">持仓</h2>
      {rows.length === 0 ? (
        <div className="empty">暂无持仓，在右侧交易面板选择股票进行买卖</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th className="num">持仓</th>
              <th className="num">可卖</th>
              <th className="num">成本</th>
              <th className="num">现价</th>
              <th className="num">市值</th>
              <th className="num">浮动盈亏</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} onClick={() => onSelect(r.code)}>
                <td>
                  <div className="stock-name">{r.name}</div>
                  <div className="stock-code">{r.code}</div>
                </td>
                <td className="num">{r.qty}</td>
                <td className="num">{r.sellable}</td>
                <td className="num">{r.avgCost.toFixed(2)}</td>
                <td className="num">{r.price.toFixed(2)}</td>
                <td className="num">{fmtMoney(r.mv)}</td>
                <td className={`num ${r.pnl >= 0 ? "up" : "down"}`}>
                  {fmtMoney(r.pnl)}（{fmtPct(r.pnlPct)}）
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
