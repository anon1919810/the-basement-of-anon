/**
 * 政治系统（v0.10，两大支柱）：
 * ①权力分配与行政体制 —— 政权结构（谁统治/合法性/行政效率）+ 行政力（容量 vs 消耗 → 效率修正）
 * ②改革与法律 —— 5 类法律谱系（政权/选举/人身自由/经济/权利），立法推进（支持率×合法性×行政效率）
 *
 * 设计要点：
 *  - 政权结构决定「执政联盟」：联盟权势占比 → 合法性；非联盟阶级反对改革
 *  - 选举法 6 档并列（无高低承接）：各服务不同利益集团，改写阶级政治权重
 *  - 人身自由 3 档：农奴制 / 债务奴隶（生活水平暴跌可沦为债务奴、可偿债脱离）/ 废奴
 *  - 经济 3 档并入现有 economicLaw；权利法影响生活水平下限与幸福度
 *  - 立法：玩家提出 → 月推进 = 支持率% × 合法性% × 行政效率 × 0.15 → 满 100 通过；支持率过低倒退
 */
import type { ClassId, NationId } from './types';
import { classPoliticalWeight } from './classes';
import type { GameMap } from './map';
import type { GameState } from './state';

// ---- ①政权结构 ----
export type GovStructure = 'autocracy' | 'monarchy' | 'merchantRepublic' | 'parliamentary' | 'presidential';

export interface GovDef {
  id: GovStructure;
  label: string;
  /** 执政联盟阶级（权势加权 → 合法性） */
  rulingClasses: ClassId[];
  /** 合法性基础系数（× 执政联盟权势占比） */
  legitimacyBase: number;
  /** 行政效率系数（官僚体系统治越集权越低效） */
  adminEff: number;
  /** 治理复杂度（行政消耗放大；法律越多越费） */
  complexity: number;
  desc: string;
}

export const GOV_DEFS: Record<GovStructure, GovDef> = {
  autocracy: {
    id: 'autocracy', label: '君主专制', rulingClasses: [1], legitimacyBase: 0.8, adminEff: 0.85, complexity: 1.1,
    desc: '君权神授，贵族附庸。行政靠私人效忠，效率低下但令行禁止。',
  },
  monarchy: {
    id: 'monarchy', label: '君主立宪', rulingClasses: [1, 3], legitimacyBase: 0.9, adminEff: 0.95, complexity: 1.0,
    desc: '君主统而不治，贵族与官僚共治。行政稍有效率。',
  },
  merchantRepublic: {
    id: 'merchantRepublic', label: '商人共和', rulingClasses: [2, 3], legitimacyBase: 0.85, adminEff: 1.0, complexity: 0.95,
    desc: '银行家与商贾执政，金钱开路，行政高效但重商轻民。',
  },
  parliamentary: {
    id: 'parliamentary', label: '议会共和', rulingClasses: [3, 4], legitimacyBase: 1.0, adminEff: 1.05, complexity: 1.0,
    desc: '中产与市民执掌议会。行政效率良好，合法性稳定。',
  },
  presidential: {
    id: 'presidential', label: '总统共和', rulingClasses: [3, 4, 5], legitimacyBase: 1.1, adminEff: 1.1, complexity: 1.05,
    desc: '广泛选举的共和国，庶民亦可入朝。行政高效，但众口难调。',
  },
};

/** 各国初始政权（按世界观） */
export const INITIAL_GOV: Record<NationId, GovStructure> = {
  empire: 'autocracy',
  lorraine: 'presidential',
  ianys: 'monarchy',
  orange: 'merchantRepublic',
  zalakN: 'monarchy',
  zalakS: 'monarchy',
  angland: 'merchantRepublic',
  normandy: 'autocracy',
};

// ---- ②法律谱系 ----
export type LawCategory = 'gov' | 'suffrage' | 'liberty' | 'economy' | 'rights';

export interface LawTier {
  id: string;
  label: string;
  desc: string;
}

