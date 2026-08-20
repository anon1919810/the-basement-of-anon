/**
 * 外交系统（v0.16）：
 *  - 关系：-100 ~ +100（历史基础 + 自然漂移 + 玩家行动）
 *  - 威望：人口/GDP/军力/商品霸权 四维加权；外交声誉计入威望
 *  - 外交点数（DP）：每月由威望+行政力生成，行动消耗；外交声誉（DR）影响成功率
 *  - 贸易协定三级：市场协定/关税协定(-20~80%谈判)/最惠国(-95%)
 *  - 投资权：单向/双向，投资池 20% 再投资汇入对方
 *  - 附属国三级：合作国/附属国/傀儡国（上贡/关税/投资/外交自主/受袭响应）
 *  - 禁运：我方/他国企业不得售商品至某国；被禁运国获"放弃禁运"宣战借口
 *  - 战争分：敌我单轴 -100 ~ +100（占领/歼灭/击沉/掠夺对称计分）
 *  - AI 回应：仅被动（玩家唯一主动方）
 */
import type { GameMap } from './map';
import type { GameState, NationState } from './state';
import type { NationId } from './types';
import { NATIONS } from './nations';
import { RACE_CULTURE_GROUP } from './culture';
import { effectiveNavy } from './maritime';

/** 附属国等级 */
export type VassalLevel = 'none' | 'cooperate' | 'vassal' | 'puppet';

export interface DiploEntry {
  /** 关系 -100~100 */
  relation: number;
  /** 贸易协定级（0 无 / 1 市场 / 2 关税 / 3 最惠国） */
  tradePact: number;
  /** 关税协定谈判档（-20%~-80%，0=20% 1=40% 2=60% 3=80%） */
  pactTier: number;
  /** 投资权：0 无 / 1 我方投对方 / 2 对方投我方 / 3 双向 */
  investRight: number;
  /** 禁运：true = 我方禁运对方 */
  embargo: boolean;
  /** 附属等级（对方为我的附属） */
  vassal: VassalLevel;
  /** 傀儡国商品是否被宗主市场接纳 */
  acceptPuppetGoods: boolean;
  /** 宣战借口（true = 我持借口可宣战） */
  casusBelli: boolean;
  /** 战争状态 */
  atWar: boolean;
  /** 停战冷却（月） */
  truceMonths: number;
  /** 战争分 -100~100 */
  warScore: number;
}

export function newDiploEntry(): DiploEntry {
  return {
    relation: 0, tradePact: 0, pactTier: 0, investRight: 0, embargo: false,
    vassal: 'none', acceptPuppetGoods: true, casusBelli: false,
    atWar: false, truceMonths: 0, warScore: 0,
  };
}

// ---- 历史基础（世界观预置） ----
export const HISTORICAL_RELATION: Record<string, number> = {
  'zalakN-zalakS': -40, 'zalakS-zalakN': -40,
  'empire-ianys': -35, 'ianys-empire': -35,
  'empire-normandy': -25, 'normandy-empire': -25,
  'orange-angland': 40, 'angland-orange': 40,
  'lorraine-ianys': 25, 'ianys-lorraine': 25,
  'empire-lorraine': -20, 'lorraine-empire': -20,
  'empire-orange': -15, 'orange-empire': -15,
  'normandy-angland': -10, 'angland-normandy': -10,
};

export function histRel(a: NationId, b: NationId): number {
  const k = `${a}-${b}`;
  return HISTORICAL_RELATION[k] ?? 0;
}

// ---- 威望（四维加权 + 声誉） ----
/** 威望 = 人口分×0.25 + GDP分×0.3 + 军力分×0.3 + 商品霸权分×0.15 */
export function prestigeOf(state: GameState, map: GameMap, id: NationId): number {
  const n = state.nations[id];
  const popScore = Math.log10(Math.max(1, n.popWan)) * 40;
  const gdpScore = (n.monthly.income * 12 + Math.max(0, n.treasury) * 0.1) / 8;
  const milScore = militaryScore(state, map, id);
  const goodsScore = goodsHegemony(state, map, id);
  const base = popScore * 0.25 + gdpScore * 0.3 + milScore * 0.3 + goodsScore * 0.15;
  // 外交声誉计入威望（DR 100 → +10%）
  const dr = n.diploReputation ?? 0;
  return Math.max(0, base * (1 + dr * 0.001));
}

