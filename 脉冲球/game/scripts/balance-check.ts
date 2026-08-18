// 临时平衡抽查脚本
import { simulateMatch } from '../src/game/engine';

for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const r = simulateMatch(s);
  const g = r.events.filter((e) => e.type === 'goal' || e.type === 'penalty_goal').length;
  const ot = r.events.some((e) => e.period === 3);
  console.log(
    `seed ${String(s).padStart(2)}: ${r.teams[0].name} ${String(r.finalScore[0]).padStart(2)}:${String(r.finalScore[1]).padStart(2)} ${r.teams[1].name}` +
    ` | 事件${r.events.length} 射门${r.stats.shots[0] + r.stats.shots[1]} 进球${g} 犯规${r.stats.fouls[0] + r.stats.fouls[1]} 最高脉冲${r.stats.maxPulse}` +
    ` | 各节 ${r.periods.map((p) => `${p.name}${p.score[0]}:${p.score[1]}`).join(' ')}${ot ? ' 加时' : ''}${r.shootout ? ' 点球' : ''} | 胜者 ${r.winner !== null ? r.teams[r.winner].name : '无'}`,
  );
}
