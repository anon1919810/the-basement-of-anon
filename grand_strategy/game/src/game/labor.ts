/**
 * 劳动力市场（v0.1 保留）+ 阶级流动（v0.3 扩展）：
 *  - 工资 = 基础工资 × 岗位供需比（需求/供给，clamp 0.5~2.0）
 *  - 识字率解锁技能梯子：农民→矿工→工匠→工程师（阈值 0.10/0.25/0.50）
 *  - 转职操作：玩家把 POP 从低技能转高技能，代价 = 该 POP 3 个月产出减半
 *  - 阶级流动（确定性，无随机）：教育（识字率）+ 财富（工资倍率）驱动
 *      · 佃农(6)→自耕农(5)；自耕农(5)→富农(4)→地主(3)；工匠(4)→技术阶层(3)→资本家(2)→大贵族(1)
 *      · 工资低迷 → 向下流动（工人→无业游民）
 *      · 奴隶(7) 不流动（除非「废农奴制」政策）
 *      · 月流动有上限（cap），总量随识字率与工资爬升
 */
import type { GameMap } from './map';
import type { GameState } from './state';
import { BASE_WAGE, JOB_LADDER, LITERACY_REQ, RETRAIN_MONTHS, clamp, findClassPop, zeroJobMix } from './pops';
import type { ClassId, JobId } from './types';
import { classDef } from './classes';

/** 每格劳动力需求系数（万人/格，决定岗位供需比） */
export const LABOR_DEMAND_PER_CELL: Record<JobId, number> = {
  slave: 1.6,
  peasant: 2.0,
  worker: 0.5,
  technician: 0.7,
  clerk: 0.3,
  engineer: 0.35,
  merchant: 0.2,
  capitalist: 0.1,
  banker: 0.08,
};

export const WAGE_CLAMP_MIN = 0.5;
export const WAGE_CLAMP_MAX = 2.0;

/** 国家各岗位劳动力需求（万人） */
export function laborDemand(map: GameMap, nationId: string): Record<JobId, number> {
  const demand = zeroJobMix();
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    for (const job of Object.keys(LABOR_DEMAND_PER_CELL) as JobId[]) {
      demand[job] += p.cellIds.length * LABOR_DEMAND_PER_CELL[job];
    }
  }
  return demand;
}

/** 岗位供需比（需求/供给） */
export function laborRatio(demand: number, supply: number): number {
  return demand / Math.max(supply, 1e-9);
}

/** 由供需比计算各职业工资（万₭/人/年） */
export function computeWages(supply: Record<JobId, number>, demand: Record<JobId, number>): Record<JobId, number> {
  const wages = {} as Record<JobId, number>;
  for (const job of Object.keys(BASE_WAGE) as JobId[]) {
    const ratio = laborRatio(demand[job], supply[job]);
    wages[job] = BASE_WAGE[job] * clamp(ratio, WAGE_CLAMP_MIN, WAGE_CLAMP_MAX);
  }
  return wages;
}

/** 下一职业的识字率门槛（null 表示已到顶） */
export function nextJobThreshold(job: JobId): { next: JobId | null; literacyReq: number } {
  const next = JOB_LADDER[job];
  return { next, literacyReq: next ? LITERACY_REQ[next] : 0 };
}

/**
 * 转职：把指定 POP 升至技能梯子下一级。
 * 要求：识字率达标、有下一级；代价 = 3 个月产出减半（retrainMonths=3）。
 * 返回是否成功。
 */
export function retrainPop(state: GameState, _map: GameMap, provId: number, popIndex: number): boolean {
  const ps = state.provinces[provId];
  if (!ps) return false;
  const pop = ps.pops[popIndex];
  if (!pop) return false;
  const { next, literacyReq } = nextJobThreshold(pop.job);
  if (!next) return false;
  const n = state.nations[state.playerNation];
  if (n.literacy < literacyReq) return false;
  pop.job = next;
  pop.retrainMonths = RETRAIN_MONTHS;
  return true;
}

// ---- 阶级流动（v0.3） ----

/** 月流动上限（占 POP 规模比例） */
export const MOBILITY_CAP = 0.01;
/** 向下流动触发：工资倍率低于该值 → 跌落 */
export const DOWN_WAGE_THRESHOLD = 0.75;

interface MobilityRule {
  from: ClassId;
  to: ClassId;
  /** 识字率门槛（未达则流动概率 × 0.3） */
  literacyReq: number;
  /** 基础月流动率 */
  baseRate: number;
}