/** 军力 = 陆军投射 + 海军投射 */
export function militaryScore(state: GameState, map: GameMap, id: NationId): number {
  const n = state.nations[id];
  // 陆军：军人 POP × 后勤投射（基建）
  let army = 0;
  for (const p of map.provinces) {
    if (p.owner !== id || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) if (pop.job === 'soldier') army += pop.size;
  }
  const projection = 1 + (n.infra.roads + n.infra.ports) * 0.002;
  const armyScore = army * projection;
  // 海军：军舰 × 系数（军舰=商船4倍贵 → 系数高）
  const navyScore = (effectiveNavy(state) > 0 ? effectiveNavy(state) * 2 : 0);
  return armyScore + navyScore;
}

/** 商品霸权：每商品全球前三生产国加分（测试平衡） */
export function goodsHegemony(state: GameState, _map: GameMap, id: NationId): number {
  // 简化：用国家市场 supply 总量代表生产规模（精确到商品的全球排名在测试中做）
  const n = state.nations[id];
  let total = 0;
  for (const g of Object.keys(n.market) as (keyof typeof n.market)[]) {
    total += n.market[g]?.supply ?? 0;
  }
  return Math.min(60, total * 0.5);
}

// ---- 外交点数 / 声誉 ----
/** 每月外交点数 = 10 + 威望/100 + 行政力×5（上限 100 积攒） */
export function monthlyDiploPoints(n: NationState): number {
  return 10 + (n.prestige ?? 0) / 100 + (n.adminEff ?? 1) * 5;
}

/** 外交行动成本表 */
export const DP_COST: Record<string, number> = {
  establish: 5, improve: 10, aid: 15, pact1: 8, pact2: 12, pact3: 16,
  invest: 12, armsSale: 8, armsRequest: 8, loan: 10, embargo: 10, coEmbargo: 10,
  threatTariff: 12, vassalize: 20, border: 5, insult: 8, war: 25,
};

/** 尝试外交行动：DP 足够且返回结果 */
export function spendDiplo(n: NationState, cost: number): boolean {
  if ((n.diploPoints ?? 0) < cost) return false;
  n.diploPoints = (n.diploPoints ?? 0) - cost;
  return true;
}

/** 自然漂移（每季）：文化组亲合 + 宗教亲合 + 意识形态 + 贸易 + 民族法观感 + 国力忌惮 */
export function driftOf(state: GameState, map: GameMap, a: NationId, b: NationId): number {
  const na = state.nations[a];
  const nb = state.nations[b];
  // 主体文化组
  const ca = mainCultureGroup(state, map, a);
  const cb = mainCultureGroup(state, map, b);
  let d = 0;
  if (ca === cb) d += 10;
  // 意识形态（政权相似度）
  const ga = na.policies.gov, gb = nb.policies.gov;
  if (ga === gb) d += 5;
  const autocratic = ['autocracy'].includes(ga);
  const autocraticB = ['autocracy'].includes(gb);
  if (autocratic !== autocraticB) d -= 5;
  // 贸易协定
  const entry = na.diplomacy?.[b];
  if (entry?.tradePact === 3) d += 6;
  else if (entry?.tradePact === 2) d += 4;
  else if (entry?.tradePact === 1) d += 2;
  else if (entry?.embargo) d -= 5;
  return d;
}

/** 主体文化组（人口最多） */
export function mainCultureGroup(state: GameState, map: GameMap, id: NationId): string {
  const counts: Record<string, number> = {};
  for (const p of map.provinces) {
    if (p.owner !== id || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) {
      const g = RACE_CULTURE_GROUP[pop.race];
      counts[g] = (counts[g] ?? 0) + pop.size;
    }
  }
  let best = 'govik', n = -1;
  for (const [g, v] of Object.entries(counts)) if (v > n) { best = g; n = v; }
  return best;
}

// ---- 附属国 ----
export const VASSAL_TRIBUTE: Record<VassalLevel, number> = {
  none: 0, cooperate: 0.03, vassal: 0.06, puppet: 0.1,
};

/** 附属国上贡（每季）：对方国库收入 × 比率 → 宗主 */
export function settleTribute(state: GameState): void {
  const id = state.playerNation;
  const n = state.nations[id];
  for (const oid of Object.keys(n.diplomacy) as NationId[]) {
    const e = n.diplomacy[oid];
    if (e.vassal === 'none') continue;
    const other = state.nations[oid];
    const tribute = other.monthly.income * VASSAL_TRIBUTE[e.vassal];
    if (tribute > 0.01) {
      other.treasury = Math.max(0, other.treasury - tribute);
      n.treasury += tribute;
      n.monthly.finance += tribute; // 记账（守恒）
    }
  }
}

