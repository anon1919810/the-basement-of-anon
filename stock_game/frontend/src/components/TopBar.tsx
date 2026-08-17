import { PlusCircle, RefreshCw } from "lucide-react";
import { TOTAL_DAYS } from "../game/stocks";
import { fmtMoney, fmtPct } from "../game/util";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  assets: number;
  ret: number;
  busy: boolean;
  onNextDay: () => void;
  onNewGame: () => void;
}

export default function TopBar({ state, assets, ret, busy, onNextDay, onNewGame }: Props) {
  const retCls = ret >= 0 ? "up" : "down";
  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="logo">覆巢之下</span>
        <span className="sub">股市模拟 · v0.0.0</span>
      </div>
      <div className="topbar-day">
        第 <b>{state.day}</b> / {TOTAL_DAYS} 天
      </div>
      <div className="topbar-assets">
        总资产 <b className="num">{fmtMoney(assets)}</b>
        <span className={`pct ${retCls}`}>{fmtPct(ret)}</span>
      </div>
      <div className="topbar-actions">
        <button
          className="btn primary"
          onClick={onNextDay}
          disabled={busy || state.phase === "settled"}
        >
          <RefreshCw size={14} />
          {busy ? "生成中…" : "下一日"}
        </button>
        <button className="btn" onClick={onNewGame}>
          <PlusCircle size={14} />
          新游戏
        </button>
      </div>
    </header>
  );
}
