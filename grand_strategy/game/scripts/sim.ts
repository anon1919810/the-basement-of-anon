/**
 * 无头模拟（v0.8，tsx 运行）：
 *  - 洛林 20 年沙盒（seed 42，随机策略：税率滑块/支出/转职/政策/开放贸易/出口权/建筑投资）
 *  - 8 国各 5 年冒烟（seed 7，随机策略）
 *  - 未开放国 3 年（开放贸易恒关：断言无任何进出口）
 * 断言（v0.8 市场中心：省为结算单元）：
 *  - 无 NaN（allFinite 全状态数值有限）
 *  - 国库守恒（Δ = 收入 - 支出 + 建筑回报 - 投资成本 + 退款）
 *  - 按省守恒（每商品每省，容差 2%）：生产 + 进口 + 流入 = 消费 + 出口 + Δ库存 + 建筑消耗 + 流出
 *  - 省价恒正且在 clamp 范围（基础价 × 0.4~2.5）
 *  - 至少一个月存在「两省同商品价格不同」
 *  - 未开放国无任何进出口（开放贸易=false 的月份出口/进口恒为 0）
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
/** v0.8：是否观测到「两省同商品价格不同」 */
let sawPriceDiff = false;

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
  /** v0.8 结算前省库存（守恒断言：Δ库存 = 结算后 − 结算前） */
  provStocks: Record<number, Record<GoodId, number>>;
}

/** 深拷贝省库存（数字快照） */
function cloneProvStocks(ps: Record<number, Record<GoodId, number>>): Record<number, Record<GoodId, number>> {
  const out: Record<number, Record<GoodId, number>> = {};
  for (const pid of Object.keys(ps)) {
    const inner = {} as Record<GoodId, number>;
    for (const g of GOODS) inner[g] = ps[Number(pid)][g];
    out[Number(pid)] = inner;
  }
  return out;
}

/** 月初随机调整税率滑块与支出 + 随机开关政策/开放贸易/出口权/转职（确定性：经 rng） */
function adjustPolicy(state: GameState, map: GameMap, rng: Rng, noTrade: boolean): void {
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
  // v0.8 开放贸易随机开关 + 出口权随机授予/收回（noTrade 时恒关，专测「未开放国无进出口」）
  if (!noTrade && rng.chance(0.1)) n.openTrade = !n.openTrade;
  if (!noTrade && rng.chance(0.15)) {
    const provIds = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered).map((p) => p.id);
    if (provIds.length > 0) {
      const pid = provIds[rng.int(0, provIds.length)];
      n.exportRights[pid] = !n.exportRights[pid];
    }
  }
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

/** 某省本月建筑输入消耗（结算后从项目账读取，与 market 的 provBuildingConsumed 同口径） */
function buildingUsedOfProv(n: { projects: { provId: number; lastInputUsed: Record<GoodId, number> }[] }, pid: number, g: GoodId): number {
  let sum = 0;
  for (const p of n.projects) if (p.provId === pid) sum += p.lastInputUsed[g] ?? 0;
  return sum;
}

/** 月度结算守恒断言（tickDay 结算前后）——国库守恒 + 按省守恒 + 省价 clamp + 未开放无贸易 + 无 NaN */
function assertMonthlyConservation(state: GameState, map: GameMap, snap: Snapshot, at: string): void {
  const id = state.playerNation;
  const n = state.nations[id];
  // 国库守恒：Δ = 收入 - 支出 + 建筑回报 - 投资成本 + 取消退款
  const expT =
    snap.treasury + n.monthly.income - n.monthly.spending +
    n.monthly.investReturn - n.monthly.investCost + n.monthly.investRefund;
  check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（${at}: ${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);

  const provIds = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered).map((p) => p.id);
  // 按省守恒（每商品每省，容差 2%）：生产+进口+流入 = 消费+出口+Δ库存+建筑消耗+流出
  for (const pid of provIds) {
    const pmAll = n.provinceMarkets[pid];
    if (!pmAll) continue;
    for (const g of GOODS) {
      const pm = pmAll[g];
      const s0 = snap.provStocks[pid]?.[g] ?? 0;
      const s1 = n.provStocks[pid]?.[g] ?? 0;
      const dStock = s1 - s0;
      const bC = buildingUsedOfProv(n, pid, g);
      const lhs = pm.supply + pm.imported + pm.flowIn;
      const rhs = pm.consumed + pm.exported + dStock + bC + pm.flowOut;
      const vol = Math.max(1, Math.abs(lhs) + Math.abs(rhs));
      check(
        Math.abs(lhs - rhs) <= 0.02 * vol,
        `按省守恒 ${GOOD_LABEL[g]}（${at} #${pid + 1}: 产+进+入 ${lhs.toFixed(2)} vs 消+出+Δ库+建+出 ${rhs.toFixed(2)}）`,
      );
    }
    // 省价恒正且在 clamp 范围（0.4~2.5 × 基础价）
    for (const g of GOODS) {
      const pm = pmAll[g];
      check(
        pm.price > 0 &&
          pm.price >= pm.basePrice * PRICE_CLAMP_MIN - 1e-9 &&
          pm.price <= pm.basePrice * PRICE_CLAMP_MAX + 1e-9,
        `省价在 clamp 范围（${at} #${pid + 1} ${GOOD_LABEL[g]} ${pm.price.toFixed(2)} ∈ [${(pm.basePrice * PRICE_CLAMP_MIN).toFixed(2)}, ${(pm.basePrice * PRICE_CLAMP_MAX).toFixed(2)}]）`,
      );
    }
  }
  // 存在两省同商品价格不同（v0.8 价格差异化；按千分位取整比较）
  for (const g of GOODS) {
    const prices = provIds
      .map((pid) => n.provinceMarkets[pid]?.[g]?.price)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (prices.length >= 2 && new Set(prices.map((p) => Math.round(p * 1000))).size >= 2) sawPriceDiff = true;
  }
  // 未开放国无进出口（开放贸易=false → 出口/进口恒 0）
  if (!n.openTrade) {
    let tradeVol = 0;
    for (const pid of provIds) {
      const pmAll = n.provinceMarkets[pid];
      if (!pmAll) continue;
      for (const g of GOODS) tradeVol += pmAll[g].exported + pmAll[g].imported;
    }
    check(tradeVol < 1e-6, `未开放国无进出口（${at}: 出口+进口 = ${tradeVol.toFixed(4)}）`);
  }
  assertFiniteState(state, at);
}