// ---- 战争分（敌我单轴 -100~100，对称计分） ----
/** 月度战争分结算：占领/歼灭/击沉/掠夺（确定性；测试平衡） */
export function settleWarScore(state: GameState, map: GameMap): void {
  const id = state.playerNation;
  const n = state.nations[id];
  for (const oid of Object.keys(n.diplomacy) as NationId[]) {
    const e = n.diplomacy[oid];
    if (!e.atWar) continue;
    // 简化确定性模型：双方军力对比 → 战果（每月小幅变动）
    const myMil = militaryScore(state, map, id);
    const foeMil = militaryScore(state, map, oid);
    const ratio = myMil / Math.max(1e-9, myMil + foeMil);
    const delta = (ratio - 0.5) * 12; // 每季 ±6 内
    e.warScore = Math.max(-100, Math.min(100, e.warScore + delta));
    const foeEntry = state.nations[oid].diplomacy?.[id];
    if (foeEntry) foeEntry.warScore = -e.warScore;
  }
}

/** 和谈条款（按战争分可选项） */
export interface PeaceTerm {
  id: string;
  label: string;
  minScore: number; // 我方需达成的战争分
}

export const PEACE_TERMS: PeaceTerm[] = [
  { id: 'reparations1', label: '赔款一次性（对方国库30%，≤500万）', minScore: 20 },
  { id: 'reparations2', label: '赔款分期（15%+年息，10年）', minScore: 10 },
  { id: 'cession', label: '割地（1-3省）', minScore: 40 },
  { id: 'market', label: '开放市场（强制一级贸易协定）', minScore: 15 },
  { id: 'ships', label: '军舰割让（对方20%）', minScore: 25 },
  { id: 'vassalize', label: '附庸化（对方降为附属国）', minScore: 50 },
  { id: 'disarm', label: '解除军备（对方陆军容量-50%）', minScore: 30 },
  { id: 'liftEmbargo', label: '放弃禁运（被禁运方诉求）', minScore: 0 },
  { id: 'statusQuo', label: '恢复原状（白和）', minScore: -15 },
];

/** 和谈：按战争分结算结果 */
export function peaceResult(warScore: number): { label: string; score: number } {
  if (warScore >= 50) return { label: '大胜（可要求附庸/割地）', score: 0 };
  if (warScore >= 20) return { label: '小胜（可赔款）', score: 0 };
  if (warScore > -20) return { label: '胶着（白和）', score: 0 };
  if (warScore > -50) return { label: '小败（让步）', score: 0 };
  return { label: '大败（割地赔款）', score: 0 };
}

// ---- v0.16 外交行动实现 ----

export interface DiploResult {
  ok: boolean;
  reason?: string;
  relation?: number;
  dr?: number;
  message?: string;
}

/** 建交（DP 5） */
export function establish(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.establish)) return { ok: false, reason: '外交点数不足' };
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 2));
  return { ok: true, dr: 2, message: `与 ${NATIONS[oid].name} 建交` };
}

/** 改善关系（DP 10；合并互换领事：解锁情报） */
export function improve(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.improve)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  if (n.treasury < 50) return { ok: false, reason: '国库不足（需 50 万₭）' };
  n.treasury -= 50;
  e.relation = Math.min(100, e.relation + 15);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 2));
  return { ok: true, relation: 15, dr: 2, message: `改善与 ${NATIONS[oid].name} 关系（送礼 50 万₭）` };
}

/** 经济援助（DP 15；每月支付对方国库收入 5%，持续至终止） */
export function aid(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.aid)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  const myPower = (n.prestige ?? 0) * (n.monthly.income + 1);
  const theirPower = (state.nations[oid].prestige ?? 0) * (state.nations[oid].monthly.income + 1);
  if (myPower <= theirPower) return { ok: false, reason: '我方国力不足（需威望与经济总量高于对方）' };
  e.relation = Math.min(100, e.relation + 15);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 3));
  return { ok: true, relation: 15, dr: 3, message: `对 ${NATIONS[oid].name} 提供持续经济援助` };
}

