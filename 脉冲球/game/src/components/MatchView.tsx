// Canvas 比赛回放视图：球场 + 18 名球员圆点（9v9）+ 脉冲 LED 球 + 控制条 + 事件日志
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchResult } from '../game/engine';
import type { MatchEvent } from '../game/match';
import { FIELD_W, FIELD_H } from '../game/match';
import type { Team } from '../game/teams';

const PULSE_COLORS = ['#9ca3af', '#9ca3af', '#3b82f6', '#22c55e', '#eab308', '#ef4444'];
const PULSE_LABEL = ['灰(0~1)', '灰(0~1)', '蓝(2)', '绿(3)', '黄(4)', '红(5)'];

const KEY_TYPES = new Set<string>([
  'goal', 'penalty', 'penalty_goal', 'penalty_miss', 'shot', 'foul',
  'offside', 'violation', 'throwin', 'shootout_goal', 'shootout_miss',
  'overtime_start', 'period_end', 'yellow',
]);

const TYPE_LABEL: Record<string, string> = {
  kickoff: '开球', pass: '空中传球', pass_ground: '触地传球', control_fail: '停控失误',
  dribble: '带球', tackle: '抢断', shot: '射门', goal: '进球', foul: '犯规',
  penalty: '点球', penalty_goal: '点球命中', penalty_miss: '点球未进',
  offside: '越位', violation: '7秒违例', throwin: '界外球', yellow: '黄牌',
  period_end: '节末', overtime_start: '加时', shootout_kick: '点球大战',
  shootout_goal: '点球进球', shootout_miss: '点球未进', shootout_win: '点球获胜',
};

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function periodName(period: number): string {
  if (period <= 2) return ['上节', '中节', '下节'][period];
  return period === 3 ? '金球加时' : '点球大战';
}

