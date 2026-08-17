import type { GameState } from "../game/types";

interface Props {
  state: GameState;
}

export default function NewsFeed({ state }: Props) {
  const items = [...state.news].sort((a, b) => b.day - a.day).slice(0, 50);
  return (
    <div className="panel-inner">
      <h2 className="panel-title">新闻</h2>
      {items.length === 0 ? (
        <div className="empty">暂无新闻，点击「下一日」推进交易日生成市场新闻</div>
      ) : (
        <ul className="news-list">
          {items.map((n) => {
            const isUp = !n.impactRange.trim().startsWith("-");
            return (
              <li key={n.id} className={`news-item ${n.kind === "macro" ? "news-macro" : ""}`}>
                <div className="news-head">
                  <span className="news-day">第{n.day}天</span>
                  {n.kind === "macro" && <span className="news-macro-tag">宏观</span>}
                  <span className={`news-impact ${isUp ? "up" : "down"}`}>
                    {n.impactStock} {n.impactRange} · 持续{n.duration}天
                  </span>
                  <span className="news-src">
                    {n.source === "ai" ? "AI生成" : n.source === "macro" ? "宏观事件" : "模板"}
                  </span>
                </div>
                <div className="news-title">{n.title}</div>
                <div className="news-summary">{n.summary}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
