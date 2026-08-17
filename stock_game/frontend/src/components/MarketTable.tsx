import { STOCKS } from "../game/stocks";
import { BONDS, COMMODITIES, INDICES } from "../game/assets";
import { fmtPct, fmtVol, lastBar } from "../game/util";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  selectedCode: string;
  onSelect: (code: string) => void;
}

function rowCls(changePct: number | undefined): string {
  if (changePct === undefined) return "flat";
  if (changePct > 0) return "up";
  if (changePct < 0) return "down";
  return "flat";
}

export default function MarketTable({ state, selectedCode, onSelect }: Props) {
  const signals = [...state.signals].slice(-8).reverse();

  const renderRow = (code: string, name: string, sub: string, price: number | null, changePct: number | undefined, volume: number, tradeable: boolean, key: string) => {
    const cls = rowCls(changePct);
    return (
      <tr
        key={key}
        className={selectedCode === code ? "row-selected" : ""}
        onClick={() => onSelect(code)}
      >
        <td>
          <div className="stock-name">
            {name}
            {!tradeable && <span className="tag-index">指数</span>}
          </div>
          <div className="stock-code">{sub}</div>
        </td>
        <td className="num">{price !== null ? price.toFixed(2) : "-"}</td>
        <td className={`num ${cls}`}>{changePct !== undefined ? fmtPct(changePct) : "-"}</td>
        <td className="num">{volume > 0 ? fmtVol(volume) : "-"}</td>
      </tr>
    );
  };

  const assetPrice = (code: string) => {
    const m = state.market[code];
    return m ? lastBar(m) : null;
  };

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
            return renderRow(def.code, def.name, `${def.code} · ${def.sector}`, bar?.close ?? null, bar?.changePct, bar?.volume ?? 0, true, `s_${def.code}`);
          })}
          {[...BONDS, ...COMMODITIES].map((def) => {
            const bar = assetPrice(def.code);
            return renderRow(def.code, def.name, `${def.code} · ${def.kind === "bond" ? "债券" : "商品"}`, bar?.close ?? null, bar?.changePct, bar?.volume ?? 0, true, `a_${def.code}`);
          })}
          {INDICES.map((def) => {
            const im = state.indices[def.code];
            const bar = im?.history[im.history.length - 1];
            return renderRow(def.code, def.name, `${def.code} · 指数`, bar?.close ?? null, bar?.changePct, 0, false, `i_${def.code}`);
          })}
        </tbody>
      </table>

      {signals.length > 0 && (
        <div className="signals">
          <h3 className="signals-title">龙虎榜信号</h3>
          <ul className="signal-list">
            {signals.map((s, i) => (
              <li key={`${s.day}_${s.code}_${i}`} className={`signal-item signal-${s.kind}`}>
                <span className="signal-day">D{s.day}</span>
                <b>{s.name}</b> {s.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
