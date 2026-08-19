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
import type { ClassId, NationId } from './types';

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
    label: '贵族',
    members: '世袭贵族·大金融家·大地主',
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
    label: '富裕',
    members: '大银行家·资本家·富商',
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
    label: '中产',
    members: '工程师·官僚·地主·教士',
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
    label: '温饱',
    members: '职员·技术工人·富农·市民',
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
    label: '贫困',
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
    label: '赤贫',
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
    label: '奴役',
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
  1: '贵族', 2: '富裕', 3: '中产', 4: '温饱', 5: '贫困', 6: '赤贫', 7: '奴役',
};

export function classDef(c: ClassId): ClassDef {
  return CLASS_DEFS[c];
}

// ---- 各国初始阶级分布（v0.9 纯财富分布：职业与阶级解耦；阶级由经济内生演化） ----
/**
 * 洛林共和国：中产/温饱多，无奴隶；申斯戈维克帝国：奴役/赤贫多，农奴制；
 * 盎格伦撒自由城邦：富裕/贵族多，金融阶层庞大；诺曼尼亚：奴役残留。
 */
export const INITIAL_CLASS_DIST: Record<NationId, Record<ClassId, number>> = {
  lorraine: { 1: 0.02, 2: 0.05, 3: 0.18, 4: 0.3, 5: 0.3, 6: 0.13, 7: 0.02 },
  ianys: { 1: 0.02, 2: 0.05, 3: 0.15, 4: 0.28, 5: 0.3, 6: 0.17, 7: 0.03 },
  empire: { 1: 0.03, 2: 0.04, 3: 0.1, 4: 0.15, 5: 0.2, 6: 0.28, 7: 0.2 },
  orange: { 1: 0.03, 2: 0.07, 3: 0.16, 4: 0.3, 5: 0.28, 6: 0.14, 7: 0.02 },
  zalakN: { 1: 0.02, 2: 0.04, 3: 0.14, 4: 0.26, 5: 0.3, 6: 0.2, 7: 0.04 },
  zalakS: { 1: 0.02, 2: 0.05, 3: 0.15, 4: 0.27, 5: 0.29, 6: 0.18, 7: 0.04 },
  angland: { 1: 0.05, 2: 0.1, 3: 0.2, 4: 0.25, 5: 0.25, 6: 0.12, 7: 0.03 },
  normandy: { 1: 0.03, 2: 0.04, 3: 0.12, 4: 0.2, 5: 0.22, 6: 0.26, 7: 0.13 },
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
