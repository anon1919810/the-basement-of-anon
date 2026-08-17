/**
 * 玩家投资（v0.2）：国库投入工业项目（纺织厂/冶铁厂/船坞），按省份选址。
 *  - 建造成本（万₭，国库一次性投入）+ 工期（月）→ 投产后每月按该商品国家市场价 × 产能产生回报（进国库）
 *  - 随市场波动有盈亏风险：回报 = 产能 × (市价 - 单位运营成本)，市价低迷时可能亏损
 *  - 取消退款按完成度：退款 = 总成本 × (1 - 进度)
 *  - 投产后工厂产出进入国家市场供给（产能 单位/月），形成价格反馈
 *  - 解锁：受省份资源（地形/沿海）与基建（道路/港口）约束
 */
import type { GameMap, Province } from './map';
import { isCoastal } from './logistics';
import type { GameState } from './state';
import type { GoodId } from './types';

export type ProjectKind = 'textile' | 'iron' | 'shipyard';

export interface ProjectDef {
  kind: ProjectKind;
  label: string;
  good: GoodId;
  /** 建造成本（万₭） */
  cost: number;
  /** 工期（月） */
  duration: number;
  /** 产能（单位/月，同时进入国家市场供给） */
  capacity: number;
  /** 单位运营成本（万₭/单位） */
  opCost: number;
  /** 基建门槛 */
  infra: { roads?: number; ports?: number };
  desc: string;
}

export const PROJECT_DEFS: Record<ProjectKind, ProjectDef> = {
  textile: {
    kind: 'textile',
    label: '纺织厂',
    good: 'clothing',
    cost: 150,
    duration: 6,
    capacity: 3.0,
    opCost: 0.9,
    infra: { roads: 10 },
    desc: '机器纺纱织布，供应衣物市场；道路通达即可开工。',
  },
  iron: {
    kind: 'iron',
    label: '冶铁厂',
    good: 'industrial',
    cost: 200,
    duration: 8,
    capacity: 2.4,
    opCost: 1.1,
    infra: { roads: 15 },
    desc: '高炉炼铁，需要丘陵/山地矿脉或高产出平原；产出工业品。',
  },
  shipyard: {
    kind: 'shipyard',
    label: '船坞',
    good: 'industrial',
    cost: 320,
    duration: 12,
    capacity: 4.0,
    opCost: 1.1,
    infra: { ports: 15 },
    desc: '沿海船坞，建造商船与军舰；需要港口与海岸线。',
  },
};

export const PROJECT_KINDS: ProjectKind[] = ['textile', 'iron', 'shipyard'];

export interface InvestmentProject {
  id: number;
  kind: ProjectKind;
  provId: number;
  totalCost: number;
  duration: number;
  monthsLeft: number;
  status: 'building' | 'active';
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
}

/** 省份/基建解锁检查（UI 与 sim 共用） */
export function projectUnlock(map: GameMap, kind: ProjectKind, prov: Province, infra: { roads: number; ports: number }): UnlockResult {
  const def = PROJECT_DEFS[kind];
  if (infra.roads < (def.infra.roads ?? 0)) {
    return { ok: false, reason: `道路需 ≥${def.infra.roads}` };
  }
  if (infra.ports < (def.infra.ports ?? 0)) {
    return { ok: false, reason: `港口需 ≥${def.infra.ports}` };
  }
  if (kind === 'iron' && prov.terrain === 'plain' && prov.productivity < 1.0) {
    return { ok: false, reason: '需丘陵/山地矿脉或高产出平原' };
  }
  if (kind === 'shipyard' && !isCoastal(map, prov)) {
    return { ok: false, reason: '需沿海省份' };
  }
  return { ok: true };
}

export function projectProgress(p: InvestmentProject): number {
  return clamp01(1 - p.monthsLeft / Math.max(1, p.duration));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 新建投资项目（立即从国库扣除成本；失败返回 null） */
export function startInvestment(state: GameState, map: GameMap, kind: ProjectKind, provId: number): InvestmentProject | null {
  const n = state.nations[state.playerNation];
  const def = PROJECT_DEFS[kind];
  const prov = map.provinceById.get(provId);
  if (!prov) return null;
  const unlock = projectUnlock(map, kind, prov, n.infra);
  if (!unlock.ok) return null;
  if (n.treasury < def.cost) return null;
  n.treasury -= def.cost;
  n.investCostAcc += def.cost;
  const p: InvestmentProject = {
    id: n.nextProjectId++,
    kind,
    provId,
    totalCost: def.cost,
    duration: def.duration,
    monthsLeft: def.duration,
    status: 'building',
  };
  n.projects.push(p);
  return p;
}

/** 取消在建项目：退款 = 总成本 × (1 - 进度)，退回国库 */
export function cancelInvestment(state: GameState, projectId: number): number | null {
  const n = state.nations[state.playerNation];
  const idx = n.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const p = n.projects[idx];
  if (p.status !== 'building') return null; // 已投产不可取消
  const refund = p.totalCost * (1 - projectProgress(p));
  n.treasury += refund;
  n.investRefundAcc += refund;
  n.projects.splice(idx, 1);
  return refund;
}