/** 各法律类当前档位索引 → 档位定义 */
export const LAW_TIERS: Record<LawCategory, LawTier[]> = {
  gov: [
    { id: 'autocracy', label: '君主专制', desc: '君权至上' },
    { id: 'monarchy', label: '君主立宪', desc: '君统而不治' },
    { id: 'merchantRepublic', label: '商人共和', desc: '商贾执政' },
    { id: 'parliamentary', label: '议会共和', desc: '议会掌权' },
    { id: 'presidential', label: '总统共和', desc: '庶民参政权' },
  ],
  // 选举法 6 档并列：无高低承接，各服务不同利益集团
  suffrage: [
    { id: 'hereditary', label: '权力世袭', desc: '选权由血统决定' },
    { id: 'oligarchy', label: '寡头政治', desc: '少数豪门议政' },
    { id: 'landed', label: '土地选举', desc: '有地产者投票' },
    { id: 'wealth', label: '财富选举', desc: '纳税达标者投票' },
    { id: 'merit', label: '资格性选举', desc: '识字/职业资格投票' },
    { id: 'universal', label: '普选', desc: '全体成年公民投票' },
  ],
  // 人身自由 3 档：债务奴隶（生活水平暴跌可沦为债务奴、可偿债脱离）
  liberty: [
    { id: 'serfdom', label: '农奴制', desc: '奴隶世代为奴' },
    { id: 'debt', label: '债务奴隶', desc: '生活水平暴跌者可沦为债务奴，可偿债脱离' },
    { id: 'free', label: '废奴', desc: '无奴隶' },
  ],
  economy: [
    { id: 'traditionalism', label: '传统主义', desc: '政府分红 -10%，投资效率低' },
    { id: 'laissezFaire', label: '自由放任', desc: '中性，资本效率 +25%' },
    { id: 'draconian', label: '农本主义', desc: '政府分红 +15%，农地投资 +50%' },
  ],
  rights: [
    { id: 'none', label: '无保障', desc: '民如草芥' },
    { id: 'basic', label: '基本权利', desc: '人身财产受保护' },
    { id: 'labor', label: '劳工保护', desc: '工时/工资下限受保护' },
  ],
};

export const LAW_CATEGORY_LABEL: Record<LawCategory, string> = {
  gov: '政权', suffrage: '选举', liberty: '人身自由', economy: '经济', rights: '权利',
};

/** 初始法律（洛林：总统共和+财富选举+农奴制+自由放任+基本权利；他国按世界观） */
export const INITIAL_LAWS: Record<NationId, Record<LawCategory, number>> = {
  empire: { gov: 0, suffrage: 0, liberty: 0, economy: 0, rights: 0 },
  lorraine: { gov: 4, suffrage: 3, liberty: 0, economy: 1, rights: 1 },
  ianys: { gov: 1, suffrage: 2, liberty: 0, economy: 1, rights: 1 },
  orange: { gov: 2, suffrage: 3, liberty: 0, economy: 1, rights: 1 },
  zalakN: { gov: 1, suffrage: 1, liberty: 0, economy: 0, rights: 0 },
  zalakS: { gov: 1, suffrage: 2, liberty: 0, economy: 0, rights: 0 },
  angland: { gov: 2, suffrage: 4, liberty: 0, economy: 1, rights: 1 },
  normandy: { gov: 0, suffrage: 0, liberty: 0, economy: 0, rights: 0 },
};

// ---- 阶级对法律的立场（-2 强烈反对 ~ +2 强烈支持；权势加权 → 支持率） ----
type Stance = -2 | -1 | 0 | 1 | 2;

/** 选举法各档 × 阶级立场 */
export const SUFFRAGE_STANCE: Record<string, Record<ClassId, Stance>> = {
  hereditary: { 1: 2, 2: 1, 3: -1, 4: -2, 5: -2, 6: -2, 7: -2 },
  oligarchy: { 1: 1, 2: 2, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  landed: { 1: 2, 2: 1, 3: 1, 4: -1, 5: -2, 6: -2, 7: -2 },
  wealth: { 1: 1, 2: 2, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  merit: { 1: 0, 2: 1, 3: 2, 4: 1, 5: -1, 6: -2, 7: -2 },
  universal: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 2 },
};

/** 人身自由各档 × 阶级立场 */
export const LIBERTY_STANCE: Record<string, Record<ClassId, Stance>> = {
  serfdom: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -1, 6: -2, 7: -2 },
  debt: { 1: 1, 2: 1, 3: 0, 4: -1, 5: -2, 6: -1, 7: -2 },
  free: { 1: -2, 2: -1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2 },
};

