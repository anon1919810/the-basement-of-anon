/**
 * 建筑投资（v0.3，investment.ts 重构为 buildings）：国库投入产业链建筑，按省份选址。
 *
 *  - 每建筑：{kind, 名称, 输入(每月单位), 输出, 技能要求, 省资源/基建/半成品解锁, 成本/工期/产能/运营成本}
 *  - 加工损耗：输出 < 输入量（铁锭 = 铁矿×2 + 煤×1 → 铁锭×2），价值随加工链上升
 *  - 技能链：农民/矿工/工匠/工程师 —— 建筑需对应职业 POP 在场（skillReqPop），不足则产能打折
 *  - 下游建筑以上游半成品为输入（炼钢厂吃铁锭 → 炼钢厂解锁需铁锭；机械厂/兵工厂需钢材）
 *  - 船坞需沿海 + 港口基建；奢侈品工坊需高识字率
 *  - 运营：建筑消耗输入（从国家库存扣除，参与市场定价）、产出进入国家市场供给
 *    → 月度回报 = 产出 × 市价 − 输入 × 市价 − 运营成本（随市价波动可亏损）
 */
import type { GameMap, Province } from './map';
import { isCoastal } from './logistics';
import type { GameState } from './state';
import type { GoodId, JobId } from './types';
import { provinceHasResource } from './resources';
import { zeroGoods } from './market';

export type BuildingKind =
  | 'farm' // 农场
  | 'cottonFarm' // 棉田
  | 'sawmill' // 锯木厂
  | 'textile' // 纺织厂
  | 'clothingWorks' // 服装厂
  | 'coalMine' // 煤矿
  | 'ironMine' // 铁矿
  | 'ironWorks' // 炼铁厂
  | 'steelWorks' // 炼钢厂
  | 'toolWorks' // 工具厂
  | 'armory' // 兵工厂
  | 'shipyard' // 船坞
  | 'luxuryWorkshop'; // 奢侈品工坊

export type BuildingCategory = 'agriculture' | 'extraction' | 'processing' | 'heavy' | 'fine';