/** 向上流动规则表（数字越小越上层；7→6 佃农化不在此列，奴隶不流动） */
export const UP_MOBILITY: MobilityRule[] = [
  { from: 6, to: 5, literacyReq: 0, baseRate: 0.004 }, // 佃农/无业 → 自耕农/工人
  { from: 5, to: 4, literacyReq: 0.15, baseRate: 0.0025 }, // 自耕农 → 富农；工人 → 工匠
  { from: 4, to: 3, literacyReq: 0.4, baseRate: 0.0012 }, // 富农 → 地主；工匠 → 技术阶层
  { from: 3, to: 2, literacyReq: 0.5, baseRate: 0.0006 }, // 技术阶层 → 资本家/官僚上层
  { from: 2, to: 1, literacyReq: 0.6, baseRate: 0.0002 }, // 资本家 → 大贵族
];

/**
 * 阶级流动（确定性，无随机）：每月对玩家国家所有 POP 应用。
 *  - 向上：识字率 × 工资倍率驱动，按规则表流动到同职业同种族的上层 POP
 *  - 向下：工资低迷（< DOWN_WAGE_THRESHOLD）→ 跌入下一级（至多跌到 6 无业游民）
 *  - 奴隶(7) 不参与任何流动
 *  - 目标 POP 不存在时自动创建（size 0，保持链条完整）
 */
export function applyClassMobility(state: GameState, map: GameMap): void {
  const n = state.nations[state.playerNation];
  const lit = n.literacy;
  const provIds = map.provinces
    .filter((p) => p.owner === state.playerNation && !p.isUndiscovered)
    .map((p) => p.id);

  for (const pid of provIds) {
    const ps = state.provinces[pid];
    // 收集每（job × race）的阶级 POP 索引，用于寻找目标
    // 1) 向上流动
    for (const rule of UP_MOBILITY) {
      const { from, to } = rule;
      // 遍历当前 from 阶级的 POP 快照（流动中 size 变化，用快照避免重复流动）
      const candidates = ps.pops.filter((p) => p.class === from);
      for (const pop of candidates) {
        if (pop.size <= 0.0001) continue;
        const wageFactor = clamp(pop.wage / BASE_WAGE[pop.job], 0.5, 2);
        const litFactor = lit >= rule.literacyReq ? 1 : 0.3;
        const rate = Math.min(MOBILITY_CAP, rule.baseRate * litFactor * (0.6 + 0.4 * wageFactor));
        const amount = Math.min(pop.size * rate, pop.size * 0.5);
        if (amount <= 0) continue;
        let target = findClassPop(ps.pops, pop.job, pop.race, to);
        if (!target) {
          target = {
            class: to,
            job: pop.job,
            race: pop.race,
            size: 0,
            happiness: classDef(to).baseHappiness,
            wage: BASE_WAGE[pop.job],
            investIncome: 0,
            sat: { food: 0.9, clothing: 0.9, housing: 0.9, fuel: 0.9 },
            retrainMonths: 0,
          };
          ps.pops.push(target);
        }
        pop.size -= amount;
        target.size += amount;
      }
    }
    // 2) 向下流动（工资低迷）：class < 6，跌入 class+1（奴隶除外）
    const downCandidates = ps.pops.filter((p) => p.class < 6 && p.class >= 1 && p.size > 0.0001);
    for (const pop of downCandidates) {
      const wageFactor = clamp(pop.wage / BASE_WAGE[pop.job], 0.5, 2);
      if (wageFactor >= DOWN_WAGE_THRESHOLD) continue;
      const rate = 0.002 * (1 - wageFactor / DOWN_WAGE_THRESHOLD);
      const amount = Math.min(pop.size * rate, pop.size * 0.5);
      if (amount <= 0) continue;
      const to = Math.min(6, pop.class + 1) as ClassId;
      let target = findClassPop(ps.pops, pop.job, pop.race, to);
      if (!target) {
        target = {
          class: to,
          job: pop.job,
          race: pop.race,
          size: 0,
          happiness: classDef(to).baseHappiness,
          wage: BASE_WAGE[pop.job],
          investIncome: 0,
          sat: { food: 0.9, clothing: 0.9, housing: 0.9, fuel: 0.9 },
          retrainMonths: 0,
        };
        ps.pops.push(target);
      }
      pop.size -= amount;
      target.size += amount;
    }
  }
}
