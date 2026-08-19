// 比赛引擎核心：秒 tick 模拟 + 脉冲球规则落地
// 规则依据：规则-脉冲球v0.2.md
import type { RNG } from './rng';
import { mulberry32 } from './rng';
import type { Position } from './attributes';
import type { Player, Team } from './teams';

export const PERIOD_LEN = 1200; // 20 分钟净时（秒）
export const OT_LEN = 300;      // 5 分钟金球加时（秒）
export const FIELD_W = 65;
export const FIELD_H = 40;

export type EventType =
  | 'kickoff' | 'period_end' | 'overtime_start'
  | 'pass' | 'pass_ground' | 'control_fail' | 'dribble' | 'tackle'
  | 'shot' | 'goal' | 'foul' | 'penalty' | 'penalty_goal' | 'penalty_miss'
  | 'offside' | 'violation' | 'throwin' | 'yellow'
  | 'shootout_kick' | 'shootout_goal' | 'shootout_miss' | 'shootout_win';

export interface MatchEvent {
  t: number;          // 比赛时钟（秒）
  period: number;     // 0/1/2 上中下节，3 金球加时，4 点球大战
  x: number;
  y: number;
  type: EventType;
  desc: string;
  pulse: number;      // 事件后进攻方脉冲
  score: [number, number];
  team: 0 | 1;        // 事件后控球方
  player?: string;
}

export interface MatchStats {
  shots: [number, number];
  goals: [number, number];
  fouls: [number, number];
  passes: [number, number];
  maxPulse: number;
}

export interface ShootoutKick {
  team: 0 | 1;
  taker: string;
  made: boolean;
}

export interface ShootoutResult {
  kicks: ShootoutKick[];
  score: [number, number];
  winner: 0 | 1;
}

export interface MatchState {
  seed: number;
  rng: RNG;
  teams: [Team, Team];
  clock: number;
  period: number;
  possession: 0 | 1;
  possessor: number;       // 持球球员 id（队内索引）
  ball: { x: number; y: number };
  pulse: number;           // 当前进攻方脉冲 0-5
  possessTicks: number;    // 本次持球秒数（7 秒违例用）
  pairCounts: Map<string, number>; // 同组合累计（仅当前进攻回合）
  score: [number, number];
  events: MatchEvent[];
  teamFouls: [number, number];     // 每节累计犯规（第 6 犯 → 点球）
  yellowCards: number[][];         // 全场累计黄牌
  suspendedUntil: number[][];      // 离场结束时刻
  stats: MatchStats;
  goldenGoal: boolean;     // 加时金球已进
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

type TickKind = 'pass' | 'dribble' | 'shot' | 'foul';

function pickIndex(r: number, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let rr = r * total;
  for (let i = 0; i < weights.length; i++) {
    rr -= weights[i];
    if (rr < 0) return i;
  }
  return weights.length - 1;
}

function pickWeighted<T>(r: number, items: [T, number][]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let rr = r * total;
  for (const [v, w] of items) {
    rr -= w;
    if (rr < 0) return v;
  }
  return items[items.length - 1][0];
}

export function pushEvent(
  m: MatchState, type: EventType, desc: string,
  x: number, y: number, pulse: number, team: 0 | 1, player?: string,
): MatchEvent {
  const e: MatchEvent = {
    t: m.clock, period: m.period, x: r1(x), y: r1(y), type, desc,
    pulse, score: [m.score[0], m.score[1]], team, player,
  };
  m.events.push(e);
  if (pulse > m.stats.maxPulse) m.stats.maxPulse = pulse;
  return e;
}

// 球权转换：可指定接球人（拦截者），默认按空间感加权
function turnover(m: MatchState, teamIdx: 0 | 1, x: number, y: number, pulse: number, prefer?: Player): void {
  m.possession = teamIdx;
  const team = m.teams[teamIdx];
  const candidates = team.players
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => m.suspendedUntil[teamIdx][i] <= m.clock);
  const pick = prefer
    ? { p: prefer, i: prefer.id }
    : candidates[pickIndex(m.rng(), candidates.map(({ p }) => 1 + p.attrs.spatial / 80))];
  m.possessor = pick.i;
  m.ball = { x: clamp(x, 1, FIELD_W - 1), y: clamp(y, 1, FIELD_H - 1) };
  m.possessTicks = 0;
  m.pulse = pulse;
  m.pairCounts.clear();
}

