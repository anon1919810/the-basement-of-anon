/**
 * 无头模拟（v0.2，tsx 运行）：50 年沙盒断言（洛林，seed 42）。
 *  - 随机策略：每月随机调税率/五类支出/偶尔转职/随机投资项目（含取消）
 *  - 断言：
 *    1) 无 NaN/±∞（全状态有限）
 *    2) 国库守恒（Δ国库 = 收入 - 支出 + 投资回报 - 投资成本 + 取消退款，逐月 + 全程累计）
 *    3) 五类商品（粮食/衣物/燃料/工业品/奢侈品）守恒（生产 + 进口 = 消费 + 出口 + 库存变化，容差 1%）
 *    4) 价格恒正且在 clamp 范围（0.4~2.5 × 基础价）——国家/区域/本地三级
 *    5) 省人口 ≤ 住房容量；POP size ≥ 0
 *    6) 投资项目账目一致：进度合法、退款 ≤ 成本、全程累计现金流与国库一致
 *    7) 确定性：同种子两次 50 年快照完全一致
 *    8) 存档 JSON 往返一致；无事件系统（人工事件列表为空 → 休眠检查点 no-op）
 * 运行：npx.cmd tsx scripts/sim.ts
 */
import { loadMap, mapStats } from '../src/game/map';
import type { GameMap } from '../src/game/map';
import { newGameState, tickDay, allFinite } from '../src/game/state';
import type { GameState } from '../src/game/state';
import { NATIONS } from '../src/game/nations';
import { Rng } from '../src/game/rng';
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../src/game/clock';
import { BANKRUPTCY_THRESHOLD, TAX_LEVELS } from '../src/game/economy';
import { GOODS, GOOD_LABEL, JOB_LABEL } from '../src/game/pops';
import { retrainPop } from '../src/game/labor';
import { PRICE_CLAMP_MAX, PRICE_CLAMP_MIN } from '../src/game/market';
import { cancelInvestment, PROJECT_DEFS, PROJECT_KINDS, projectUnlock, startInvestment } from '../src/game/investment';
import { MANUAL_EVENTS } from '../src/game/manualEvents';
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
  check(n.popWan >= 0, `人口非负（${at}）`);
  check(n.literacy >= 0 && n.literacy <= 1, `识字率 0-1（${at}）`);
  check(n.health >= 0 && n.health <= 1, `健康 0-1（${at}）`);
}

interface Snapshot {
  treasury: number;
  stocks: Record<GoodId, number>;
  day: number;
}

/** 月初随机调整税率与支出（确定性：经 rng；支出按总预算分配，保证国库可维持投资） */
function adjustPolicy(state: GameState, map: GameMap, rng: Rng): void {
  const id = state.playerNation;
  const n = state.nations[id];
  n.taxLevel = TAX_LEVELS[rng.int(0, TAX_LEVELS.length)];
  const max = NATIONS[id].sliderMax;
  // 总预算内随机分配五类支出（≤ sliderMax，避免无脑赤字导致无法投资）
  const budget = rng.int(0, max + 1);
  let rem = budget;
  const kinds = ['military', 'admin', 'infra', 'court', 'health'] as const;
  for (let i = 0; i < kinds.length; i++) {
    const isLast = i === kinds.length - 1;
    const v = isLast ? rem : rng.int(0, rem + 1);
    n.spending[kinds[i]] = v;
    rem -= v;
  }
  // 偶尔转职（15% 概率随机选一个省的一个 POP）
  if (rng.chance(0.15)) {
    const provIds = map.provinces
      .filter((p) => p.owner === id && !p.isUndiscovered)
      .map((p) => p.id);
    if (provIds.length > 0) {
      const pid = provIds[rng.int(0, provIds.length)];
      const pops = state.provinces[pid].pops;
      if (pops.length > 0) {
        const idx = rng.int(0, pops.length);
        const before = pops[idx].job;
        retrainPop(state, map, pid, idx);
        if (pops[idx].job !== before) {
          check(pops[idx].retrainMonths === 3, `转职后 3 个月产出减半生效（${JOB_LABEL[before]}→${JOB_LABEL[pops[idx].job]}）`);
        }
      }
    }
  }
}

