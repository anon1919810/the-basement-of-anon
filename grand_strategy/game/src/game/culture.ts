/**
 * 文化·宗教系统（v0.14）：
 *  - 文化 = 种族的上一层组织（语言/习俗）；文化组 = 亲合/冲突单位（外交预留）。
 *  - 宗教 = 平行于文化的信仰维度；POP 新增 religion 字段（创建时按种族派生）。
 *  - 宗教谱系：母教会 + 变体（同源分裂，如 烛火圣教/烛火南礼，河母教会/河母礼）；
 *    变体与普通宗教同待遇，仅名称与修正不同。
 *  - 教士职业：类教师略高；倾向随宗教（保守/进步/乡土/务实）。
 */
import type { RaceId } from './types';

// ---- 文化组 ----
export type CultureGroupId =
  | 'govik' // 戈维克文化组（乌萨斯/德拉科）
  | 'normanmasnavia' // 诺曼玛斯纳维尼亚文化组（诺曼/菲林/黎博利）
  | 'coastal' // 滨海文化组（阿戈尔）
  | 'zarasavi' // 扎拉萨维文化组（扎拉克）
  | 'sarkaz'; // 萨卡兹文化组（散居）

export const CULTURE_GROUP_LABEL: Record<CultureGroupId, string> = {
  govik: '戈维克文化组',
  normanmasnavia: '诺曼玛斯纳维尼亚文化组',
  coastal: '滨海文化组',
  zarasavi: '扎拉萨维文化组',
  sarkaz: '萨卡兹文化组',
};

/** 种族 → 文化组（文化 = 种族一对一，避免变量爆炸） */
export const RACE_CULTURE_GROUP: Record<RaceId, CultureGroupId> = {
  ursus: 'govik',
  draco: 'govik',
  norman: 'normanmasnavia',
  feline: 'normanmasnavia',
  liberi: 'normanmasnavia',
  aegir: 'coastal',
  zalak: 'zarasavi',
  sarkaz: 'sarkaz',
};

// ---- 宗教 ----
export type ReligionId =
  | 'candle' // 烛火圣教（乌萨斯/德拉科，北境母教会）
  | 'candleSouth' // 烛火南礼（诺曼，烛火变体）
  | 'reason' // 理性会（洛林/黎博利，启蒙）
  | 'riverMother' // 河母教会（萨卡兹，组织化部族）
  | 'riverRite' // 河母礼（扎拉克，河母变体）
  | 'abyss'; // 渊潮信仰（阿戈尔）

export const RELIGION_LABEL: Record<ReligionId, string> = {
  candle: '烛火圣教',
  candleSouth: '烛火南礼',
  reason: '理性会',
  riverMother: '河母教会',
  riverRite: '河母礼',
  abyss: '渊潮信仰',
};

/** 宗教谱系（同源分裂） */
export const RELIGION_FAMILY: Record<ReligionId, string> = {
  candle: '烛火谱系',
  candleSouth: '烛火谱系',
  reason: '理性会',
  riverMother: '河母谱系',
  riverRite: '河母谱系',
  abyss: '渊潮信仰',
};

/** 种族 → 宗教 */
export const RACE_RELIGION: Record<RaceId, ReligionId> = {
  ursus: 'candle',
  draco: 'candle',
  norman: 'candleSouth',
  feline: 'reason',
  liberi: 'reason',
  sarkaz: 'riverMother',
  zalak: 'riverRite',
  aegir: 'abyss',
};

/** 宗教 → 教士政治倾向（立法支持率修正 %）：保守为负（反改革）、进步为正 */
export const RELIGION_CLERGY_TILT: Record<ReligionId, number> = {
  candle: -5, // 烛火圣教：极保守
  candleSouth: -3, // 烛火南礼：保守（略温和）
  reason: 3, // 理性会：温和进步
  riverMother: -2, // 河母教会：保守乡土
  riverRite: -2, // 河母礼：保守乡土
  abyss: 0, // 渊潮信仰：开放务实
};

/** 宗教 → 教士幸福倾向（基准幸福微调） */
export const RELIGION_CLERGY_HAPPY: Record<ReligionId, number> = {
  candle: 2, candleSouth: 1, reason: 0, riverMother: 1, riverRite: 1, abyss: 0,
};

/** 宗教是否组织化（有教士阶层）：全部组织化（v0.14 简化——变体同待遇） */
export const RELIGION_HAS_CLERGY: Record<ReligionId, boolean> = {
  candle: true, candleSouth: true, reason: true, riverMother: true, riverRite: true, abyss: true,
};
