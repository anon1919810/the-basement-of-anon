/**
 * 无头模拟（v0.7，tsx 运行）：
 *  - 洛林 20 年沙盒（seed 42，随机策略：税率滑块/支出/转职/政策/建筑投资）
 *  - 8 国各 5 年冒烟（seed 7，随机策略）
 * 断言（仅保留四类，不做复杂断言）：
 *  - 无 NaN（allFinite 全状态数值有限）
 *  - 国库守恒（Δ = 收入 - 支出 + 建筑回报 - 投资成本 + 退款）与粮食守恒（产+进 = 消+出+Δ库存+建筑消耗）
 *  - 价格恒正且在 clamp 范围（国家市场；省/县市场同机制）
 *  - 同种子确定性（洛林 20 年两次快照完全一致）
 * 运行：npx.cmd tsx scripts/sim.ts
 */
import { loadMap, mapStats } from '../src/game/map';
import type { GameMap } from '../src/game/map';
import { newGameState, tickDay, allFinite, setPolicy } from '../src/game/state';
import type { GameState } from '../src/game/state';
import { NATIONS, NATION_LIST } from '../src/game/nations';
import { Rng } from '../src/game/rng';
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../src/game/clock';
import { GOODS, GOOD_LABEL } from '../src/game/pops';
import { TAX_KINDS } from '../src/game/tax';
import { retrainPop } from '../src/game/labor';
import { PRICE_CLAMP_MAX, PRICE_CLAMP_MIN } from '../src/game/market';
import { BUILDING_DEFS, BUILDING_KINDS, buildingUnlock, cancelInvestment, nationHasGood, startInvestment } from '../src/game/buildings';
import type { GoodId, NationId } from '../src/game/types';

let failures = 0;
let checks = 0;

function check(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertFiniteState(state: GameState, at: string): void {
  check(allFinite(state), `全状态数值有限（${at}）`);
  const n = state.nations[state.playerNation];
  check(Number.isFinite(n.treasury), `国库有限（${at}）`);
  check(n.stability >= 0 && n.stability <= 100, `稳定度 0-100（${at}: ${n.stability.toFixed(2)}）`);
  check(n.popWan >= 0 && Number.isFinite(n.popWan), `人口有限非负（${at}）`);
}

interface Snapshot {
  treasury: number;
  food: number;
  day: number;
}

/** 月初随机调整税率滑块与支出 + 随机开关政策/转职（确定性：经 rng） */
function adjustPolicy(state: GameState, map: GameMap, rng: Rng): void {
  const id = state.playerNation;
  const n = state.nations[id];
  if (rng.chance(0.6)) {
    n.tax.rates[TAX_KINDS[rng.int(0, TAX_KINDS.length)]] = rng.int(0, 61) / 200;
  } else {
    const nGoods = 1 + rng.int(0, 2);
    for (let i = 0; i < nGoods; i++) n.tax.goods[GOODS[rng.int(0, GOODS.length)]] = rng.int(0, 61) / 200;
  }
  const cap = Math.min(NATIONS[id].sliderMax + 1, Math.max(60, Math.floor(n.monthly.income * 1.3) + 1));
  let rem = rng.int(0, cap);
  const kinds = ['military', 'admin', 'infra', 'court', 'health'] as const;
  for (let i = 0; i < kinds.length; i++) {
    const isLast = i === kinds.length - 1;
    const v = isLast ? rem : rng.int(0, rem + 1);
    n.spending[kinds[i]] = v;
    rem -= v;
  }
  if (rng.chance(0.12)) setPolicy(state, 'progressiveTax', !n.policies.progressiveTax);
  if (rng.chance(0.08)) setPolicy(state, 'universalSuffrage', !n.policies.universalSuffrage);
  if (rng.chance(0.15)) {
    const provIds = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered).map((p) => p.id);
    if (provIds.length > 0) {
      const pid = provIds[rng.int(0, provIds.length)];
      const pops = state.provinces[pid].pops;
      if (pops.length > 0) retrainPop(state, map, pid, rng.int(0, pops.length));
    }
  }
}