/** 贸易协定升级（DP 8/12/16；一级市场/二级关税/三级最惠国） */
export function tradePact(state: GameState, oid: NationId, level: 1 | 2 | 3): DiploResult {
  const n = state.nations[state.playerNation];
  const cost = level === 1 ? DP_COST.pact1 : level === 2 ? DP_COST.pact2 : DP_COST.pact3;
  if (!spendDiplo(n, cost)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  const minRel = level === 1 ? 20 : level === 2 ? 40 : 60;
  if (e.relation < minRel) return { ok: false, reason: `关系不足（需 ≥${minRel}）` };
  e.tradePact = level;
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 2));
  return { ok: true, dr: 2, message: `与 ${NATIONS[oid].name} 签订${level === 1 ? '市场协定' : level === 2 ? '关税协定' : '最惠国待遇'}` };
}

/** 投资权（DP 12；单向 1/2 或双向 3） */
export function investRight(state: GameState, oid: NationId, dir: 1 | 2 | 3): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.invest)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  e.investRight = dir;
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 2));
  return { ok: true, dr: 2, message: `与 ${NATIONS[oid].name} 签订投资权（${dir === 1 ? '我方投资对方' : dir === 2 ? '对方投资我方' : '双向投资'}）` };
}

/** 军售军舰（DP 8；卖落后军舰给外国） */
export function armsSale(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.armsSale)) return { ok: false, reason: '外交点数不足' };
  const ships = n.stocks.navyShip ?? 0;
  if (ships < 1) return { ok: false, reason: '无军舰可售' };
  n.stocks.navyShip = Math.max(0, ships - 1);
  n.treasury += 20; // 卖舰收入
  const e = n.diplomacy[oid];
  if (e) e.relation = Math.min(100, e.relation + 10);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 2));
  return { ok: true, relation: 10, dr: 2, message: `向 ${NATIONS[oid].name} 出售军舰（+20 万₭）` };
}

/** 请求军售军舰（DP 8） */
export function armsRequest(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.armsRequest)) return { ok: false, reason: '外交点数不足' };
  const other = state.nations[oid];
  if ((other.stocks.navyShip ?? 0) < 1) return { ok: false, reason: '对方无军舰可售' };
  n.stocks.navyShip = (n.stocks.navyShip ?? 0) + 1;
  n.treasury -= 25; // 购舰支出
  const e = n.diplomacy[oid];
  if (e) e.relation = Math.min(100, e.relation + 10);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 1));
  return { ok: true, relation: 10, dr: 1, message: `从 ${NATIONS[oid].name} 购入军舰（-25 万₭）` };
}

/** 承担贷款（DP 10；替对方还国债，债务转移） */
export function takeLoan(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.loan)) return { ok: false, reason: '外交点数不足' };
  const other = state.nations[oid];
  if (other.debtTotal < 1) return { ok: false, reason: '对方无债务' };
  const amount = other.debtTotal;
  if (n.treasury < amount) return { ok: false, reason: '国库不足' };
  n.treasury -= amount;
  n.debtTotal += amount;
  other.debtTotal = 0;
  const e = n.diplomacy[oid];
  if (e) e.relation = Math.min(100, e.relation + 15);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) + 3));
  return { ok: true, relation: 15, dr: 3, message: `承担 ${NATIONS[oid].name} 全部债务（${amount.toFixed(0)} 万₭）` };
}

/** 禁运（DP 10；我方/他国企业不得售商品至某国） */
export function embargo(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.embargo)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  e.embargo = true;
  e.relation = Math.max(-100, e.relation - 20);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 3));
  return { ok: true, relation: -20, dr: -3, message: `对 ${NATIONS[oid].name} 实施禁运` };
}

/** 要求协助禁运（DP 10；要求第三国参与） */
export function coEmbargo(state: GameState, oid: NationId, third: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.coEmbargo)) return { ok: false, reason: '外交点数不足' };
  const te = n.diplomacy[third];
  if (te) {
    te.embargo = true;
    te.relation = Math.max(-100, te.relation - 10);
  }
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 2));
  return { ok: true, dr: -2, message: `要求 ${NATIONS[third].name} 参与对 ${NATIONS[oid].name} 的禁运` };
}