/** 随机投资：新建项目（选符合解锁条件的省，每月至多尝试 2 次）/ 取消在建项目 */
function investRandom(state: GameState, map: GameMap, rng: Rng, costAcc: { cost: number; refund: number }): void {
  const n = state.nations[state.playerNation];
  // 每月至多 2 次新建尝试（各 50%）
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!rng.chance(0.5)) continue;
    const kind = PROJECT_KINDS[rng.int(0, PROJECT_KINDS.length)];
    const provIds = map.provinces
      .filter((p) => p.owner === state.playerNation && !p.isUndiscovered)
      .map((p) => p.id);
    const eligible = provIds.filter((pid) => {
      const prov = map.provinceById.get(pid);
      return prov ? projectUnlock(map, kind, prov, n.infra).ok : false;
    });
    if (eligible.length > 0) {
      const pid = eligible[rng.int(0, eligible.length)];
      const cost = PROJECT_DEFS[kind].cost;
      if (n.treasury >= cost) {
        const p = startInvestment(state, map, kind, pid);
        if (p) {
          costAcc.cost += cost;
          check(p.monthsLeft === PROJECT_DEFS[kind].duration, `新建项目工期正确（${PROJECT_DEFS[kind].label} ${p.monthsLeft} 月）`);
        }
      }
    }
  }
  // 30% 概率取消一个在建项目
  if (rng.chance(0.3)) {
    const building = n.projects.filter((p) => p.status === 'building');
    if (building.length > 0) {
      const p = building[rng.int(0, building.length)];
      const refund = cancelInvestment(state, p.id);
      if (refund !== null) {
        costAcc.refund += refund;
        check(refund >= 0 && refund <= p.totalCost + 1e-9, `取消退款 ≤ 成本（退 ${refund.toFixed(1)} ≤ ${p.totalCost.toFixed(0)}）`);
      }
    }
  }
}

/** 月度结算守恒断言（在 tickDay 结算前后） */
function assertMonthlyConservation(state: GameState, map: GameMap, snap: Snapshot, at: string): void {
  const n = state.nations[state.playerNation];
  // 国库守恒：Δ = 收入 - 支出 + 投资回报 - 投资成本 + 取消退款
  const expT =
    snap.treasury +
    n.monthly.income -
    n.monthly.spending +
    n.monthly.investReturn -
    n.monthly.investCost +
    n.monthly.investRefund;
  check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（${at}: ${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);
  // 商品守恒：生产 + 进口 = 消费 + 出口 + Δ库存（容差 1%）；价格恒正且在 clamp 范围
  for (const g of GOODS) {
    const m = n.market[g];
    const dStock = n.stocks[g] - snap.stocks[g];
    const lhs = m.supply + m.imported;
    const rhs = m.consumed + m.exported + dStock;
    const volume = Math.max(1e-6, Math.abs(lhs) + Math.abs(rhs));
    check(Math.abs(lhs - rhs) <= 0.01 * volume + 1e-6, `商品「${GOOD_LABEL[g]}」守恒（${at}: 产+进 ${lhs.toFixed(3)} vs 消+出+Δ ${rhs.toFixed(3)}）`);
    check(m.price > 0 && m.price <= m.basePrice * PRICE_CLAMP_MAX + 1e-9 && m.price >= m.basePrice * PRICE_CLAMP_MIN - 1e-9,
      `国家价在 clamp 范围（${at}: ${g} ${m.price.toFixed(2)} ∈ [${(m.basePrice * PRICE_CLAMP_MIN).toFixed(2)}, ${(m.basePrice * PRICE_CLAMP_MAX).toFixed(2)}]）`);
  }
  // 区域（省）/ 本地（县）价格同样 clamp 内
  for (const pid of Object.keys(n.provinceMarkets)) {
    const pm = n.provinceMarkets[Number(pid)];
    for (const g of Object.keys(pm) as GoodId[]) {
      const m = pm[g];
      check(m.price > 0 && m.price <= m.basePrice * PRICE_CLAMP_MAX + 1e-9 && m.price >= m.basePrice * PRICE_CLAMP_MIN - 1e-9,
        `省价在 clamp 范围（${at}: 省#${Number(pid) + 1} ${g} ${m.price.toFixed(2)}）`);
    }
  }
  for (const cid of Object.keys(n.countyMarkets)) {
    const cm = n.countyMarkets[Number(cid)];
    for (const g of Object.keys(cm) as GoodId[]) {
      const m = cm[g];
      check(m.price > 0 && m.price <= m.basePrice * PRICE_CLAMP_MAX + 1e-9 && m.price >= m.basePrice * PRICE_CLAMP_MIN - 1e-9,
        `县价在 clamp 范围（${at}: 县#${Number(cid) + 1} ${g} ${m.price.toFixed(2)}）`);
    }
  }
  // 省人口 ≤ 住房容量；POP size ≥ 0；项目进度合法
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    check(ps.popTotal <= ps.housingCap + 1e-6, `省人口 ≤ 住房容量（${at}: 行省#${p.id + 1} ${ps.popTotal.toFixed(2)} ≤ ${ps.housingCap.toFixed(2)}）`);
    for (const pop of ps.pops) {
      check(pop.size >= -1e-9, `POP size ≥ 0（${at}: 行省#${p.id + 1} ${JOB_LABEL[pop.job]} ${pop.size.toFixed(4)}）`);
    }
  }
  for (const pr of n.projects) {
    check(pr.monthsLeft >= 0 && pr.monthsLeft <= pr.duration, `项目进度合法（${at}: ${PROJECT_DEFS[pr.kind].label} 剩余 ${pr.monthsLeft}/${pr.duration} 月）`);
  }
  assertFiniteState(state, at);
}

