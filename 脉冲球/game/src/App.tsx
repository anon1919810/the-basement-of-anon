// 主界面：选择阵型 → 开始比赛 → 回放视图 + 赛后小结（极简白底细线绿强调）
import { useMemo, useState } from 'react';
import { simulateMatch, type MatchResult } from './game/engine';
import { createDefaultTeams, FORMATIONS, type FormationName } from './game/teams';
import type { MatchEvent } from './game/match';
import type { Team } from './game/teams';
import MatchView, { fmtTime } from './components/MatchView';

function SummaryPanel({ match, goals, a, b }: { match: MatchResult; goals: MatchEvent[]; a: Team; b: Team }) {
  const winnerText = match.winner === null ? '平局' : `${match.teams[match.winner].name} 获胜`;
  return (
    <section className="summary">
      <h2>赛后小结</h2>
      <div className="final">
        {a.name} {match.finalScore[0]} : {match.finalScore[1]} {b.name}
        <strong> — {winnerText}</strong>
      </div>
      <div className="periods">
        {match.periods.map((p) => (
          <span key={p.name}>
            {p.name} {p.score[0]}:{p.score[1]}
            {p.overtime ? `（${p.overtime}）` : ''}
          </span>
        ))}
        {match.shootout && <span className="so">点球大战 {match.shootout.score[0]} : {match.shootout.score[1]}（{match.shootout.kicks.length} 罚）</span>}
      </div>
      <div className="stats">
        <table>
          <thead>
            <tr><th></th><th>{a.name}</th><th>{b.name}</th></tr>
          </thead>
          <tbody>
            <tr><td>射门</td><td>{match.stats.shots[0]}</td><td>{match.stats.shots[1]}</td></tr>
            <tr><td>成功传球</td><td>{match.stats.passes[0]}</td><td>{match.stats.passes[1]}</td></tr>
            <tr><td>犯规</td><td>{match.stats.fouls[0]}</td><td>{match.stats.fouls[1]}</td></tr>
          </tbody>
        </table>
        <div className="pulse-stat">
          全场最高脉冲：<strong>{match.stats.maxPulse}</strong>
          <span>（0~1 灰 / 2 蓝 / 3 绿 / 4 黄 / 5 红）</span>
        </div>
      </div>
      <h3>进球列表（{goals.length}）</h3>
      <ul className="goals">
        {goals.map((g, i) => (
          <li key={i}><b>{fmtTime(g.t)}</b> {g.desc}</li>
        ))}
      </ul>
    </section>
  );
}

export default function App() {
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [seed, setSeed] = useState<number>(42);
  const [formation, setFormation] = useState<FormationName>('平衡');

  const start = () => {
    const s = Math.floor(Math.random() * 2 ** 31);
    setSeed(s);
    setMatch(simulateMatch(s, createDefaultTeams(s, FORMATIONS[formation])));
  };

  const summary = useMemo(() => {
    if (!match) return null;
    const goals = match.events.filter((e) => e.type === 'goal' || e.type === 'penalty_goal' || e.type === 'shootout_goal');
    return { goals, a: match.teams[0], b: match.teams[1] };
  }, [match]);

  return (
    <div className="app">
      <header>
        <h1>脉冲球 <span>PULSE BALL · v0.1.1</span></h1>
        <p className="tagline">确定性引擎 · 位置四类 + 阵型选择 · Rapier 物理 · 9v9 · 三节净时 + 金球加时 + 点球大战</p>
      </header>

      {!match && (
        <div className="start">
          <div className="formation-pick">
            <span>阵型</span>
            <select
              className="btn"
              value={formation}
              onChange={(e) => setFormation(e.target.value as FormationName)}
            >
              {Object.entries(FORMATIONS).map(([n, f]) => (
                <option key={n} value={n}>
                  {n}（{f.filter((p) => p === 'DF').length}-{f.filter((p) => p === 'MF').length}-{f.filter((p) => p === 'FW').length}）
                </option>
              ))}
            </select>
            <span className="muted">1 门将 + 8 场上 · 两队同阵型</span>
          </div>
          <button className="btn primary big" onClick={start}>开始比赛</button>
          <p>点击后以随机种子模拟一场完整比赛，随后进入回放。引擎由 mulberry32 保证同种子同结果。</p>
        </div>
      )}

      {match && (
        <>
          <div className="replay-head">
            <button className="btn primary" onClick={start}>再踢一场（新种子）</button>
            <span className="seed">种子：{seed}</span>
          </div>
          <MatchView result={match} />
          {summary && <SummaryPanel match={match} goals={summary.goals} a={summary.a} b={summary.b} />}
        </>
      )}

      <footer>脉冲球 · 原型 v0.1.1 · 端明ちゃん 定方向 · 引擎确定性由 mulberry32 保证</footer>
    </div>
  );
}