// 中圈开球（失分方/随机首开）
function kickoff(m: MatchState, teamIdx: 0 | 1): void {
  m.possession = teamIdx;
  const team = m.teams[teamIdx];
  const weights = team.players.map((p, i) =>
    i === 0 || m.suspendedUntil[teamIdx][i] > m.clock ? 0 : 1 + p.attrs.spatial / 80);
  m.possessor = pickIndex(m.rng(), weights);
  m.ball = { x: FIELD_W / 2, y: FIELD_H / 2 };
  m.possessTicks = 0;
  m.pulse = 0;
  m.pairCounts.clear();
  pushEvent(m, 'kickoff', `${team.name} 中圈开球`, FIELD_W / 2, FIELD_H / 2, 0, teamIdx);
}

export function initMatch(seed: number, teams: [Team, Team]): MatchState {
  const rng = mulberry32(seed);
  const kickTeam: 0 | 1 = rng() < 0.5 ? 0 : 1;
  const zero = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const m: MatchState = {
    seed, rng, teams, clock: 0, period: 0,
    possession: kickTeam, possessor: 1,
    ball: { x: FIELD_W / 2, y: FIELD_H / 2 },
    pulse: 0, possessTicks: 0, pairCounts: new Map(),
    score: [0, 0], events: [],
    teamFouls: [0, 0],
    yellowCards: [zero.slice(), zero.slice()],
    suspendedUntil: [zero.slice(), zero.slice()],
    stats: { shots: [0, 0], goals: [0, 0], fouls: [0, 0], passes: [0, 0], maxPulse: 0 },
    goldenGoal: false,
  };
  kickoff(m, kickTeam);
  return m;
}

// 黄牌：第 2 张 → 离场 2 分钟，回场后清零重新累计
function maybeYellow(m: MatchState, teamIdx: 0 | 1, p: Player): void {
  const chance = 0.22 * (1 - p.attrs.discipline / 100);
  if (m.rng() >= chance) return;
  const n = ++m.yellowCards[teamIdx][p.id];
  if (n === 2) {
    m.suspendedUntil[teamIdx][p.id] = m.clock + 120;
    pushEvent(m, 'yellow', `🟨 ${p.name} 第 2 张黄牌，离场 2 分钟`, m.ball.x, m.ball.y, m.pulse, teamIdx, p.name);
  } else {
    pushEvent(m, 'yellow', `🟨 ${p.name} 黄牌（全场第 ${n} 张）`, m.ball.x, m.ball.y, m.pulse, teamIdx, p.name);
  }
}

function bestPenaltyTaker(team: Team): Player {
  let best = team.players[1];
  for (let i = 2; i < team.players.length; i++) {
    const p = team.players[i];
    if (p.attrs.shooting + p.attrs.calm > best.attrs.shooting + best.attrs.calm) best = p;
  }
  return best;
}

// ---------- 单 tick 事件 ----------