function simulate(seed: number, nation: NationId, years: number): { state: GameState; costAcc: { cost: number; refund: number } } {
  const map = loadMap();
  const state = newGameState(nation, seed, map);
  const id = state.playerNation;
  const days = years * DAYS_PER_YEAR;

  let minTreasury = Infinity;
  let minStability = Infinity;
  let minFood = Infinity;
  let snap: Snapshot | null = null;
  const costAcc = { cost: 0, refund: 0 };
  // 全程累计（终局账目一致断言）
  let accIncomeSpending = 0;
  let accReturn = 0;

  for (let d = 0; d < days; d++) {
    const mod = state.day % DAYS_PER_MONTH;
    if (mod === 1) {
      // 月初：随机策略（税率/支出/转职）
      const rng = new Rng(state.rngState);
      adjustPolicy(state, map, rng);
      state.rngState = rng.state;
    }
    if (mod === DAYS_PER_MONTH - 1) {
      // 月末前快照（结算发生在 tickDay 后 day%30==0）
      const n = state.nations[id];
      snap = { treasury: n.treasury, stocks: { ...n.stocks }, day: state.day };
      // 随机投资（快照后、结算前，成本/退款即时入账）
      const rng = new Rng(state.rngState);
      investRandom(state, map, rng, costAcc);
      state.rngState = rng.state;
    }
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1 && snap) {
      // 结算守恒校验
      assertMonthlyConservation(state, map, snap, `第 ${state.day} 日`);
      const n = state.nations[id];
      accIncomeSpending += n.monthly.income - n.monthly.spending;
      accReturn += n.monthly.investReturn;
      minTreasury = Math.min(minTreasury, n.treasury);
      minStability = Math.min(minStability, n.stability);
      minFood = Math.min(minFood, n.foodStock);
    }
  }

  const n = state.nations[id];
  // 终局断言
  check(Number.isFinite(minTreasury), `国库从未出现 NaN/±∞（最低 ${minTreasury.toFixed(1)} 万₭）`);
  check(minStability >= 0 && minStability <= 100, `稳定度全程 0-100（最低 ${minStability.toFixed(1)}）`);
  check(Number.isFinite(minFood), `粮食储备从未出现 NaN/±∞（最低 ${minFood.toFixed(1)} 万吨）`);
  if (minTreasury < BANKRUPTCY_THRESHOLD) {
    const bankruptLogged = state.chronicle.some((e) => e.title === '国库破产');
    check(bankruptLogged, `国库跌破下限记入大事记（最低 ${minTreasury.toFixed(0)} < ${BANKRUPTCY_THRESHOLD}）`);
  }
  // 投资项目账目一致：全程累计 国库终值 = 初始 + Σ(收支差 + 回报) - Σ成本 + Σ退款
  const expFinal =
    NATIONS[nation].treasury + accIncomeSpending + accReturn - costAcc.cost + costAcc.refund;
  check(Math.abs(n.treasury - expFinal) < 1e-4, `投资项目账目一致（终局国库 ${n.treasury.toFixed(1)} vs 累计推算 ${expFinal.toFixed(1)}）`);
  const activeCount = n.projects.filter((p) => p.status === 'active').length;
  const buildingCount = n.projects.filter((p) => p.status === 'building').length;
  check(activeCount + buildingCount === n.projects.length, `项目状态合法（在建 ${buildingCount} / 投产 ${activeCount}）`);
  check(n.investCostAcc === 0 && n.investRefundAcc === 0, `投资账本月清月结（累计 ${n.investCostAcc}/${n.investRefundAcc}）`);
  // 无事件系统：人工事件列表为空 → 休眠检查点 no-op；状态中不存在事件队列
  check(MANUAL_EVENTS.length === 0, `人工事件列表为空（${MANUAL_EVENTS.length} 条，休眠检查点 no-op）`);
  check(!('eventQueue' in state) && !('stats' in state), '状态中无事件队列/事件统计（事件系统已移除）');
  assertFiniteState(state, '终局');
  return { state, costAcc };
}