/** 权利法各档 × 阶级立场 */
export const RIGHTS_STANCE: Record<string, Record<ClassId, Stance>> = {
  none: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  basic: { 1: -1, 2: 0, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
  labor: { 1: -2, 2: -2, 3: 0, 4: 1, 5: 2, 6: 2, 7: 2 },
};

/** 政权法各档 × 阶级立场（执政联盟支持 +2，被排斥旧贵族反对） */
export const GOV_STANCE: Record<string, Record<ClassId, Stance>> = {
  autocracy: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  monarchy: { 1: 1, 2: 1, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  merchantRepublic: { 1: -1, 2: 2, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  parliamentary: { 1: -2, 2: -1, 3: 2, 4: 2, 5: 0, 6: -1, 7: -2 },
  presidential: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1 },
};

/** 经济法各档立场（保守 → 自由）：农本=旧贵地主支持，自由=资本支持 */
export const ECONOMY_STANCE: Record<string, Record<ClassId, Stance>> = {
  traditionalism: { 1: 2, 2: -1, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  laissezFaire: { 1: 0, 2: 2, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  draconian: { 1: 2, 2: 0, 3: 1, 4: 0, 5: 0, 6: -1, 7: -1 },
};

/** 获取某法律类某档的阶级立场表 */
export function stanceOf(cat: LawCategory, tierId: string): Record<ClassId, Stance> {
  switch (cat) {
    case 'gov': return GOV_STANCE[tierId] ?? GOV_STANCE.autocracy;
    case 'suffrage': return SUFFRAGE_STANCE[tierId] ?? SUFFRAGE_STANCE.hereditary;
    case 'liberty': return LIBERTY_STANCE[tierId] ?? LIBERTY_STANCE.serfdom;
    case 'economy': return ECONOMY_STANCE[tierId] ?? ECONOMY_STANCE.traditionalism;
    case 'rights': return RIGHTS_STANCE[tierId] ?? RIGHTS_STANCE.none;
  }
}

// ---- 行政力 ----
/** 行政容量 = 行政支出 × 容量系数（万₭/月 → 容量） */
const ADMIN_CAP_PER_SPEND = 12;
/** 行政消耗 = 人口 × 人均 × 治理复杂度 */
const ADMIN_PER_WAN = 0.45;

export function adminCapacityOf(spendingAdmin: number): number {
  return spendingAdmin * ADMIN_CAP_PER_SPEND;
}

export function adminUsedOf(popWan: number, gov: GovStructure, lawCount: number): number {
  const def = GOV_DEFS[gov];
  return Math.max(1, popWan * ADMIN_PER_WAN * def.complexity * (1 + lawCount * 0.04));
}

export function adminEfficiencyOf(spendingAdmin: number, popWan: number, gov: GovStructure, lawCount: number): number {
  const cap = adminCapacityOf(spendingAdmin);
  const used = adminUsedOf(popWan, gov, lawCount);
  return clamp(cap / used, 0.3, 1.2);
}

// ---- 合法性 ----
export function legitimacyOf(n: {
  stability: number;
  policies: { gov: GovStructure };
  classPower?: Record<ClassId, number>;
}): number {
  const def = GOV_DEFS[n.policies.gov];
  // 执政联盟权势占比（无 classPower 时按稳定度兜底）
  let coalition = 0.5;
  if (n.classPower) {
    const total = (Object.values(n.classPower) as number[]).reduce((s, v) => s + v, 0);
    if (total > 1e-9) {
      coalition = def.rulingClasses.reduce((s, c) => s + (n.classPower?.[c] ?? 0), 0) / total;
    }
  }
  const fromCoalition = coalition * 100 * def.legitimacyBase;
  const fromStability = n.stability * 0.3;
  return clamp(fromCoalition + fromStability, 0, 100);
}

// ---- 立法推进 ----
export interface LawProgress {
  cat: LawCategory;
  target: number; // 目标档位索引
  progress: number; // 0-100
  momentum: number; // 上月推进（UI 显示）
}

/** 支持率：阶级立场 × 阶级权势占比（-2~+2 → 0~100） */
export function supportOf(
  cat: LawCategory,
  tierId: string,
  classPower: Record<ClassId, number>,
): number {
  const st = stanceOf(cat, tierId);
  const total = (Object.values(classPower) as number[]).reduce((s, v) => s + v, 0);
  if (total <= 1e-9) return 50;
  let weighted = 0;
  for (const c of Object.keys(st) as unknown as ClassId[]) {
    weighted += st[c] * (classPower[c] ?? 0);
  }
  weighted /= total; // -2 ~ +2
  return clamp(50 + weighted * 30, 0, 100);
}

/** 月度立法推进：支持率% × 合法性% × 行政效率 × 0.15 → 累计；支持率 < 15% 倒退 */
export function advanceLaw(
  p: LawProgress,
  classPower: Record<ClassId, number>,
  legitimacy: number,
  adminEff: number,
): { progress: number; momentum: number } {
  const tier = LAW_TIERS[p.cat][p.target];
  const support = supportOf(p.cat, tier.id, classPower);
  if (support < 15) {
    // 反对激烈：倒退
    return { progress: Math.max(0, p.progress - 4), momentum: -4 };
  }
  const momentum = support * (legitimacy / 100) * adminEff * 0.15;
  return { progress: Math.min(100, p.progress + momentum), momentum };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 阶级权势（由 nationClassPower 计算；供政治系统复用） */
export function nationClassPowerOf(state: GameState, map: GameMap, id: NationId): Record<ClassId, number> {
  const power: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const n = state.nations[id];
  const suffrage = n.policies.suffrage === 5; // 普选档
  for (const p of map.provinces) {
    if (p.owner !== id || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) {
      const w = classPoliticalWeight(pop.class, suffrage);
      power[pop.class] += pop.size * w;
    }
  }
  return power;
}