function doPass(m: MatchState, attIdx: 0 | 1, defIdx: 0 | 1): MatchEvent {
  const att = m.teams[attIdx];
  const def = m.teams[defIdx];
  const actor = att.players[m.possessor];
  const dir = attIdx === 0 ? 1 : -1;

  // 选接球人（空间感加权，离场者除外）
  const receivers = att.players
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i !== m.possessor && m.suspendedUntil[attIdx][i] <= m.clock);
  const weights = receivers.map(({ p, i }) => (i === 0 ? 0.5 : 1 + p.attrs.spatial / 60));
  const rec = receivers[pickIndex(m.rng(), weights)];
  const receiver = rec.p;

  const TEND: Record<Position, number> = { FW: 14, MF: 6, DF: -4, GK: -12 };
  const rx = clamp(m.ball.x + dir * TEND[receiver.position] * (0.6 + m.rng() * 0.8), 2, FIELD_W - 2);
  const ry = clamp(m.ball.y + (m.rng() - 0.5) * 16, 2, FIELD_H - 2);

  // 越位判定：对方半场 + 比球更靠门线 + 距底线不足两名防守球员
  const inOppHalf = attIdx === 0 ? rx > FIELD_W / 2 : rx < FIELD_W / 2;
  const defLine = attIdx === 0 ? Math.min(FIELD_W - 6, m.ball.x + 12) : Math.max(6, m.ball.x - 12);
  const offsidePos = attIdx === 0 ? rx > defLine + 2 : rx < defLine - 2;
  if (inOppHalf && offsidePos) {
    const defTactical = def.players.reduce((s, p) => s + p.attrs.tactical, 0) / (def.players.length * 100);
    const fwdFactor = receiver.position === 'FW' ? 1 : 0.35;
    const offChance = 0.02 + defTactical * fwdFactor * 0.05;
    if (m.rng() < offChance) {
      m.pulse = 0;
      turnover(m, defIdx, rx, ry, 0);
      return pushEvent(m, 'offside', `${att.name} ${receiver.name} 越位，进攻中断，脉冲归零`, rx, ry, 0, defIdx, receiver.name);
    }
  }

  const aerial = m.rng() < att.tactics.aerial;
  const pressPenalty = def.tactics.pressing * 0.1 * (1 - receiver.attrs.control / 100);
  const success = clamp01(
    (actor.attrs.passing / 100) * 0.72 +
    (receiver.attrs.control / 100) * 0.18 +
    (aerial ? 0.06 : 0.14) - pressPenalty,
  );
  const ok = m.rng() < success;
  if (!ok) {
    const interceptor = def.players.reduce((best, p) => (p.attrs.anticipation > best.attrs.anticipation ? p : best));
    if (m.rng() < 0.55) {
      m.pulse = 0;
      turnover(m, defIdx, rx, ry, 0, interceptor);
      return pushEvent(m, 'tackle', `${actor.name} 传球被 ${interceptor.name} 拦截，球权转换`, rx, ry, 0, defIdx, actor.name);
    }
    m.ball = { x: rx, y: ry };
    m.possessTicks = 0;
    return pushEvent(m, 'control_fail', `${receiver.name} 停球失误，${att.name} 重新控制`, rx, ry, m.pulse, attIdx, receiver.name);
  }

  m.ball = { x: rx, y: ry };
  m.possessor = rec.i;
  m.possessTicks = 0;
  m.stats.passes[attIdx]++;

  if (!aerial) {
    return pushEvent(m, 'pass_ground', `${actor.name} 触地传球给 ${receiver.name}（脉冲保留 ${m.pulse}）`, rx, ry, m.pulse, attIdx, actor.name);
  }

  // 空中传球：同组合累计（第3次不叠 / 第4次-1 / 第5次犯规）
  const a = actor.id;
  const b = receiver.id;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  const cnt = (m.pairCounts.get(key) ?? 0) + 1;
  m.pairCounts.set(key, cnt);

  if (cnt >= 5) {
    const before = m.pulse;
    const half = Math.floor(before / 2);
    m.pulse = 0;
    const e = pushEvent(m, 'foul', `${actor.name}→${receiver.name} 同一组合第 ${cnt} 次空中传球，判犯规！脉冲 ${before} → ${half} 转移`, rx, ry, half, defIdx, actor.name);
    turnover(m, defIdx, rx, ry, half);
    maybeYellow(m, attIdx, actor);
    return e;
  }

  let gain = 1;
  if (cnt === 3) gain = 0;
  else if (cnt === 4) gain = -1;
  m.pulse = Math.max(0, Math.min(5, m.pulse + gain));
  const note = gain === 1 ? '脉冲+1' : gain === 0 ? `组合第${cnt}次，脉冲不变` : '组合第4次，脉冲-1';
  return pushEvent(m, 'pass', `${actor.name} 空中传球 → ${receiver.name}（${note}，现 ${m.pulse}）`, rx, ry, m.pulse, attIdx, actor.name);
}