/** 主模拟循环（随机策略冒烟；noTrade=开放贸易恒关） */
function simulate(seed: number, nation: NationId, years: number, opts?: { noTrade?: boolean }): { state: GameState } {
  const noTrade = opts?.noTrade ?? false;
  const map = loadMap();
  const state = newGameState(nation, seed, map);
  const id = state.playerNation;
  if (noTrade) state.nations[id].openTrade = false;
  const days = years * DAYS_PER_YEAR;

  let minTreasury = Infinity;
  let minStability = Infinity;
  let minFood = Infinity;
  let snap: Snapshot | null = null;

  for (let d = 0; d < days; d++) {
    const mod = state.day % DAYS_PER_MONTH;
    if (mod === 1) {
      const rng = new Rng(state.rngState);
      adjustPolicy(state, map, rng, noTrade);
      state.rngState = rng.state;
    }
    if (mod === DAYS_PER_MONTH - 1) {
      const n2 = state.nations[id];
      snap = { treasury: n2.treasury, food: n2.stocks.food, day: state.day, provStocks: cloneProvStocks(n2.provStocks) };
      const rng = new Rng(state.rngState);
      investRandom(state, map, rng);
      state.rngState = rng.state;
    }
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1 && snap) {
      assertMonthlyConservation(state, map, snap, `第 ${state.day} 日`);
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
    openTrade: n.openTrade,
    exportRights: n.exportRights,
    prices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].price])),
    stocks: n.stocks,
    provStocks: n.provStocks,
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

  console.log('\n== 洛林 20 年沙盒（seed 42，随机策略 + 开放贸易/出口权随机开关）==');
  const runA = simulate(42, 'lorraine', 20);
  const nA = runA.state.nations.lorraine;
  console.log(
    `  终局：${runA.state.day} 日 · 国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万` +
    ` · 开放贸易 ${nA.openTrade ? '开' : '关'} · 出口权省 ${Object.values(nA.exportRights).filter(Boolean).length} 个` +
    ` · 大事记 ${runA.state.chronicle.length} 条 · 历史 ${(runA.state.history.lorraine ?? []).length} 月`,
  );

  console.log('\n== 确定性：同种子两次 20 年结果一致 ==');
  const runB = simulate(42, 'lorraine', 20);
  const deterministic = snapshotOf(runA.state) === snapshotOf(runB.state);
  check(deterministic, '同种子（42）两次 20 年运行快照完全一致（含税率/建筑/政策/开放贸易/出口权/市场/历史）');

  console.log('\n== 8 国各 5 年冒烟（seed 7，随机策略）==');
  for (const def of NATION_LIST) {
    const s = simulate(7, def.id, 5);
    const n = s.state.nations[def.id];
    const active = n.projects.filter((p) => p.status === 'active').length;
    console.log(`  ${def.name}: 完成 5 年 ✓ 国库 ${n.treasury.toFixed(0)} · 稳定度 ${n.stability.toFixed(1)} · 人口 ${n.popWan.toFixed(0)} 万 · 建筑 ${active} 在产`);
  }

  console.log('\n== 未开放国 3 年（开放贸易恒关：无任何进出口）==');
  const closed = simulate(7, 'lorraine', 3, { noTrade: true });
  const nc = closed.state.nations.lorraine;
  let closedTrade = 0;
  for (const pid of Object.keys(nc.provinceMarkets)) {
    const pmAll = nc.provinceMarkets[Number(pid)];
    for (const g of GOODS) closedTrade += pmAll[g].exported + pmAll[g].imported;
  }
  console.log(`  终局：开放贸易 ${nc.openTrade ? '开' : '关'} · 末月出口+进口合计 ${closedTrade.toFixed(4)}（断言每月恒为 0）`);

  check(sawPriceDiff, '至少一个月存在「两省同商品价格不同」（省价差异化）');

  console.log(`\n== 断言汇总 ==`);
  console.log(`  通过 ${checks - failures} / ${checks}${failures === 0 ? ' — 全部通过 ✅' : ` — ${failures} 项失败 ❌`}`);
  if (failures > 0) throw new Error(`模拟断言失败：${failures} 项未通过（${checks - failures}/${checks} 通过）`);
}

main();