function snapshotOf(state: GameState): string {
  const n = state.nations[state.playerNation];
  // 取首个玩家省/县的市场样本（确定性比较用）
  let provSample: Record<string, number> = {};
  let countySample: Record<string, number> = {};
  const firstProv = Object.keys(n.provinceMarkets)[0];
  if (firstProv) {
    provSample = Object.fromEntries(GOODS.map((g) => [g, n.provinceMarkets[Number(firstProv)][g].price]));
  }
  const firstCounty = Object.keys(n.countyMarkets)[0];
  if (firstCounty) {
    countySample = Object.fromEntries(GOODS.map((g) => [g, n.countyMarkets[Number(firstCounty)][g].price]));
  }
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
    stocks: n.stocks,
    prices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].price])),
    provSample,
    countySample,
    infra: n.infra,
    emigration: n.emigration,
    chronicle: state.chronicle.length,
    projects: n.projects.map((p) => ({ k: p.kind, pid: p.provId, ml: p.monthsLeft, s: p.status })),
    monthly: n.monthly,
  });
}

/** 存档可序列化（v0.0.0 存档功能不回归：JSON 往返一致） */
function assertSaveRoundtrip(state: GameState): void {
  try {
    const text = JSON.stringify(state);
    const parsed = JSON.parse(text) as GameState;
    check(parsed.version === state.version, '存档版本号正确');
    check(parsed.day === state.day && parsed.playerNation === state.playerNation, '存档往返一致（day/playerNation）');
    check(JSON.stringify(parsed) === text, '存档 JSON 往返逐字节一致');
  } catch {
    check(false, '存档 JSON 序列化无异常');
  }
}