/** 随机建筑投资（每月至多 2 次）/ 取消在建 */
function investRandom(state: GameState, map: GameMap, rng: Rng): void {
  const n = state.nations[state.playerNation];
  const view = { stocks: n.stocks, projects: n.projects, literacy: n.literacy };
  const provIds = map.provinces.filter((p) => p.owner === state.playerNation && !p.isUndiscovered).map((p) => p.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!rng.chance(0.5)) continue;
    const kinds = BUILDING_KINDS.filter((k) => {
      const d = BUILDING_DEFS[k];
      if (d.requireGood && !nationHasGood(view, d.requireGood)) return false;
      if (d.requireLiteracy !== undefined && n.literacy < d.requireLiteracy) return false;
      return true;
    });
    if (kinds.length === 0) continue;
    const kind = kinds[rng.int(0, kinds.length)];
    const eligible = provIds.filter((pid) => {
      const prov = map.provinceById.get(pid);
      return prov ? buildingUnlock(map, kind, prov, n.infra, view).ok : false;
    });
    if (eligible.length > 0 && n.treasury >= BUILDING_DEFS[kind].cost) {
      startInvestment(state, map, kind, eligible[rng.int(0, eligible.length)]);
    }
  }
  if (rng.chance(0.3)) {
    const building = n.projects.filter((p) => p.status === 'building');
    if (building.length > 0) cancelInvestment(state, building[rng.int(0, building.length)].id);
  }
}

/** 建筑输入消耗（粮食守恒：生产+进口 = 消费+出口+Δ库存+建筑消耗） */
function buildingUsedOf(n: { projects: { lastInputUsed: Record<GoodId, number> }[] }, g: GoodId): number {
  let sum = 0;
  for (const p of n.projects) sum += p.lastInputUsed[g] ?? 0;
  return sum;
}

/** 月度结算守恒断言（tickDay 结算前后）——仅国库/粮食守恒 + 价格 clamp + 无 NaN */
function assertMonthlyConservation(state: GameState, snap: Snapshot, at: string): void {
  const n = state.nations[state.playerNation];
  // 国库守恒：Δ = 收入 - 支出 + 建筑回报 - 投资成本 + 取消退款
  const expT =
    snap.treasury + n.monthly.income - n.monthly.spending +
    n.monthly.investReturn - n.monthly.investCost + n.monthly.investRefund;
  check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（${at}: ${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);
  // 粮食守恒（stocks.food 镜像 foodStock）
  const m = n.market.food;
  const dFood = n.stocks.food - snap.food;
  const lhs = m.supply + m.imported;
  const rhs = m.consumed + m.exported + dFood + buildingUsedOf(n, 'food');
  const vol = Math.max(1e-6, Math.abs(lhs) + Math.abs(rhs));
  check(Math.abs(lhs - rhs) <= 0.01 * vol + 1e-6, `粮食守恒（${at}: 产+进 ${lhs.toFixed(3)} vs 消+出+Δ+建 ${rhs.toFixed(3)}）`);
  // 价格恒正且在 clamp 范围（国家市场；省/县市场同 settleMarket 机制）
  for (const g of GOODS) {
    const gm = n.market[g];
    check(
      gm.price > 0 && gm.price <= gm.basePrice * PRICE_CLAMP_MAX + 1e-9 && gm.price >= gm.basePrice * PRICE_CLAMP_MIN - 1e-9,
      `价格在 clamp 范围（${at}: ${GOOD_LABEL[g]} ${gm.price.toFixed(2)} ∈ [${(gm.basePrice * PRICE_CLAMP_MIN).toFixed(2)}, ${(gm.basePrice * PRICE_CLAMP_MAX).toFixed(2)}]）`,
    );
  }
  assertFiniteState(state, at);
}

