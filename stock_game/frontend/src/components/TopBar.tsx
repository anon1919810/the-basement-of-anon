import { PlusCircle, RefreshCw, Settings } from "lucide-react";
import { totalDays } from "../game/state";
import { macroStatusText } from "../game/macro";
import { fmtMoney, fmtPct } from "../game/util";
import type { GameState } from "../game/types";

interface Props {
  state: GameState;
  assets: number;
  ret: number;
  busy: boolean;
  onNextDay: () => void;
  onNewGame: () => void;
  onOpenTuning: () => void;
}

export default function TopBar({ state, assets, ret, busy, onNextDay, onNewGame, onOpenTuning }: Props) {
  const retCls = ret >= 0 ? "up" : "down";
  const macro = macroStatusText(state);
  const prevAssets = state.playerHistory[state.playerHistory.length - 2]?.assets ?? assets;
  const todayPnl = state.day > 0 ? assets - prevAssets : 0;
  const cashShare = assets > 0 ? state.cash / assets : 0;
  const inCrisis = state.macro.crisisRemaining > 0;
  const rateCls = state.macro.rate === "loose" ? "macro-loose" : state.macro.rate === "tight" ? "macro-tight" : "macro-neutral";
  const infCls = state.macro.inflation === "high" ? "macro-tight" : state.macro.inflation === "low" ? "macro-loose" : "macro-neutral";

  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="logo">覆巢之下</span>
        <span className="sub">股市模拟 · v0.1.0 深度版</span>
      </div>
      <div className="topbar-day">
        第 <b>{state.day}</b> / {totalDays()} 天
      </div>
      <div className="topbar-macro">
        <span className={`macro-chip ${rateCls}`}>利率 {macro.rate}</span>
        <span className={`macro-chip ${infCls}`}>通胀 {macro.inflation}</span>
        {inCrisis && <span className="macro-chip macro-crisis">⚠ 流动性危机</span>}
      </div>
      <div className="topbar-assets">
        <span>
          总资产 <b className="num">{fmtMoney(assets)}</b>
          <span className={`pct ${retCls}`}>{fmtPct(ret)}</span>
        </span>
        <span className="topbar-today">
          今日 <b className={todayPnl >= 0 ? "up" : "down"}>{todayPnl >= 0 ? "+" : ""}{fmtMoney(todayPnl)}</b>
        </span>
        <span className="topbar-cash">
          现金占比 <b>{fmtPct(cashShare)}</b>
        </span>
      </div>
      <div className="topbar-actions">
        <button className="btn" onClick={onOpenTuning} disabled={state.phase === "settled"}>
          <Settings size={14} />
          调参
        </button>
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
