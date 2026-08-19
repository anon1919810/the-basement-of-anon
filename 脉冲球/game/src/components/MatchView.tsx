// Three.js 3D 比赛回放视图：3D 球场 + 18 名小人（9v9）+ 脉冲 LED 球 + 控制条 + 事件日志
// 播放/步进/跳节/比分/脉冲/日志 DOM 与原 2D 版一致；渲染层由 MatchScene（three）承担
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchResult } from '../game/engine';
import type { MatchEvent } from '../game/match';
import { MatchScene, PLAYBACK, PULSE_COLORS } from '../three/MatchScene';

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

export default function MatchView({ result }: { result: MatchResult }) {
  const events = result.events;
  const duration = events.length ? events[events.length - 1].t : 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MatchScene | null>(null);

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

  // 创建/销毁 3D 场景（一场比赛一个；Rapier wasm 异步初始化）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    let scene: MatchScene | null = null;
    MatchScene.create(el, result.teams, result.events).then((s) => {
      if (cancelled) {
        s.dispose();
        return;
      }
      scene = s;
      sceneRef.current = s;
      (window as any).__pulse3dReady = true; // 调试/自动化检测用
    });
    return () => {
      cancelled = true;
      if (scene) scene.dispose();
      sceneRef.current = null;
    };
  }, [result]);

  // rAF 播放循环：vtime 按 真实 dt × 速度倍率 连续推进（1x≈实时，每秒一条的事件约铺 60 帧，
  // 插值/缓动充分展现；暂停即停钟）+ 驱动 3D 渲染
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
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
          // 连续时间轴：游戏时钟 = 真实 dt × TIME_SCALE × 速度倍率（不再每帧跳到下一事件）
          vt = Math.min(duration, vt + dt * PLAYBACK.TIME_SCALE * speedRef.current);
          if (vt >= duration) {
            vt = duration;
            playingRef.current = false;
            setPlaying(false);
          }
        }
        vtimeRef.current = vt;
        setVtime(vt);
      }
      sceneRef.current?.update(vtimeRef.current, now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

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

      <div className="pitch3d" ref={containerRef} />

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