function doDribble(m: MatchState, attIdx: 0 | 1, defIdx: 0 | 1): MatchEvent {
  const att = m.teams[attIdx];
  const def = m.teams[defIdx];
  const actor = att.players[m.possessor];
  const dir = attIdx === 0 ? 1 : -1;
  const adv = 1 + (actor.attrs.dribble / 100) * 3.2;
  const nx = m.ball.x + dir * adv;
  const ny = clamp(m.ball.y + (m.rng() - 0.5) * 3, 1, FIELD_H - 1);

  if (nx < 0.5 || nx > FIELD_W - 0.5) {
    const ox = clamp(nx, 1, FIELD_W - 1);
    m.pulse = 0;
    turnover(m, defIdx, ox, ny, 0);
    return pushEvent(m, 'throwin', `${actor.name} 带球出界，${def.name} 界外球`, ox, ny, 0, defIdx, actor.name);
  }

  const lostChance = 0.08 * (1 - actor.attrs.dribble / 100) + def.tactics.pressing * 0.08;
  if (m.rng() < lostChance) {
    const defPlayer = def.players[1 + Math.floor(m.rng() * 8)];
    const won = m.rng() < 0.5 + (defPlayer.attrs.anticipation - actor.attrs.dribble) / 250;
    if (won) {
      m.pulse = 0;
      turnover(m, defIdx, nx, ny, 0, defPlayer);
      return pushEvent(m, 'tackle', `${def.name} ${defPlayer.name} 抢断成功`, nx, ny, 0, defIdx, defPlayer.name);
    }
  }

  m.ball = { x: nx, y: ny };
  return pushEvent(m, 'dribble', `${actor.name} 带球推进`, nx, ny, m.pulse, attIdx, actor.name);
}

function doShot(m: MatchState, attIdx: 0 | 1, defIdx: 0 | 1): MatchEvent {
  const att = m.teams[attIdx];
  const def = m.teams[defIdx];
  const actor = att.players[m.possessor];
  const dir = attIdx === 0 ? 1 : -1;
  const dist = attIdx === 0 ? FIELD_W - m.ball.x : m.ball.x;
  const pulseBefore = m.pulse;

  // 得分 = 基础分(脉冲) + 脉冲区接球2秒 +1 + 远射(>18m) +1，最高 7
  const base = pulseBefore <= 1 ? 1 : pulseBefore;
  const zoneBonus = dist <= 13 && dist > 8 && m.possessTicks <= 2 ? 1 : 0;
  const longBonus = dist > 18 ? 1 : 0;
  const total = Math.min(7, base + zoneBonus + longBonus);

  let acc = (actor.attrs.shooting / 100) * 0.13 + (actor.attrs.longShot / 100) * 0.05;
  if (pulseBefore >= 4) acc += (actor.attrs.calm / 100) * 0.07; // 满脉冲冷静加成
  const distFactor = 1 - dist / 30;
  const hitChance = clamp01(acc * (0.55 + 0.45 * distFactor));

  const groundShot = m.rng() < 0.45; // 地滚球（第一落点贴地）有效
  const invalidAerial = !groundShot && m.rng() < 0.14; // 飞行触地滚入 → 无效
  const saved = m.rng() < (def.players[0].attrs.save / 100) * 0.32; // 门将扑救

  m.stats.shots[attIdx]++;

  if (invalidAerial) {
    const gkx = defIdx === 0 ? 4 : FIELD_W - 4;
    m.pulse = 0;
    turnover(m, defIdx, gkx, 20, 0, def.players[0]);
    return pushEvent(m, 'shot', `${actor.name} 空中抽射，球飞行触地滚入——无效！${def.name} 门球`, gkx, 20, 0, defIdx, actor.name);
  }

  const nx = clamp(m.ball.x + dir * 2.5, 1, FIELD_W - 1);
  const ny = clamp(m.ball.y + (m.rng() - 0.5) * 6, 1, FIELD_H - 1);
  m.ball = { x: nx, y: ny };

  const scored = !saved && m.rng() < hitChance;
  if (scored) {
    m.score[attIdx] += total;
    m.stats.goals[attIdx]++;
    if (m.period === 3) m.goldenGoal = true; // 金球
    const bonusTxt = `${zoneBonus ? '+脉冲区' : ''}${longBonus ? '+远射' : ''}`;
    const e = pushEvent(m, 'goal', `⚽ 进球！${actor.name} 射门命中 +${total} 分（脉冲${pulseBefore}${bonusTxt}）`, nx, ny, 0, attIdx, actor.name);
    kickoff(m, defIdx); // 失分方开球
    return e;
  }

  const gkx = defIdx === 0 ? 4 : FIELD_W - 4;
  m.pulse = 0;
  turnover(m, defIdx, gkx, 20, 0, def.players[0]);
  return pushEvent(m, 'shot', `${actor.name} 射门（${total} 分机会）被 ${def.players[0].name} 化解`, gkx, 20, 0, defIdx, actor.name);
}

