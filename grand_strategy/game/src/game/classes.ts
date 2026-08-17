/**
 * 阶级系统（v0.3，核心新增）：7 级阶级定义 + 各国初始分布 + 政策对系数的影响。
 *
 *  - 税收：苛税打在下层（taxCoef 下层高/上层低，奴隶无财产 taxCoef=0）
 *  - 奢侈品：仅上层必享（luxuryAccess 1/0.85/0.4/0.15/0…）
 *  - 政治影响力：阶级规模 × politicalWeight → 「权势构成」
 *  - 幸福度/动乱：下层幸福权重高、奴隶恒低；动乱倾向随下层不满（unrestWeight）
 *  - 消费倍率：上层消费多（consumptionMult 作用于需求）
 *  - 资本回报分配：wealthCoef 决定精英投资收入占比（上层多）
 */
import type { ClassId, JobId, NationId } from './types';

export const CLASSES: ClassId[] = [1, 2, 3, 4, 5, 6, 7];

export interface ClassDef {
  id: ClassId;
  /** 阶级名（权势构成标题用） */
  label: string;
  /** 成员构成 */
  members: string;
  /** 税收负担系数（× 人头/盐税；0.2 上层最低 → 1.6 下层最高 → 0 奴隶无财产） */
  taxCoef: number;
  /** 奢侈品消费权重（1=必享，0=无） */
  luxuryAccess: number;
  /** 政治权重（权势构成） */
  politicalWeight: number;
  /** 消费倍率（需求放大） */
  consumptionMult: number;
  /** 基础幸福度（奴隶恒低） */
  baseHappiness: number;
  /** 资本回报分配权重（投资收入占比） */
  wealthCoef: number;
  /** 动乱权重（下层不满 → 动乱） */
  unrestWeight: number;
  /** 土地持有系数（地税负担：上层持地多） */
  landCoef: number;
}

export const CLASS_DEFS: Record<ClassId, ClassDef> = {
  1: {
    id: 1,
    label: '大贵族',
    members: '大贵族·大资本家·大地主',
    taxCoef: 0.2,
    luxuryAccess: 1.0,
    politicalWeight: 10,
    consumptionMult: 1.9,
    baseHappiness: 80,
    wealthCoef: 1.0,
    unrestWeight: 0,
    landCoef: 1.8,
  },
  2: {
    id: 2,
    label: '资本家',
    members: '大银行家·贵族·资本家',
    taxCoef: 0.4,
    luxuryAccess: 0.85,
    politicalWeight: 6,
    consumptionMult: 1.6,
    baseHappiness: 74,
    wealthCoef: 0.7,
    unrestWeight: 0,
    landCoef: 1.4,
  },
  3: {
    id: 3,
    label: '技术阶层',
    members: '技术阶层·官僚·地主·教士',
    taxCoef: 0.7,
    luxuryAccess: 0.4,
    politicalWeight: 3,
    consumptionMult: 1.3,
    baseHappiness: 66,
    wealthCoef: 0.45,
    unrestWeight: 0.2,
    landCoef: 1.0,
  },
  4: {
    id: 4,
    label: '市民工匠',
    members: '职员·工匠·富农·市民',
    taxCoef: 1.0,
    luxuryAccess: 0.15,
    politicalWeight: 1.2,
    consumptionMult: 1.05,
    baseHappiness: 60,
    wealthCoef: 0.25,
    unrestWeight: 0.5,
    landCoef: 0.6,
  },
  5: {
    id: 5,
    label: '自耕农工人',
    members: '自耕农·工人',
    taxCoef: 1.3,
    luxuryAccess: 0,
    politicalWeight: 0.8,
    consumptionMult: 0.85,
    baseHappiness: 54,
    wealthCoef: 0.05,
    unrestWeight: 1.0,
    landCoef: 0.3,
  },
  6: {
    id: 6,
    label: '无业佃农',
    members: '无业游民·佃农',
    taxCoef: 1.6,
    luxuryAccess: 0,
    politicalWeight: 0.3,
    consumptionMult: 0.65,
    baseHappiness: 46,
    wealthCoef: 0,
    unrestWeight: 1.6,
    landCoef: 0.1,
  },
  7: {
    id: 7,
    label: '奴隶',
    members: '奴隶',
    taxCoef: 0,
    luxuryAccess: 0,
    politicalWeight: 0,
    consumptionMult: 0.5,
    baseHappiness: 36,
    wealthCoef: 0,
    unrestWeight: 2.0,
    landCoef: 0,
  },
};

export const CLASS_LABEL: Record<ClassId, string> = {
  1: '大贵族', 2: '资本家', 3: '技术阶层', 4: '市民工匠', 5: '自耕农工人', 6: '无业佃农', 7: '奴隶',
};

export function classDef(c: ClassId): ClassDef {
  return CLASS_DEFS[c];
}