/** 主模拟循环（随机策略冒烟） */
function simulate(seed: number, nation: NationId, years: number): { state: GameState } {
  const map = loadMap();
  const state = newGameState(nation, seed, map);
  const id = state.playerNation;
  const days = years * DAYS_PER_YEAR;

  let minTreasury = Infinity;
  let minStability = Infinity;
  let minFood = Infinity;
  let snap: Snapshot | null = null;

  for (let d = 0; d < days; d++) {
    const mod = state.day % DAYS_PER_MONTH;
    if (mod === 1) {
      const rng = new Rng(state.rngState);
      adjustPolicy(state, map, rng);
      state.rngState = rng.state;
    }
    if (mod === DAYS_PER_MONTH - 1) {
      const n2 = state.nations[id];
      snap = { treasury: n2.treasury, food: n2.stocks.food, day: state.day };
      const rng = new Rng(state.rngState);
      investRandom(state, map, rng);
      state.rngState = rng.state;
    }
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1 && snap) {
      assertMonthlyConservation(state, snap, `第 ${state.day} 日`);
      const n2 = state.nations[id];
      minTreasury = Math.min(minTreasury, n2.treasury);
      minStability = Math.min(minStability, n2.stability);
      minFood = Math.min(minFood, n2.foodStock);
    }
  }

  check(Number.isFinite(minTreasury), `国库从未出现 NaN/±∞（最低 ${minTreasury.toFixed(1)} 万₭）`);
  check(minStability >= 0 && minStability <= 100, `稳定度全程 0-100（最低 ${minStability.toFixed(1)}）`);
  check(Number.isFinite(minFood), `粮食储备从未出现 NaN/±∞（最低 ${minFood.toFixed(1)} 万吨）`);
  assertFiniteState(state, '终局');
  return { state };
}

function snapshotOf(state: GameState): string {
  const n = state.nations[state.playerNation];
  return JSON.stringify({
    day: state.day,
    seed: state.seed,
    rng: state.rngState,
    treasury: n.treasury,
    food: n.foodStock,
    stability: n.stability,
    pop: n.popWan,
    literacy: n.literacy,
    health: n.health,
    policies: n.policies,
    tax: n.tax,
    prices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].price])),
    stocks: n.stocks,
    projects: n.projects.map((p) => ({ k: p.kind, pid: p.provId, ml: p.monthsLeft, s: p.status })),
    history: Object.keys(state.history).length,
    chronicle: state.chronicle.length,
  });
}

function main(): void {
  const map = loadMap();
  const stats = mapStats(map);
  console.log('== 地图统计（v0.7 山川形便省界：紧凑度聚类 + 山脊分界）==');
  console.log(
    `  省 ${stats.provinces} 个 · 格数 最小 ${stats.provMin} / 最大 ${stats.provMax} / 平均 ${Number(stats.provAvg).toFixed(1)}` +
    ` · 规模分布 ${JSON.stringify(stats.provSizeDist as Record<string, number>)}`,
  );
  console.log(
    `  紧凑度均值 ${Number(stats.compactnessMean).toFixed(4)}（v0.6 基线 0.3519）· 长条省占比 ${(Number(stats.longStripShare) * 100).toFixed(1)}%` +
    ` · 山脊格 ${stats.ridgeCells}（边界占比 ${(Number(stats.ridgeBoundaryShare) * 100).toFixed(0)}%）`,
  );

  console.log('\n== 洛林 20 年沙盒（seed 42，随机策略）==');
  const runA = simulate(42, 'lorraine', 20);
  const nA = runA.state.nations.lorraine;
  console.log(
    `  终局：${runA.state.day} 日 · 国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万` +
    ` · 大事记 ${runA.state.chronicle.length} 条 · 历史 ${(runA.state.history.lorraine ?? []).length} 月`,
  );

  console.log('\n== 确定性：同种子两次 20 年结果一致 ==');
  const runB = simulate(42, 'lorraine', 20);
  const deterministic = snapshotOf(runA.state) === snapshotOf(runB.state);
  check(deterministic, '同种子（42）两次 20 年运行快照完全一致（含税率/建筑/政策/三级市场/历史）');

  console.log('\n== 8 国各 5 年冒烟（seed 7，随机策略）==');
  for (const def of NATION_LIST) {
    const s = simulate(7, def.id, 5);
    const n = s.state.nations[def.id];
    const active = n.projects.filter((p) => p.status === 'active').length;
    console.log(`  ${def.name}: 完成 5 年 ✓ 国库 ${n.treasury.toFixed(0)} · 稳定度 ${n.stability.toFixed(1)} · 人口 ${n.popWan.toFixed(0)} 万 · 建筑 ${active} 在产`);
  }

  console.log(`\n== 断言汇总 ==`);
  console.log(`  通过 ${checks - failures} / ${checks}${failures === 0 ? ' — 全部通过 ✅' : ` — ${failures} 项失败 ❌`}`);
  if (failures > 0) throw new Error(`模拟断言失败：${failures} 项未通过（${checks - failures}/${checks} 通过）`);
}

main();
