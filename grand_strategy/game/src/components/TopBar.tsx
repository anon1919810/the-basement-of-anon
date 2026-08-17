import type { GameState } from '../game/state';
import type { NationId, Speed } from '../game/types';
import { NATIONS, NATION_LIST } from '../game/nations';
import { SPEED_LABEL, dateLabel } from '../game/clock';
import { TAX_RATES } from '../game/economy';

interface Props {
  game: GameState;
  onSpeed: (s: Speed) => void;
  onNation: (id: NationId) => void;
  onSave: () => void;
  onNewGame: () => void;
  onOpenQueue: () => void;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

export default function TopBar({ game, onSpeed, onNation, onSave, onNewGame, onOpenQueue }: Props) {
  const n = game.nations[game.playerNation];
  const def = NATIONS[game.playerNation];
  const queued = game.eventQueue.length;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">《卡尔特》</span>
        <span className="brand-sub">v0.0.0 可玩原型</span>
      </div>

      <div className="tb-clock">
        <div className="tb-date">{dateLabel(game.day)}</div>
        <div className="tb-speed">
          {([0, 1, 2, 3] as Speed[]).map((s) => (
            <button
              key={s}
              className={`tb-btn ${game.speed === s ? 'active' : ''}`}
              onClick={() => onSpeed(s)}
              title={s === 0 ? '暂停' : `${s} 倍速`}
            >
              {SPEED_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="tb-stats">
        <span className="stat">
          <i className="dot dot-green" />
          国库 <b>{fmt(n.treasury)}</b> 万₭
        </span>
        <span className="stat">
          <i className="dot dot-gold" />
          粮食 <b>{fmt(n.foodStock)}</b> 万吨
        </span>
        <span className="stat">
          <i className="dot dot-blue" />
          稳定度 <b>{Math.round(n.stability)}</b>
        </span>
        <span className="stat">
          人口 <b>{fmt(n.popWan)}</b> 万
        </span>
        <span className="stat">
          识字率 <b>{(n.literacy * 100).toFixed(1)}%</b>
        </span>
      </div>

      <div className="tb-right">
        {queued > 0 && game.speed > 0 && (
          <button className="tb-btn queue-btn" onClick={onOpenQueue} title="稍后处理的事件">
            事件 ×{queued}（待处理）
          </button>
        )}
        <label className="tb-nation">
          扮演
          <select
            value={game.playerNation}
            onChange={(e) => onNation(e.target.value as NationId)}
          >
            {NATION_LIST.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button className="tb-btn" onClick={onSave} title="手动存档">
          存档
        </button>
        <button className="tb-btn" onClick={onNewGame} title="开始新游戏">
          新游戏
        </button>
      </div>

      <div className="tb-tax" title="当前税率档">
        税率：{TAX_RATES[n.taxLevel].label}
      </div>
      <span className="tb-nation-info">{def.name} · {def.gov}</span>
    </header>
  );
}