// ---- 各国初始阶级分布（世界观，v0.4 八国） ----
/**
 * 申斯戈维克帝国：农奴制 → 大量 奴隶/佃农 + 地主/大贵族，少量 官僚/技术阶层
 * 洛林共和国：市民/工人/资本家/官僚/技术阶层 为主，少贵族，无奴隶
 * 伊尼亚斯王国：工人/工匠/资本家/地主 + 贵族议会传统
 * 奥兰治亲王国：市民/商人工匠 为主，滨海商业阶层
 * 北/南扎拉克：工业萌芽 + 民族主义 → 工人/工匠/农民为主，选帝侯贵族少量
 * 盎格伦撒自由城邦：市民/商人/资本家/大银行家 为顶，金融阶层庞大
 * 诺曼尼亚帝国：地主/官僚 + 农奴残留，守旧落后
 */
export const INITIAL_CLASS_MIX: Record<NationId, Record<JobId, Partial<Record<ClassId, number>>>> = {
  lorraine: {
    farmer: { 4: 0.3, 5: 0.45, 6: 0.25 },
    miner: { 4: 0.15, 5: 0.85 },
    artisan: { 3: 0.3, 4: 0.7 },
    engineer: { 1: 0.08, 2: 0.35, 3: 0.57 },
  },
  ianys: {
    farmer: { 4: 0.35, 5: 0.4, 6: 0.25 },
    miner: { 4: 0.2, 5: 0.8 },
    artisan: { 3: 0.4, 4: 0.6 },
    engineer: { 1: 0.1, 2: 0.4, 3: 0.5 },
  },
  empire: {
    farmer: { 4: 0.04, 5: 0.08, 6: 0.28, 7: 0.6 },
    miner: { 5: 0.3, 6: 0.4, 7: 0.3 },
    artisan: { 3: 0.2, 4: 0.45, 5: 0.35 },
    engineer: { 1: 0.2, 2: 0.3, 3: 0.5 },
  },
  orange: {
    farmer: { 4: 0.4, 5: 0.4, 6: 0.2 },
    miner: { 4: 0.2, 5: 0.8 },
    artisan: { 2: 0.15, 3: 0.35, 4: 0.5 },
    engineer: { 1: 0.05, 2: 0.4, 3: 0.55 },
  },
  zalakN: {
    farmer: { 4: 0.15, 5: 0.4, 6: 0.45 },
    miner: { 4: 0.25, 5: 0.75 },
    artisan: { 3: 0.3, 4: 0.7 },
    engineer: { 1: 0.05, 2: 0.3, 3: 0.65 },
  },
  zalakS: {
    farmer: { 4: 0.2, 5: 0.42, 6: 0.38 },
    miner: { 4: 0.3, 5: 0.7 },
    artisan: { 3: 0.35, 4: 0.65 },
    engineer: { 1: 0.08, 2: 0.35, 3: 0.57 },
  },
  angland: {
    farmer: { 3: 0.15, 4: 0.45, 5: 0.4 },
    miner: { 4: 0.5, 5: 0.5 },
    artisan: { 2: 0.25, 3: 0.4, 4: 0.35 },
    engineer: { 1: 0.1, 2: 0.5, 3: 0.4 },
  },
  normandy: {
    farmer: { 3: 0.2, 4: 0.1, 5: 0.2, 6: 0.3, 7: 0.2 },
    miner: { 5: 0.4, 6: 0.4, 7: 0.2 },
    artisan: { 3: 0.3, 4: 0.5, 5: 0.2 },
    engineer: { 1: 0.15, 2: 0.3, 3: 0.55 },
  },
};

// ---- 政策对系数的修正 ----

/** 累进税：上层税负↑（×1.4…1.15），下层↓（×0.8/0.65），奴隶不变 */
export const PROGRESSIVE_TAX_MULT: Record<ClassId, number> = {
  1: 1.4, 2: 1.3, 3: 1.15, 4: 1.0, 5: 0.8, 6: 0.65, 7: 0,
};

/** 普选：下层政治权重↑，上层↓ */
export const SUFFRAGE_POWER_MULT: Record<ClassId, number> = {
  1: 0.6, 2: 0.7, 3: 0.85, 4: 1.1, 5: 1.4, 6: 1.6, 7: 1.7,
};

/** 普选对幸福度的微调（下层受益、上层不满） */
export const SUFFRAGE_HAPPINESS: Record<ClassId, number> = {
  1: -2, 2: -2, 3: -1, 4: 1, 5: 2, 6: 2, 7: 0,
};

/** 累进税对幸福度的微调（上层多缴不满、下层减负受益） */
export const PROGRESSIVE_HAPPINESS: Record<ClassId, number> = {
  1: -4, 2: -3, 3: -1.5, 4: 0.5, 5: 2, 6: 3, 7: 0,
};

/** 实际税收系数（含累进税政策） */
export function classTaxCoef(c: ClassId, progressive: boolean): number {
  const base = CLASS_DEFS[c].taxCoef;
  if (!progressive) return base;
  return base * PROGRESSIVE_TAX_MULT[c];
}

/** 实际政治权重（含普选政策） */
export function classPoliticalWeight(c: ClassId, suffrage: boolean): number {
  const base = CLASS_DEFS[c].politicalWeight;
  if (!suffrage) return base;
  return base * SUFFRAGE_POWER_MULT[c];
}

/** 奴隶是否存在于该国（政策判定用） */
export function classIsSlave(c: ClassId): boolean {
  return c === 7;
}
