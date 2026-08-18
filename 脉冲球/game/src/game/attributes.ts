// 球员属性（0-99）：技术/身体/精神 + 门将专属
import type { RNG } from './rng';

export type Position = 'GK' | 'DF' | 'MF' | 'AM' | 'FW';

export interface Attributes {
  // 技术
  passing: number;   // 传球：空中传球成功率 → 脉冲积累速度
  control: number;   // 停控：球未触地前停球质量
  dribble: number;   // 带球：7 秒持球限制下的护球推进
  shooting: number;  // 射门：命中率
  longShot: number;  // 远射：18 米外远射命中
  // 身体
  speed: number;     // 速度：无球跑位/回追/逼抢
  stamina: number;   // 体能：3×20 净时续航
  strength: number;  // 力量：肩对肩/卡位
  // 精神
  spatial: number;   // 空间感：无球跑位/接应路线
  anticipation: number; // 预判：抢断/拦截传球路线
  calm: number;      // 冷静：满脉冲(4-5层)射门加成
  discipline: number;   // 纪律：犯规倾向（低=易犯规）
  tactical: number;  // 战术纪律：越位陷阱协调
  // 门将专属
  save: number;      // 扑救
  throw_: number;    // 手抛（快反发动）
  rush: number;      // 出击
}

const clamp = (v: number) => Math.max(0, Math.min(99, Math.round(v)));

export function randomAttributes(rng: RNG, pos: Position): Attributes {
  const b = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const A: Attributes = {
    passing: b(45, 75), control: b(45, 75), dribble: b(40, 70),
    shooting: b(40, 70), longShot: b(35, 65), speed: b(40, 70),
    stamina: b(45, 75), strength: b(40, 70), spatial: b(40, 70),
    anticipation: b(40, 70), calm: b(40, 70), discipline: b(45, 75),
    tactical: b(40, 70),
    save: b(5, 15), throw_: b(5, 15), rush: b(5, 15),
  };
  if (pos === 'GK') {
    A.save = b(58, 82); A.throw_ = b(55, 78); A.rush = b(50, 75);
    A.passing = b(30, 55); A.control = b(25, 50); A.dribble = b(15, 35);
    A.shooting = b(10, 25); A.longShot = b(5, 20); A.speed = b(35, 60);
    A.stamina = b(40, 65); A.strength = b(35, 60); A.spatial = b(30, 55);
    A.anticipation = b(45, 70); A.calm = b(45, 70); A.discipline = b(50, 80);
    A.tactical = b(45, 70);
  } else {
    const up = (k: keyof Attributes, n: number) => { A[k] = clamp(A[k] + Math.floor(rng() * n)); };
    if (pos === 'DF') { up('strength', 20); up('anticipation', 20); up('tactical', 20); up('speed', 12); }
    if (pos === 'MF') { up('passing', 20); up('control', 18); up('spatial', 18); up('stamina', 15); }
    if (pos === 'AM') { up('passing', 15); up('dribble', 20); up('spatial', 18); up('shooting', 10); }
    if (pos === 'FW') { up('shooting', 20); up('calm', 18); up('speed', 15); up('dribble', 10); }
  }
  return A;
}