/** 威胁关税（DP 12；损声誉，获得对方某商品关税下调） */
export function threatTariff(state: GameState, oid: NationId, good: string): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.threatTariff)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  // 简化：对方该商品关税 -50%（直接调对方税率）
  const other = state.nations[oid];
  if (other.tax.goods[good as keyof typeof other.tax.goods] !== undefined) {
    other.tax.goods[good as keyof typeof other.tax.goods] = Math.max(0, (other.tax.goods[good as keyof typeof other.tax.goods] ?? 0) - 0.05);
  }
  e.relation = Math.max(-100, e.relation - 15);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 5));
  return { ok: true, relation: -15, dr: -5, message: `威胁关税：${NATIONS[oid].name} 降低商品税` };
}

/** 要求附庸（DP 20；瞬时；可能引发战争） */
export function vassalize(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.vassalize)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  const myPow = prestigeOf(state, {} as GameMap, state.playerNation);
  const theirPow = prestigeOf(state, {} as GameMap, oid);
  const accept = 0.5 + (e.relation / 200) + (myPow - theirPow) / 1000;
  if (accept > 0.6) {
    e.vassal = 'vassal'; // 直接降为附属国
    e.relation = Math.max(-100, e.relation - 40);
    n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 8));
    return { ok: true, message: `${NATIONS[oid].name} 接受附庸` };
  } else if (accept > 0.3) {
    e.relation = Math.max(-100, e.relation - 20);
    n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 5));
    return { ok: false, reason: `${NATIONS[oid].name} 拒绝但未开战` };
  } else {
    e.relation = Math.max(-100, e.relation - 40);
    e.atWar = true; // 引发战争
    n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 8));
    return { ok: false, reason: `${NATIONS[oid].name} 拒绝并要求开战！` };
  }
}

/** 边境摩擦（DP 5；瞬时；损关系不损声誉；可能引发战争） */
export function borderFriction(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.border)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  e.relation = Math.max(-100, e.relation - 10);
  return { ok: true, relation: -10, message: `与 ${NATIONS[oid].name} 发生边境摩擦` };
}

/** 外交侮辱（DP 8；瞬时；损关系不引发战争） */
export function insult(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.insult)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  e.relation = Math.max(-100, e.relation - 20);
  n.diploReputation = Math.max(-100, Math.min(100, (n.diploReputation ?? 0) - 5));
  return { ok: true, relation: -20, dr: -5, message: `外交侮辱 ${NATIONS[oid].name}` };
}

/** 宣战（DP 25；瞬时；需关系≤-40 或借口） */
export function declareWar(state: GameState, oid: NationId): DiploResult {
  const n = state.nations[state.playerNation];
  if (!spendDiplo(n, DP_COST.war)) return { ok: false, reason: '外交点数不足' };
  const e = n.diplomacy[oid];
  if (!e) return { ok: false, reason: '未建交' };
  if (e.truceMonths > 0) return { ok: false, reason: `停战冷却中（${e.truceMonths} 月）` };
  if (e.relation > -40 && !e.casusBelli) return { ok: false, reason: '关系未到 -40 且无宣战借口' };
  e.atWar = true;
  e.casusBelli = false;
  const foeEntry = state.nations[oid].diplomacy?.[state.playerNation];
  if (foeEntry) foeEntry.atWar = true;
  return { ok: true, message: `向 ${NATIONS[oid].name} 宣战！` };
}

/** 和谈（按战争分结算 + 条款） */
export function peace(state: GameState, oid: NationId, termId: string): DiploResult {
  const n = state.nations[state.playerNation];
  const e = n.diplomacy[oid];
  if (!e || !e.atWar) return { ok: false, reason: '未处于战争状态' };
  const term = PEACE_TERMS.find((t) => t.id === termId);
  if (!term) return { ok: false, reason: '未知条款' };
  if (e.warScore < term.minScore) return { ok: false, reason: `战争分不足（需 ≥${term.minScore}，当前 ${e.warScore.toFixed(0)}）` };
  // 执行条款（简化）
  if (term.id === 'statusQuo') {
    // 白和
  } else if (term.id === 'reparations1') {
    const pay = Math.min(500, state.nations[oid].treasury * 0.3);
    state.nations[oid].treasury -= pay;
    n.treasury += pay;
  }
  e.atWar = false;
  e.truceMonths = 120; // 10 年停战
  const foeEntry = state.nations[oid].diplomacy?.[state.playerNation];
  if (foeEntry) foeEntry.atWar = false;
  return { ok: true, message: `与 ${NATIONS[oid].name} 达成和约（${term.label}）` };
}
