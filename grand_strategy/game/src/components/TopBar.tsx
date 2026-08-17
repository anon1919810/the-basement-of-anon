import type { GameState } from '../game/state';
import type { NationId, Speed } from '../game/types';
import { NATIONS, NATION_LIST } from '../game/nations';
import { SPEED_LABEL, dateLabel } from '../game/clock';
import { weightedTaxRate } from '../game/tax';
import { Pencil } from 'lucide-react';

interface Props {
  game: GameState;
  onSpeed: (s: Speed) => void;
  onNation: (id: NationId) => void;
  onSave: () => void;
  onNewGame: () => void;
  /** v0.6 独立编辑模式 */
  editMode: boolean;
  onToggleEdit: () => void;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

export default function TopBar({ game, onSpeed, onNation, onSave, onNewGame, editMode, onToggleEdit }: Props) {
  const n = game.nations[game.playerNation];
  const def = NATIONS[game.playerNation];
  const taxPct = weightedTaxRate(n.tax) * 100;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">《卡尔特》</span>
        <span className="brand-sub">v0.6.0 八国可玩 · 循环地图 · 视图切换 · 国界编辑器</span>
      </div>

      <div className="tb-clock">
        <div className="tb-date">{dateLabel(game.day)}</div>
        <div className="tb-speed">
          {([0, 1, 2, 3] as Speed[]).map((s) => (
            <button
              key={s}
              className={`tb-btn ${game.speed === s ? 'active' : ''}`}
              onClick={() => onSpeed(s)}
              disabled={editMode}
              title={editMode ? '编辑模式中时钟暂停' : s === 0 ? '暂停' : `${s} 倍速`}
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
        <span className="stat">
          健康 <b>{(n.health * 100).toFixed(0)}%</b>
        </span>
      </div>

      <div className="tb-right">
        <button
          className={`tb-btn edit-mode-btn ${editMode ? 'active' : ''}`}
          onClick={onToggleEdit}
          title={editMode ? '退出编辑模式（恢复游戏时钟）' : '进入编辑模式（游戏暂停，点击省份改属）'}
        >
          <Pencil size={12} />
          {editMode ? '编辑中·退出' : '编辑模式'}
        </button>
        <label className="tb-nation">
          扮演
          <select
            value={game.playerNation}
            onChange={(e) => onNation(e.target.value as NationId)}
            disabled={editMode}
            title={editMode ? '编辑模式下不可切换国家' : '切换扮演国家'}
          >
            {NATION_LIST.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button className="tb-btn" onClick={onSave} title="手动存档" disabled={editMode}>
          存档
        </button>
        <button className="tb-btn" onClick={onNewGame} title="开始新游戏" disabled={editMode}>
          新游戏
        </button>
      </div>

      <div className="tb-tax" title="综合税负 = 五税种均值×0.7 + 商品税均值×0.3（0%-30% 连续滑块）">
        综合税负 {taxPct.toFixed(1)}%
      </div>
      <span className="tb-nation-info">{def.name} · {def.gov}</span>
      <span className="tb-shortcut">空格=暂停 · 1/2/3=速度 · S=存档 · N=新游戏</span>
    </header>
  );
}