function main(): void {
  const map = loadMap();
  console.log('== 地图导入统计（v0.1 三级制）==');
  console.log(JSON.stringify(mapStats(map), null, 2));
  console.log('== 国家初始辖区 ==');
  for (const id of Object.keys(NATIONS) as NationId[]) {
    const def = NATIONS[id];
    const provs = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered);
    const cells = provs.reduce((s, p) => s + p.cellIds.length, 0);
    const counties = provs.reduce((s, p) => s + p.counties.length, 0);
    console.log(`  ${def.name}: ${provs.length} 行省 / ${counties} 县 / ${cells} 格`);
  }
  console.log(`  （未探明新大陆: ${map.provinces.filter((p) => p.isUndiscovered).length} 行省）`);
  console.log(`  （v0.2：事件系统已移除；人工事件池 ${MANUAL_EVENTS.length} 条（休眠））`);

  console.log('\n== 50 年沙盒（洛林，seed 42）==');
  const runA = simulate(42, 'lorraine', 50);
  const stateA = runA.state;
  const nA = stateA.nations.lorraine;
  console.log(`  终局：${stateA.day} 日（新历 ${1023 + Math.floor(stateA.day / DAYS_PER_YEAR)} 年）`);
  console.log(`  国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万`);
  console.log(`  识字率 ${(nA.literacy * 100).toFixed(1)}% · 健康 ${(nA.health * 100).toFixed(1)}% · 基建 路${nA.infra.roads.toFixed(0)}/港${nA.infra.ports.toFixed(0)}`);
  console.log(`  月收入 ${nA.monthly.income.toFixed(0)} · 支出 ${nA.monthly.spending.toFixed(0)} · 贸易收支 ${nA.monthly.tradeBalance.toFixed(1)} · 人口增长率 ${(nA.monthly.growthRate * 100).toFixed(2)}%/年`);
  console.log(`  奢侈品价 ${nA.market.luxury.price.toFixed(2)} · 投资回报 ${nA.monthly.investReturn.toFixed(1)}/月 · 精英投资收入 ${nA.monthly.investIncome.toFixed(1)}/月`);
  const activeA = nA.projects.filter((p) => p.status === 'active').length;
  const buildingA = nA.projects.filter((p) => p.status === 'building').length;
  console.log(`  投资项目：累计投入 ${runA.costAcc.cost.toFixed(0)} / 退款 ${runA.costAcc.refund.toFixed(0)} · 在产 ${activeA} / 在建 ${buildingA}`);
  console.log(`  大事记 ${stateA.chronicle.length} 条`);

  console.log('\n== 三级市场终局样例（洛林）==');
  for (const g of GOODS) {
    const m = nA.market[g];
    console.log(`  ${GOOD_LABEL[g]}: 国价 ${m.price.toFixed(2)} (供需 ${m.demand.toFixed(1)}/${m.supply.toFixed(1)}) · 产 ${m.supply.toFixed(1)} 消 ${m.consumed.toFixed(1)} 出 ${m.exported.toFixed(1)} 进 ${m.imported.toFixed(1)}`);
  }

  console.log('\n== 确定性：同种子两次结果一致 ==');
  const runB = simulate(42, 'lorraine', 50);
  const sa = snapshotOf(stateA);
  const sb = snapshotOf(runB.state);
  const deterministic = sa === sb;
  check(deterministic, '同种子（42）两次 50 年运行快照完全一致（含投资/三级市场/大事记）');
  if (!deterministic) {
    console.error('  快照A:', sa);
    console.error('  快照B:', sb);
  } else {
    console.log('  快照一致 ✓');
  }

  console.log('\n== 存档往返（v0.0.0 存档功能不回归）==');
  assertSaveRoundtrip(stateA);
  console.log('  存档 JSON 序列化/反序列化往返一致 ✓');

  console.log('\n== 时钟不回归（日/月推进正确）==');
  check(stateA.day === 50 * DAYS_PER_YEAR, `50 年 = ${50 * DAYS_PER_YEAR} 日（实际 ${stateA.day}）`);
  check(stateA.day % DAYS_PER_MONTH === 0, '结束于月末（结算完成）');

  console.log('\n== 其他两国冒烟测试（各 10 年，seed 7）==');
  for (const id of ['ianys', 'empire'] as NationId[]) {
    const s = simulate(7, id, 10);
    const n = s.state.nations[id];
    const active = n.projects.filter((p) => p.status === 'active').length;
    console.log(`  ${NATIONS[id].name}: 完成 10 年 ✓ 国库 ${n.treasury.toFixed(0)} · 稳定度 ${n.stability.toFixed(1)} · 人口 ${n.popWan.toFixed(0)} 万 · 投资 ${active} 在产`);
  }

  console.log(`\n== 断言汇总 ==`);
  console.log(`  通过 ${checks - failures} / ${checks}${failures === 0 ? ' — 全部通过 ✅' : ` — ${failures} 项失败 ❌`}`);
  if (failures > 0) {
    throw new Error(`模拟断言失败：${failures} 项未通过（${checks - failures}/${checks} 通过）`);
  }
}

main();
