import { Trophy } from "lucide-react";
import { fmtMoney, fmtPct } from "../game/util";
import type { GameState } from "../game/types";
import type { RankRow } from "../game/engine";

interface Props {
  state: GameState;
  playerAssets: number;
  playerRet: number;
  ranking: RankRow[];
  onNewGame: () => void;
}

function medal(i: number): string {
  if (i === 0) return "🥇";
  if (i === 1) return "🥈";
  if (i === 2) return "🥉";
  return `${i + 1}`;
}

export default function SettlementModal({ state, playerAssets, playerRet, ranking, onNewGame }: Props) {
  const playerRank = ranking.findIndex((r) => r.isPlayer) + 1;
  return (
    <div className="modal-mask">
      <div className="modal">
        <h2 className="modal-title">
          <Trophy size={18} /> 结算 · {state.day} 个交易日结束
        </h2>
        <div className="settle-summary">
          <div>
            总资产 <b className="num">{fmtMoney(playerAssets)}</b>
          </div>
          <div>
            总收益率{" "}
            <b className={`num ${playerRet >= 0 ? "up" : "down"}`}>{fmtPct(playerRet)}</b>
          </div>
          <div>
            最终排名 <b>第 {playerRank} 名</b> / {ranking.length}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>名次</th>
              <th>选手</th>
              <th className="num">总资产</th>
              <th className="num">收益率</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((r, i) => (
              <tr key={r.name} className={r.isPlayer ? "row-player" : ""}>
                <td>{medal(i)}</td>
                <td>{r.name}</td>
                <td className="num">{fmtMoney(r.assets)}</td>
                <td className={`num ${r.ret >= 0 ? "up" : "down"}`}>{fmtPct(r.ret)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="btn primary" onClick={onNewGame}>
            重新开始
          </button>
        </div>
      </div>
    </div>
  );
}
