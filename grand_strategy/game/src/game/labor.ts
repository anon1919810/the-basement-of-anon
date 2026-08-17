/**
 * 劳动力市场（v0.1）：
 *  - 工资 = 基础工资 × 岗位供需比（需求/供给，clamp 0.5~2.0）
 *  - 识字率解锁技能梯子：农民→矿工→工匠→工程师（阈值 0.10/0.25/0.50）
 *  - 转职操作：玩家把 POP 从低技能转高技能，代价 = 该 POP 3 个月产出减半
 */
import type { GameMap } from './map';
import type { GameState } from './state';
import { BASE_WAGE, JOB_LADDER, LITERACY_REQ, RETRAIN_MONTHS, clamp } from './pops';
import type { JobId } from './types';

/** 每格劳动力需求系数（万人/格，决定岗位供需比） */
export const LABOR_DEMAND_PER_CELL: Record<JobId, number> = {
  farmer: 2.0,
  miner: 0.35,
  artisan: 0.7,
  engineer: 0.35,
};

export const WAGE_CLAMP_MIN = 0.5;
export const WAGE_CLAMP_MAX = 2.0;

/** 国家各岗位劳动力需求（万人） */
export function laborDemand(map: GameMap, nationId: string): Record<JobId, number> {
  const demand: Record<JobId, number> = { farmer: 0, miner: 0, artisan: 0, engineer: 0 };
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