export interface BuildingDef {
  kind: BuildingKind;
  label: string;
  category: BuildingCategory;
  /** 技能要求（对应职业 POP） */
  skill: JobId;
  /** 输入（每月单位，按满产能） */
  inputs: Partial<Record<GoodId, number>>;
  /** 输出商品 */
  output: GoodId;
  /** 满产能月产出（单位/月，同时进入国家市场供给） */
  capacity: number;
  /** 建造成本（万₭） */
  cost: number;
  /** 工期（月） */
  duration: number;
  /** 单位运营成本（万₭/月，闲置时按维护比例计） */
  opCost: number;
  /** 基建门槛 */
  infra: { roads?: number; ports?: number };
  /** 省资源解锁条件（如棉田需 cotton） */
  requireResource?: 'coal' | 'iron' | 'cotton' | 'timber';
  /** 半成品解锁条件（国家已有该商品产出/库存，如炼钢厂需铁锭） */
  requireGood?: GoodId;
  /** 识字率门槛（奢侈品工坊） */
  requireLiteracy?: number;
  /** 需沿海 */
  requireCoastal?: boolean;
  desc: string;
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  farm: {
    kind: 'farm',
    label: '农场',
    category: 'agriculture',
    skill: 'farmer',
    inputs: {},
    output: 'food',
    capacity: 2.5,
    cost: 80,
    duration: 4,
    opCost: 0.3,
    infra: {},
    desc: '精耕农田，提高粮食产出；沃土省加成更高。',
  },
  cottonFarm: {
    kind: 'cottonFarm',
    label: '棉田',
    category: 'agriculture',
    skill: 'farmer',
    inputs: {},
    output: 'cotton',
    capacity: 1.6,
    cost: 100,
    duration: 5,
    opCost: 0.35,
    infra: {},
    requireResource: 'cotton',
    desc: '暖湿平原植棉，纺织业原料之源。',
  },
  sawmill: {
    kind: 'sawmill',
    label: '锯木厂',
    category: 'processing',
    skill: 'artisan',
    inputs: { timber: 2.0 },
    output: 'lumber',
    capacity: 1.6,
    cost: 90,
    duration: 4,
    opCost: 0.5,
    infra: {},
    requireResource: 'timber',
    desc: '木材 → 木料（损耗 20%），造船/基建的建材。',
  },
  textile: {
    kind: 'textile',
    label: '纺织厂',
    category: 'processing',
    skill: 'artisan',
    inputs: { cotton: 2.0 },
    output: 'cloth',
    capacity: 1.5,
    cost: 150,
    duration: 6,
    opCost: 0.8,
    infra: { roads: 10 },
    desc: '棉花 → 布料（损耗 25%），衣物与帆船的中间品。',
  },
  clothingWorks: {
    kind: 'clothingWorks',
    label: '服装厂',
    category: 'fine',
    skill: 'artisan',
    inputs: { cloth: 2.0 },
    output: 'clothing',
    capacity: 1.6,
    cost: 130,
    duration: 5,
    opCost: 0.7,
    infra: {},
    desc: '布料 → 衣物（损耗 20%），满足大众衣着需求。',
  },
  coalMine: {
    kind: 'coalMine',
    label: '煤矿',
    category: 'extraction',
    skill: 'miner',
    inputs: {},
    output: 'coal',
    capacity: 2.0,
    cost: 160,
    duration: 6,
    opCost: 0.6,
    infra: { roads: 10 },
    requireResource: 'coal',
    desc: '采掘煤炭：冶炼/取暖/蒸汽之源，工业的血液。',
  },
  ironMine: {
    kind: 'ironMine',
    label: '铁矿',
    category: 'extraction',
    skill: 'miner',
    inputs: {},
    output: 'ironOre',
    capacity: 1.8,
    cost: 180,
    duration: 7,
    opCost: 0.65,
    infra: { roads: 10 },
    requireResource: 'iron',
    desc: '采掘铁矿石，炼铁厂的上游。',
  },
  ironWorks: {
    kind: 'ironWorks',
    label: '炼铁厂',
    category: 'heavy',
    skill: 'engineer',
    inputs: { ironOre: 2.0, coal: 1.0 },
    output: 'iron',
    capacity: 2.0,
    cost: 200,
    duration: 8,
    opCost: 1.1,
    infra: { roads: 15 },
    desc: '铁矿×2 + 煤×1 → 铁锭×2；需煤矿省或港口（进口矿）。',
  },
  steelWorks: {
    kind: 'steelWorks',
    label: '炼钢厂',
    category: 'heavy',
    skill: 'engineer',
    inputs: { iron: 2.0, coal: 1.0 },
    output: 'steel',
    capacity: 2.0,
    cost: 240,
    duration: 9,
    opCost: 1.3,
    infra: { roads: 15 },
    requireGood: 'iron',
    desc: '铁锭×2 + 煤×1 → 钢材×2；需本国已产铁锭。',
  },
  toolWorks: {
    kind: 'toolWorks',
    label: '工具厂',
    category: 'fine',
    skill: 'engineer',
    inputs: { steel: 2.0 },
    output: 'tools',
    capacity: 1.5,
    cost: 220,
    duration: 8,
    opCost: 1.2,
    infra: {},
    requireGood: 'steel',
    desc: '钢材 → 工具（损耗 25%），基建/农具的必需品。',
  },
  armory: {
    kind: 'armory',
    label: '兵工厂',
    category: 'fine',
    skill: 'engineer',
    inputs: { steel: 1.0 },
    output: 'weapons',
    capacity: 1.5,
    cost: 260,
    duration: 10,
    opCost: 1.4,
    infra: {},
    requireGood: 'steel',
    desc: '钢材 → 武器；军费消耗武器。',
  },
  shipyard: {
    kind: 'shipyard',
    label: '船坞',
    category: 'fine',
    skill: 'engineer',
    inputs: { lumber: 1.0, steel: 1.0, cloth: 1.0 },
    output: 'sailShip',
    capacity: 1.0,
    cost: 320,
    duration: 12,
    opCost: 1.5,
    infra: { ports: 15 },
    requireGood: 'steel',
    requireCoastal: true,
    desc: '木料 + 钢材 + 布料 → 帆船；需沿海省份与港口。',
  },
  luxuryWorkshop: {
    kind: 'luxuryWorkshop',
    label: '奢侈品工坊',
    category: 'fine',
    skill: 'engineer',
    inputs: { cloth: 1.0 },
    output: 'luxury',
    capacity: 0.8,
    cost: 280,
    duration: 10,
    opCost: 1.3,
    infra: {},
    requireLiteracy: 0.55,
    desc: '布料精工 → 奢侈品；需高识字率工匠，供上层阶级消费。',
  },
};