function doPenalty(m: MatchState, attIdx: 0 | 1, defIdx: 0 | 1, points: 2 | 3, fouler: string): MatchEvent {
  const att = m.teams[attIdx];
  const def = m.teams[defIdx];
  const taker = bestPenaltyTaker(att);
  const gk = def.players[0];
  const px = attIdx === 0 ? FIELD_W - (points === 2 ? 8 : 7) : (points === 2 ? 8 : 7);
  const before = m.pulse;
  m.pulse = 0;
  pushEvent(m, 'penalty', `${att.name} 获 ${points} 分点球（${fouler} 犯规${before > 0 ? `，原脉冲 ${before}` : ''}）`, px, 20, 0, attIdx, taker.name);
  const p = clamp01(0.3 + (taker.attrs.shooting / 100) * 0.3 + (taker.attrs.calm / 100) * 0.24 - (gk.attrs.save / 100) * 0.3);
  const scored = m.rng() < p;
  if (scored) {
    m.score[attIdx] += points;
    m.stats.goals[attIdx]++;
    if (m.period === 3) m.goldenGoal = true;
    const e = pushEvent(m, 'penalty_goal', `⚽ ${taker.name} 点球命中 +${points} 分`, px, 20, 0, attIdx, taker.name);
    kickoff(m, defIdx);
    return e;
  }
  const gkx = defIdx === 0 ? 4 : FIELD_W - 4;
  turnover(m, defIdx, gkx, 20, 0, gk);
  return pushEvent(m, 'penalty_miss', `${taker.name} 点球被 ${gk.name} 扑出（不可补射）`, gkx, 20, 0, defIdx, taker.name);
}

function doFoul(m: MatchState, attIdx: 0 | 1, defIdx: 0 | 1): MatchEvent {
  const att = m.teams[attIdx];
  const def = m.teams[defIdx];
  const actor = att.players[m.possessor];
  const dist = attIdx === 0 ? FIELD_W - m.ball.x : m.ball.x;

  const attackerFoul = m.rng() < 0.55;
  if (attackerFoul) {
    // 进攻方犯规 → 球权转换 + 脉冲减半转移
    const before = m.pulse;
    const half = Math.floor(before / 2);
    m.stats.fouls[attIdx]++;
    m.pulse = 0;
    const e = pushEvent(m, 'foul', `${att.name} ${actor.name} 进攻犯规，球权转换，脉冲 ${before} → ${half} 转移给 ${def.name}`, m.ball.x, m.ball.y, half, defIdx, actor.name);
    turnover(m, defIdx, m.ball.x, m.ball.y, half);
    maybeYellow(m, attIdx, actor);
    return e;
  }

  const defPlayer = def.players[1 + Math.floor(m.rng() * 8)];
  m.stats.fouls[defIdx]++;
  m.teamFouls[defIdx]++;
  const tactical = m.rng() < 0.12; // 战术犯规 → 3 分点球
  if (tactical) return doPenalty(m, attIdx, defIdx, 3, defPlayer.name);
  if (dist <= 8) return doPenalty(m, attIdx, defIdx, 2, defPlayer.name); // 禁区普通犯规
  if (m.teamFouls[defIdx] >= 6) return doPenalty(m, attIdx, defIdx, 2, defPlayer.name); // 每节第 6 犯
  m.possessTicks = 0;
  const e = pushEvent(m, 'foul', `${def.name} ${defPlayer.name} 犯规，${att.name} 任意球（脉冲保留 ${m.pulse}）`, m.ball.x, m.ball.y, m.pulse, attIdx, defPlayer.name);
  maybeYellow(m, defIdx, defPlayer);
  return e;
}

