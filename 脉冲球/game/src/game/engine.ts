// 引擎入口：跑整场（三节 + 节末金球加时 + 点球大战）→ 事件流 / 比分 / 胜者
import { createDefaultTeams, type Team } from './teams';
import {
  initMatch, tickMatch, runShootout, pushEvent,
  PERIOD_LEN, OT_LEN,
  type MatchEvent, type MatchState, type ShootoutResult, type MatchStats,
} from './match';

export interface PeriodSummary {
  name: string;
  score: [number, number];
  overtime?: string;
}

export interface MatchResult {
  seed: number;
  events: MatchEvent[];
  periods: PeriodSummary[];
  finalScore: [number, number];
  winner: 0 | 1 | null;
  shootout: ShootoutResult | null;
  stats: MatchStats;
  teams: [Team, Team];
}

const PERIOD_NAMES = ['上节', '中节', '下节'];

export function simulateMatch(seed: number, teams?: [Team, Team]): MatchResult {
  const tms = teams ?? createDefaultTeams(seed);
  const m: MatchState = initMatch(seed, tms);
  const periods: PeriodSummary[] = [];
  let winner: 0 | 1 | null = null;
  let shootout: ShootoutResult | null = null;

  for (let p = 0; p < 3 && winner === null; p++) {
    m.period = p;
    const end = m.clock + PERIOD_LEN;
    while (m.clock < end) tickMatch(m); // tickMatch 内部已 pushEvent 入列

    const score: [number, number] = [m.score[0], m.score[1]];
    const ps: PeriodSummary = { name: PERIOD_NAMES[p], score };
    periods.push(ps);
    pushEvent(m, 'period_end', `${PERIOD_NAMES[p]}结束，累计比分 ${m.score[0]} : ${m.score[1]}`, m.ball.x, m.ball.y, m.pulse, m.possession);

    // 节末累计比分平 → 立即 5 分钟金球加时
    if (m.score[0] === m.score[1]) {
      m.period = 3;
      m.goldenGoal = false;
      pushEvent(m, 'overtime_start', '累计比分平局！进入 5 分钟金球加时', 32.5, 20, 0, m.possession);
      const otEnd = m.clock + OT_LEN;
      while (m.clock < otEnd && !m.goldenGoal) tickMatch(m);
      if (m.goldenGoal) {
        winner = m.score[0] > m.score[1] ? 0 : 1;
        ps.overtime = '金球制胜';
        break;
      }
      if (p === 2) {
        // 下节加时仍平 → 点球大战
        shootout = runShootout(m);
        winner = shootout.winner;
        ps.overtime = '加时未决 → 点球大战';
        break;
      }
      ps.overtime = '加时平局，平局带入下节';
    }
  }

  if (winner === null) {
    winner = m.score[0] > m.score[1] ? 0 : m.score[0] < m.score[1] ? 1 : null;
  }

  return {
    seed,
    events: m.events,
    periods,
    finalScore: [m.score[0], m.score[1]],
    winner,
    shootout,
    stats: m.stats,
    teams: tms,
  };
}