export const BUILDING_KINDS: BuildingKind[] = [
  'farm', 'cottonFarm', 'sawmill', 'textile', 'clothingWorks',
  'coalMine', 'ironMine', 'ironWorks', 'steelWorks',
  'toolWorks', 'armory', 'shipyard', 'luxuryWorkshop',
];

/** 建筑技能需求规模（万人）：产能 × 0.3，至少 0.2 万 */
export function buildingSkillReqPop(def: BuildingDef): number {
  return Math.max(0.2, def.capacity * 0.3);
}

export interface InvestmentProject {
  id: number;
  kind: BuildingKind;
  provId: number;
  totalCost: number;
  duration: number;
  monthsLeft: number;
  status: 'building' | 'active';
  // ---- v0.3 建筑运营记录（UI/断言用） ----
  /** 上月技能满足系数 0-1（无对应职业 POP → <1 产能打折） */
  lastSkillFactor: number;
  /** 上月输入可用系数 0-1（库存不足 → 减产） */
  lastRunFactor: number;
  /** 上月实际产出 */
  lastOutput: number;
  /** 上月输入消耗（单位，守恒断言用） */
  lastInputUsed: Record<GoodId, number>;
  /** 上月输入成本（万₭） */
  lastInputCost: number;
  /** 上月产出收入（万₭） */
  lastRevenue: number;
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
}

export interface NationBuildingView {
  stocks: Record<GoodId, number>;
  projects: InvestmentProject[];
  literacy: number;
}

/** 半成品解锁判定：国家库存 > 0.5 或有在产建筑产出该商品 */
export function nationHasGood(view: NationBuildingView, g: GoodId): boolean {
  if ((view.stocks[g] ?? 0) > 0.5) return true;
  return view.projects.some((p) => p.status === 'active' && BUILDING_DEFS[p.kind].output === g);
}

/** 省份/基建/资源/半成品解锁检查（UI 与 sim 共用） */
export function buildingUnlock(map: GameMap, kind: BuildingKind, prov: Province, infra: { roads: number; ports: number }, nation: NationBuildingView): UnlockResult {
  const def = BUILDING_DEFS[kind];
  if (infra.roads < (def.infra.roads ?? 0)) {
    return { ok: false, reason: `道路需 ≥${def.infra.roads}` };
  }
  if (infra.ports < (def.infra.ports ?? 0)) {
    return { ok: false, reason: `港口需 ≥${def.infra.ports}` };
  }
  if (def.requireCoastal && !isCoastal(map, prov)) {
    return { ok: false, reason: '需沿海省份' };
  }
  if (def.requireResource && !provinceHasResource(prov, def.requireResource)) {
    return { ok: false, reason: `需省资源「${def.requireResource}」` };
  }
  if (def.requireGood && !nationHasGood(nation, def.requireGood)) {
    return { ok: false, reason: `需本国已产「${def.requireGood}」` };
  }
  if (def.requireLiteracy !== undefined && nation.literacy < def.requireLiteracy) {
    return { ok: false, reason: `识字率需 ≥${(def.requireLiteracy * 100).toFixed(0)}%` };
  }
  // 炼铁厂特殊：煤矿省或港口（进口矿）
  if (kind === 'ironWorks' && !provinceHasResource(prov, 'coal') && infra.ports < 15) {
    return { ok: false, reason: '需煤矿省或港口≥15' };
  }
  return { ok: true };
}

export function projectProgress(p: InvestmentProject): number {
  return clamp01(1 - p.monthsLeft / Math.max(1, p.duration));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 新建建筑项目（立即从国库扣除成本；失败返回 null） */
export function startInvestment(state: GameState, map: GameMap, kind: BuildingKind, provId: number): InvestmentProject | null {
  const n = state.nations[state.playerNation];
  const def = BUILDING_DEFS[kind];
  const prov = map.provinceById.get(provId);
  if (!prov) return null;
  const unlock = buildingUnlock(map, kind, prov, n.infra, { stocks: n.stocks, projects: n.projects, literacy: n.literacy });
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
    lastSkillFactor: 0,
    lastRunFactor: 0,
    lastOutput: 0,
    lastInputUsed: zeroGoods(),
    lastInputCost: 0,
    lastRevenue: 0,
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