export function tickMatch(m: MatchState): MatchEvent {
  m.clock++;
  m.possessTicks++;
  const attIdx = m.possession;
  const defIdx = (1 - m.possession) as 0 | 1;
  const att = m.teams[attIdx];
  const actor = att.players[m.possessor];

  // 7 秒持球违例：脉冲减半 + 球权转换
  if (m.possessTicks >= 7) {
    const v = Math.min(0.85, 0.22 + 0.06 * (m.possessTicks - 7));
    if (m.rng() < v) {
      const before = m.pulse;
      const half = Math.floor(before / 2);
      m.pulse = 0;
      const e = pushEvent(m, 'violation', `${att.name} ${actor.name} 持球超 7 秒违例，脉冲 ${before} → ${half}，球权转换`, m.ball.x, m.ball.y, half, defIdx, actor.name);
      turnover(m, defIdx, m.ball.x, m.ball.y, half);
      return e;
    }
  }

  const dist = attIdx === 0 ? FIELD_W - m.ball.x : m.ball.x;
  const shotW = dist <= 22 ? 5 : dist <= 30 ? 2 : 0;
  const opts: [TickKind, number][] = [['pass', 46], ['dribble', 22], ['foul', 0.6]];
  if (shotW > 0) opts.push(['shot', shotW]);
  const kind = pickWeighted(m.rng(), opts);
  switch (kind) {
    case 'pass': return doPass(m, attIdx, defIdx);
    case 'dribble': return doDribble(m, attIdx, defIdx);
    case 'shot': return doShot(m, attIdx, defIdx);
    case 'foul': return doFoul(m, attIdx, defIdx);
  }
}

// ---------- 点球大战：5 轮 + 突然死亡 ----------
export function runShootout(m: MatchState): ShootoutResult {
  m.period = 4;
  const kicks: ShootoutKick[] = [];
  const sc: [number, number] = [0, 0];
  const record = (team: 0 | 1) => {
    const taker = bestPenaltyTaker(m.teams[team]);
    const gk = m.teams[1 - team].players[0];
    const p = clamp01(0.55 + (taker.attrs.shooting / 100) * 0.22 + (taker.attrs.calm / 100) * 0.14 - (gk.attrs.save / 100) * 0.24);
    const made = m.rng() < p;
    if (made) sc[team]++;
    kicks.push({ team, taker: taker.name, made });
    const desc = `${m.teams[team].name} ${taker.name} 点球${made ? '命中' : '罚失'}（${sc[0]} : ${sc[1]}）`;
    pushEvent(m, made ? 'shootout_goal' : 'shootout_miss', desc, FIELD_W / 2, FIELD_H / 2, 0, team, taker.name);
  };
  for (let r = 0; r < 5; r++) {
    record(0);
    record(1);
  }
  let guard = 0;
  while (sc[0] === sc[1] && guard < 60) {
    record(0);
    record(1);
    guard++;
  }
  const winner: 0 | 1 = sc[0] > sc[1] ? 0 : 1;
  pushEvent(m, 'shootout_win', `🏆 ${m.teams[winner].name} 点球大战 ${sc[0]} : ${sc[1]} 获胜`, FIELD_W / 2, FIELD_H / 2, 0, winner);
  return { kicks, score: sc, winner };
}
