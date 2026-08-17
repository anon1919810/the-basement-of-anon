import { fmtMoney, fmtPct, lastClose } from "../game/util";
import { forceClosePrice } from "../game/short";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  onSelect: (code: string) => void;
}

export default function HoldingsTable({ state, onSelect }: Props) {
  const longRows = state.holdings.map((h) => {
    const market = state.market[h.code];
    const name = market ? market.def.name : h.code;
    const price = market ? lastClose(market) : 0;
    const mv = h.qty * price;
    const pnl = (price - h.avgCost) * h.qty;
    const pnlPct = h.avgCost > 0 ? price / h.avgCost - 1 : 0;
    return { code: h.code, name, qty: h.qty, sellable: h.sellable, avgCost: h.avgCost, price, mv, pnl, pnlPct };
  });

  const shortRows = state.shorts.map((s) => {
    const market = state.market[s.code];
    const name = market ? market.def.name : s.code;
    const price = market ? lastClose(market) : 0;
    const liab = s.qty * price;
    const pnl = (s.avgPrice - price) * s.qty;
    const pnlPct = s.avgPrice > 0 ? 1 - price / s.avgPrice : 0;
    return { code: s.code, name, qty: s.qty, avgPrice: s.avgPrice, price, liab, pnl, pnlPct, margin: s.margin, forcePrice: forceClosePrice(state, s) };
  });

  const totalShortPnl = shortRows.reduce((s, r) => s + r.pnl, 0);

  return (
    <div className="panel-inner">
      <h2 className="panel-title">持仓 · 多/空</h2>
      {longRows.length === 0 && shortRows.length === 0 ? (
        <div className="empty">暂无持仓，在右侧交易面板选择标的进行买卖/做空</div>
      ) : (
        <>
          {longRows.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>多头</th>
                  <th className="num">持仓</th>
                  <th className="num">可卖</th>
                  <th className="num">成本</th>
                  <th className="num">现价</th>
                  <th className="num">市值</th>
                  <th className="num">浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {longRows.map((r) => (
                  <tr key={`L_${r.code}`} onClick={() => onSelect(r.code)}>
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

          {shortRows.length > 0 && (
            <>
              <h3 className="sub-title">空头（保证金 {fmtMoney(state.marginReserved)}）</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>空头</th>
                    <th className="num">股数</th>
                    <th className="num">卖空均价</th>
                    <th className="num">现价</th>
                    <th className="num">负债市值</th>
                    <th className="num">保证金</th>
                    <th className="num">强平价</th>
                    <th className="num">浮动盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {shortRows.map((r) => (
                    <tr key={`S_${r.code}`} onClick={() => onSelect(r.code)}>
                      <td>
                        <div className="stock-name">{r.name}</div>
                        <div className="stock-code">{r.code}</div>
                      </td>
                      <td className="num">{r.qty}</td>
                      <td className="num">{r.avgPrice.toFixed(2)}</td>
                      <td className="num">{r.price.toFixed(2)}</td>
                      <td className="num">{fmtMoney(r.liab)}</td>
                      <td className="num">{fmtMoney(r.margin)}</td>
                      <td className="num">{r.forcePrice.toFixed(2)}</td>
                      <td className={`num ${r.pnl >= 0 ? "up" : "down"}`}>
                        {fmtMoney(r.pnl)}（{fmtPct(r.pnlPct)}）
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="short-total">
                空头合计浮盈 <b className={totalShortPnl >= 0 ? "up" : "down"}>{fmtMoney(totalShortPnl)}</b>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