function eventIndexAt(events: MatchEvent[], t: number): number {
  let lo = 0, hi = events.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 简化站位：控球方围绕球展开，防守方在球与本方球门之间布阵
function layoutTeams(teams: [Team, Team], possession: 0 | 1, bx: number, by: number): { x: number; y: number }[][] {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const gkX = (t: 0 | 1) => (t === 0 ? 2.5 : FIELD_W - 2.5);
  const out: { x: number; y: number }[][] = [[], []];
  for (const t of [0, 1] as const) {
    const isAtt = t === possession;
    const d = isAtt ? (possession === 0 ? 1 : -1) : (possession === 0 ? -1 : 1);
    const arr = out[t];
    arr[0] = { x: gkX(t), y: FIELD_H / 2 };
    const offs: [number, number][] = isAtt
      ? [[10, 0], [5, 4.5], [5, -4.5], [0, 8], [0, -8], [1, 0], [-6, 5], [-6, -5]]
      : [[-3, 0], [-6, 3.5], [-6, -3.5], [-11, 7], [-11, -7], [-12, 0], [-18, 6], [-18, -6]];
    for (let i = 0; i < 8; i++) {
      arr[i + 1] = {
        x: clamp(bx + d * offs[i][0], 1.5, FIELD_W - 1.5),
        y: clamp(by + offs[i][1], 1.5, FIELD_H - 1.5),
      };
    }
  }
  return out;
}

function drawScene(canvas: HTMLCanvasElement, teams: [Team, Team], evs: MatchEvent[], idx: number, frac: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  const s = W / FIELD_W;
  const X = (x: number) => x * s;
  const Y = (y: number) => y * s;
  const cur = evs[Math.min(idx, evs.length - 1)];
  const nxt = evs[idx + 1];
  const bx = nxt ? cur.x + (nxt.x - cur.x) * frac : cur.x;
  const by = nxt ? cur.y + (nxt.y - cur.y) * frac : cur.y;
  const pulse = Math.max(0, Math.min(5, Math.round(cur.pulse)));
  const possession: 0 | 1 = cur.team === 0 ? 0 : 1;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 球场：白底细绿线
  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(X(FIELD_W / 2), 0);
  ctx.lineTo(X(FIELD_W / 2), H);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(FIELD_W / 2), Y(FIELD_H / 2), 3 * s, 0, Math.PI * 2);
  ctx.stroke();

  // 脉冲区（半径 13 半圆环，虚线）
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = '#4ade80';
  for (const g of [0, FIELD_W] as const) {
    ctx.beginPath();
    ctx.arc(X(g), Y(FIELD_H / 2), 13 * s, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 禁区（半径 8 半圆）+ 球门
  ctx.strokeStyle = '#22c55e';
  for (const g of [0, FIELD_W] as const) {
    ctx.beginPath();
    ctx.arc(X(g), Y(FIELD_H / 2), 8 * s, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.fillStyle = '#16a34a';
    const gx = g === 0 ? X(g) - 1.2 * s : X(g);
    ctx.fillRect(gx, Y(FIELD_H / 2) - 2 * s, 1.2 * s, 4 * s);
  }

  // 队名 + 脉冲 + 当前事件字幕（看得懂的观赛信息）
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2563eb';
  ctx.fillText(teams[0].name, 8, 18);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#dc2626';
  ctx.fillText(teams[1].name, W - 8, 18);
  ctx.textAlign = 'center';
  ctx.font = 'bold 17px sans-serif';
  ctx.fillStyle = PULSE_COLORS[pulse];
  ctx.fillText(`脉冲 ${pulse}/5`, W / 2, 20);
  const caption = cur.desc || '';
  ctx.font = '13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const cw = ctx.measureText(caption).width + 14;
  ctx.fillRect(W / 2 - cw / 2, H - 24, cw, 18);
  ctx.fillStyle = '#111827';
  ctx.fillText(caption, W / 2, H - 11);

  // 球员（18 个圆点 = 9v9）
  const pos = layoutTeams(teams, possession, bx, by);
  const actorName = cur.player;
  for (const t of [0, 1] as const) {
    for (let i = 0; i < 9; i++) {
      const p = pos[t][i];
      const isGK = i === 0;
      const isActor = actorName !== undefined && cur.team === t && actorName === teams[t].players[i].name;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), (isGK ? 2.6 : 2.1) * s, 0, Math.PI * 2);
      ctx.fillStyle = t === 0 ? '#2563eb' : '#dc2626';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      if (isActor) {
        ctx.beginPath();
        ctx.arc(X(p.x), Y(p.y), (isGK ? 3.7 : 3.2) * s, 0, Math.PI * 2);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(8, 1.6 * s)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(teams[t].players[i].number), X(p.x), Y(p.y));
    }
  }

  // 球 + 脉冲 LED 光晕
  ctx.beginPath();
  ctx.arc(X(bx), Y(by), 3.0 * s, 0, Math.PI * 2);
  ctx.fillStyle = PULSE_COLORS[pulse];
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(X(bx), Y(by), 1.6 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#111827';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = PULSE_COLORS[pulse];
  ctx.stroke();
}

export default function MatchView({ result }: { result: MatchResult }) {
  const events = result.events;
  const duration = events.length ? events[events.length - 1].t : 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const [vtime, setVtime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [keyOnly, setKeyOnly] = useState(false);

  const vtimeRef = useRef(0);
  const playingRef = useRef(true);
  const speedRef = useRef(1);
  const keyOnlyRef = useRef(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const idx = eventIndexAt(events, vtime);
  const cur = events[Math.max(0, idx)];

  const keyEventIdx = useMemo(() => {
    const arr: number[] = [];
    events.forEach((e, i) => { if (KEY_TYPES.has(e.type)) arr.push(i); });
    return arr;
  }, [events]);

  // 控制状态同步到 ref
  useEffect(() => {
    playingRef.current = playing;
    speedRef.current = speed;
    keyOnlyRef.current = keyOnly;
  }, [playing, speed, keyOnly]);

  // rAF 播放循环：vtime 推进（1x ≈ 60 秒播完一场）
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playingRef.current) {
        let vt = vtimeRef.current;
        if (keyOnlyRef.current) {
          const list = eventsRef.current;
          let i = eventIndexAt(list, vt + 0.01) + 1;
          while (i < list.length && !KEY_TYPES.has(list[i].type)) i++;
          if (i < list.length) vt = list[i].t;
          else {
            vt = list[list.length - 1].t;
            playingRef.current = false;
            setPlaying(false);
          }
        } else {
          const baseRate = duration / 60;
          vt = Math.min(duration, vt + dt * baseRate * speedRef.current);
          if (vt >= duration) {
            vt = duration;
            playingRef.current = false;
            setPlaying(false);
          }
        }
        vtimeRef.current = vt;
        setVtime(vt);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  // 绘制当前帧
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const curIdx = eventIndexAt(events, vtime);
    const a = events[Math.max(0, curIdx)];
    const b = events[curIdx + 1];
    const frac = b ? (vtime - a.t) / Math.max(1e-6, b.t - a.t) : 0;
    drawScene(canvas, result.teams, events, curIdx, Math.max(0, Math.min(1, frac)));
  }, [vtime, events, result]);

  // 日志自动滚动到当前事件
  useEffect(() => {
    logRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const goTo = (t: number) => {
    vtimeRef.current = t;
    setVtime(t);
  };
  const togglePlay = () => {
    const p = !playingRef.current;
    playingRef.current = p;
    setPlaying(p);
    if (p && vtimeRef.current >= duration) goTo(0);
  };
  const step = (d: number) => {
    const arr = keyOnly ? keyEventIdx : events.map((_, i) => i);
    let pos = keyOnly ? keyEventIdx.indexOf(idx) : idx;
    pos = Math.max(0, Math.min(arr.length - 1, pos + d));
    const targetIdx = arr[pos];
    goTo(events[targetIdx].t);
  };

  // 跳节目标：各节末 / 加时·点球起点 / 终场
  const jumpTargets = useMemo(() => {
    const lastOf = (pred: (e: MatchEvent) => boolean) => {
      for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i].t;
      return 0;
    };
    return {
      p0: lastOf((e) => e.period === 0),
      p1: lastOf((e) => e.period === 1),
      p2: lastOf((e) => e.period === 2),
      ot: events.some((e) => e.period === 3)
        ? lastOf((e) => e.period === 3 || e.period === 4)
        : null,
      end: duration,
    };
  }, [events, duration]);

  const shownIdx = keyOnly ? keyEventIdx : events.map((_, i) => i);
  const pulse = Math.max(0, Math.min(5, Math.round(cur.pulse)));

  return (
    <div className="match">
      <div className="scoreboard">
        <span className="team home">{result.teams[0].name}</span>
        <span className="score">{cur.score[0]} : {cur.score[1]}</span>
        <span className="team away">{result.teams[1].name}</span>
        <div className="meta">
          <span>{periodName(cur.period)}</span>
          <span>{fmtTime(vtime)} / {fmtTime(duration)}</span>
          <span className="pulse">
            <i style={{ background: PULSE_COLORS[pulse] }} />
            脉冲 {cur.pulse}（{PULSE_LABEL[pulse]}）
          </span>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={880}
        height={Math.round((880 * FIELD_H) / FIELD_W)}
        className="pitch"
      />

      <div className="controls">
        <div className="group">
          <button className="btn" onClick={() => step(-1)}>⏮ 上一个</button>
          <button className="btn primary" onClick={togglePlay}>{playing ? '⏸ 暂停' : '▶ 播放'}</button>
          <button className="btn" onClick={() => step(1)}>⏭ 下一个</button>
        </div>
        <div className="group">
          {[1, 2, 4].map((sp) => (
            <button key={sp} className={`btn ${speed === sp ? 'active' : ''}`} onClick={() => setSpeed(sp)}>{sp}x</button>
          ))}
        </div>
        <div className="group">
          <button className="btn" onClick={() => goTo(jumpTargets.p0)}>上节末</button>
          <button className="btn" onClick={() => goTo(jumpTargets.p1)}>中节末</button>
          <button className="btn" onClick={() => goTo(jumpTargets.p2)}>下节末</button>
          {jumpTargets.ot !== null && <button className="btn" onClick={() => goTo(jumpTargets.ot as number)}>加时·点球</button>}
          <button className="btn" onClick={() => goTo(jumpTargets.end)}>终场</button>
        </div>
        <div className="group">
          <label className="chk">
            <input type="checkbox" checked={keyOnly} onChange={(e) => setKeyOnly(e.target.checked)} />
            只看关键时刻
          </label>
        </div>
        <div className="group grow">
          <input
            type="range" min={0} max={duration} step={0.5} value={vtime}
            onChange={(e) => goTo(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="log" ref={logRef}>
        {shownIdx.map((i) => {
          const e = events[i];
          const isKey = e.type === 'goal' || e.type === 'penalty_goal' || e.type === 'shootout_goal';
          return (
            <div
              key={`${e.t}-${e.type}-${e.desc}`}
              data-idx={i}
              className={`log-item ${isKey ? 'goal' : ''} ${idx === i ? 'current' : ''}`}
            >
              <span className="t">{fmtTime(e.t)}</span>
              <span className="tag">{TYPE_LABEL[e.type] ?? e.type}</span>
              <span className="desc">{e.desc}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
