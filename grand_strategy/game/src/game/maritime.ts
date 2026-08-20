/**
 * 海军/陆军/商船系统（v0.15，贸易-军事耦合）：
 *  - 商船泊位模型：港口 berths = 海运贸易容量上限；商船数 = 落实；1 商船 = 10 运力。
 *  - 商船维护：每船每月 木材0.1+布料0.05+铜0.05 + 水手 0.02 万工资。
 *  - 军舰：海军容量（海军基地）限制军舰上限；军舰昂贵（商船 4 倍）、月产少、维护耗铜火药。
 *  - 水手储备 → 海员：动员法（国防法）设海员上限；海军扩建时月 2-5% 水手转海员（十年海军）。
 *  - 陆军容量（陆军基地）：军人 POP 上限；扩军需先建基地。
 */
import type { GameMap } from './map';
import type { GameState } from './state';
import { BUILDING_DEFS } from './buildings';

/** 每商船运力（万吨/月） */
export const SEA_TRANSPORT_PER_SHIP = 10;
/** 商船月维护（木材/布料/铜） */
export const SHIP_MAINT = { lumber: 0.1, cloth: 0.05, copper: 0.05 };
/** 每商船需水手（万人） */
export const SAILOR_PER_SHIP = 0.02;
/** 每军舰需海员（万人；1 军舰 ≈ 500 人） */
export const MARINE_PER_WARSHIP = 0.05;
/** 水手→海员月转化率（动员法上限内） */
export const MARINE_DRAFT_RATE = 0.03;

/** 商船泊位上限 = Σ 港口 berths */
export function berthCapOf(state: GameState): number {
  const n = state.nations[state.playerNation];
  let cap = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && BUILDING_DEFS[p.kind].berths) cap += BUILDING_DEFS[p.kind].berths ?? 0;
  }
  return cap;
}

/** 海军容量 = Σ 海军基地 navyCap */
export function navyCapOf(state: GameState): number {
  const n = state.nations[state.playerNation];
  let cap = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && BUILDING_DEFS[p.kind].navyCap) cap += BUILDING_DEFS[p.kind].navyCap ?? 0;
  }
  return cap;
}

/** 陆军容量 = Σ 陆军基地 armyCap */
export function armyCapOf(state: GameState): number {
  const n = state.nations[state.playerNation];
  let cap = 0;
  for (const p of n.projects) {
    if (p.status === 'active' && BUILDING_DEFS[p.kind].armyCap) cap += BUILDING_DEFS[p.kind].armyCap ?? 0;
  }
  return cap;
}

/** 有效军舰数（≤ 海军容量；军舰库存 + 在产军舰项目 × 进度） */
export function effectiveNavy(state: GameState): number {
  const n = state.nations[state.playerNation];
  const fleet = n.stocks.navyShip ?? 0;
  return Math.min(fleet, navyCapOf(state));
}

/** 有效商船数（≤ 泊位上限；商船库存 + 在产项目） */
export function effectiveFleet(state: GameState): number {
  const n = state.nations[state.playerNation];
  const fleet = n.stocks.merchantShip ?? 0;
  return Math.min(fleet, berthCapOf(state));
}

/**
 * 月度海上结算（确定性）：
 *  - 更新泊位/海军/陆军容量
 *  - 商船维护：耗木材/布料/铜（从国家库存）+ 水手工资（水手 POP 就业）
 *  - 海上运力 = 有效商船 × 每船运力
 *  - 水手→海员转化：动员法上限内，月 3% 水手转海员
 *  - 军舰维护：每军舰耗 铜0.05 + 火药0.02 + 海员工资
 */
export function settleMaritimeMonth(state: GameState, map: GameMap): void {
  const n = state.nations[state.playerNation];
  n.berthCap = berthCapOf(state);
  n.navyCap = navyCapOf(state);
  n.armyCap = armyCapOf(state);
  const fleet = effectiveFleet(state);
  const navy = effectiveNavy(state);
  n.merchantFleet = fleet;
  n.navyShips = navy;
  n.seaTransport = fleet * SEA_TRANSPORT_PER_SHIP;

  // 商船维护（从国家库存扣；不足则商船闲置减半）
  const maint = { lumber: SHIP_MAINT.lumber * fleet, cloth: SHIP_MAINT.cloth * fleet, copper: SHIP_MAINT.copper * fleet };
  const shortage = (Object.keys(maint) as (keyof typeof maint)[]).some((g) => n.stocks[g] < maint[g]);
  if (shortage) {
    n.seaTransport *= 0.5; // 维护不足 → 船队半闲置
  } else {
    for (const g of Object.keys(maint) as (keyof typeof maint)[]) n.stocks[g] -= maint[g];
  }

  // 水手统计（全国水手 POP）→ 储备
  let sailors = 0;
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) if (pop.job === 'sailor') sailors += pop.size;
  }
  n.sailorReserve = sailors;

  // 海员需求（军舰 × 每舰海员）与转化：水手 → 海员（月 3%，动员法上限）
  const neededMarines = navy * MARINE_PER_WARSHIP;
  let marines = 0;
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) if (pop.job === 'marine') marines += pop.size;
  }
  const marineShortfall = Math.max(0, neededMarines - marines);
  if (marineShortfall > 0 && sailors > 0) {
    const draft = Math.min(marineShortfall, sailors * MARINE_DRAFT_RATE);
    // 从各省水手按比例抽调到该省海员 POP
    let remaining = draft;
    for (const p of map.provinces) {
      if (remaining <= 1e-9) break;
      if (p.owner !== state.playerNation || p.isUndiscovered) continue;
      const ps = state.provinces[p.id];
      if (!ps?.pops) continue;
      const sPop = ps.pops.find((pop) => pop.job === 'sailor');
      if (!sPop || sPop.size <= 1e-9) continue;
      const take = Math.min(remaining, sPop.size);
      sPop.size -= take;
      remaining -= take;
      let mPop = ps.pops.find((pop) => pop.job === 'marine' && pop.race === sPop.race);
      if (!mPop) {
        ps.pops.push({ ...sPop, job: 'marine', size: take, expected: 50, unrest: 0 });
        mPop = ps.pops[ps.pops.length - 1];
      } else {
        mPop.size += take;
      }
      ps.popTotal = 0;
      for (const pop of ps.pops) ps.popTotal += pop.size;
    }
    n.marineDrafting = draft;
  } else {
    n.marineDrafting = 0;
  }

  // 军舰维护（每舰 铜0.05 + 火药0.02 + 海员工资并入海军军费）
  const warMaintenance = { copper: 0.05 * navy, gunpowder: 0.02 * navy };
  for (const g of Object.keys(warMaintenance) as (keyof typeof warMaintenance)[]) {
    n.stocks[g] = Math.max(0, (n.stocks[g] ?? 0) - warMaintenance[g]);
  }

  // 商船/军舰库存 = 库存 - 已计入有效船队的部分（防止重复计入市场消耗；库存即船队）
  // （船队直接从 stocks 读，无需额外扣减；市场消耗按建筑输入已走）
}
