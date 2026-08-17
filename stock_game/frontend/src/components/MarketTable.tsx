import { STOCKS } from "../game/stocks";
import { fmtPct, fmtVol, lastBar } from "../game/util";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  selectedCode: string;
  onSelect: (code: string) => void;
}

export default function MarketTable({ state, selectedCode, onSelect }: Props) {
  return (
    <div className="panel-inner">
      <h2 className="panel-title">行情</h2>
      <table className="table market-table">
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">最新</th>
            <th className="num">涨跌幅</th>
            <th className="num">量(手)</th>
          </tr>
        </thead>
        <tbody>
          {STOCKS.map((def) => {
            const m = state.market[def.code];
            const bar = m ? lastBar(m) : null;
            const cls = !bar
              ? "flat"
              : bar.changePct > 0
                ? "up"
                : bar.changePct < 0
                  ? "down"
                  : "flat";
            return (
              <tr
                key={def.code}
                className={selectedCode === def.code ? "row-selected" : ""}
                onClick={() => onSelect(def.code)}
              >
                <td>
                  <div className="stock-name">{def.name}</div>
                  <div className="stock-code">
                    {def.code} · {def.sector}
                  </div>
                </td>
                <td className="num">{bar ? bar.close.toFixed(2) : "-"}</td>
                <td className={`num ${cls}`}>{bar ? fmtPct(bar.changePct) : "-"}</td>
                <td className="num">{bar ? fmtVol(bar.volume) : "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
