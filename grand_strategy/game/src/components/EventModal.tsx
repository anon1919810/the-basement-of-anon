import type { GameState } from '../game/state';

interface Props {
  game: GameState;
  onChoose: (optionIndex: number) => void;
  onDefer: () => void;
}

export default function EventModal({ game, onChoose, onDefer }: Props) {
  const ev = game.eventQueue[0];
  // 仅当游戏暂停（事件卡弹出自动暂停）时显示；「稍后处理」后事件留在队列、游戏继续
  if (!ev || game.speed !== 0) return null;
  return (
    <div className="modal-overlay">
      <div className="event-card">
        <div className="event-head">
          <span className="event-tag">大事记</span>
          <h3>{ev.title}</h3>
        </div>
        <p className="event-text">{ev.text}</p>
        <div className="event-options">
          {ev.options.map((opt, i) => (
            <button key={i} className="event-opt" onClick={() => onChoose(i)}>
              <span className="opt-label">{opt.label}</span>
              {opt.hint && <span className="opt-hint">{opt.hint}</span>}
            </button>
          ))}
        </div>
        <button className="event-defer" onClick={onDefer}>
          稍后处理（暂不抉择，继续推演）
        </button>
      </div>
    </div>
  );
}
