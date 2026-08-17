/**
 * 无头模拟（v0.1，tsx 运行）：50 年沙盒断言（洛林，seed 42）。
 *  - 随机策略：每月随机调税率/五类支出/偶尔转职，随机处理事件
 *  - 断言：
 *    1) 无 NaN/±∞（全状态有限）
 *    2) 国库守恒（Δ国库 = 收入 - 支出）
 *    3) 各商品守恒（生产 + 进口 = 消费 + 出口 + 库存变化，容差 1%）
 *    4) 价格恒正且在 clamp 范围（0.4~2.5 × 基础价）
 *    5) 省人口 ≤ 住房容量；POP size ≥ 0
 *    6) 确定性：同种子两次 50 年快照完全一致
 *    7) 崩溃保护：国库可负但触发「破产」事件，不 NaN
 *    8) 时钟/事件/存档不回归（v0.0.0）
 * 运行：npx.cmd tsx scripts/sim.ts
 */
import { loadMap, mapStats } from '../src/game/map';
import type { GameMap } from '../src/game/map';
import { newGameState, tickDay, processEvent, allFinite } from '../src/game/state';
import type { GameState } from '../src/game/state';
import { NATIONS } from '../src/game/nations';
import { Rng } from '../src/game/rng';
import { DAYS_PER_MONTH, DAYS_PER_YEAR } from '../src/game/clock';
import { BANKRUPTCY_THRESHOLD, TAX_LEVELS } from '../src/game/economy';
import { GOODS, JOB_LABEL } from '../src/game/pops';
import { retrainPop } from '../src/game/labor';
import { PRICE_CLAMP_MAX, PRICE_CLAMP_MIN } from '../src/game/market';
import { EVENT_TEMPLATES } from '../src/game/events';
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

/** 月初随机调整税率与支出（确定性：经 state.rngState） */
function adjustPolicy(state: GameState, map: GameMap): void {
  const rng = new Rng(state.rngState);
  const id = state.playerNation;
  const n = state.nations[id];
  n.taxLevel = TAX_LEVELS[rng.int(0, TAX_LEVELS.length)];
  const max = NATIONS[id].sliderMax;
  n.spending.military = rng.int(0, max + 1);
  n.spending.admin = rng.int(0, max + 1);
  n.spending.infra = rng.int(0, max + 1);
  n.spending.court = rng.int(0, max + 1);
  n.spending.health = rng.int(0, max + 1);
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
  state.rngState = rng.state;
}

/** 处理队内所有事件（随机选项），并逐条校验事件收支守恒 */
function processQueuedEvents(state: GameState, map: GameMap): void {
  const id = state.playerNation;
  const rng = new Rng(state.rngState);
  while (state.eventQueue.length > 0) {
    const ev = state.eventQueue[0];
    const choice = rng.int(0, Math.max(1, ev.options.length));
    const opt = ev.options[choice] ?? ev.options[0];
    const incomeM = state.nations[id].monthly.income;
    const t0 = state.nations[id].treasury;
    const dT = (opt?.effects.treasuryFrac ?? 0) * Math.abs(incomeM);
    processEvent(state, map, choice);
    const n = state.nations[id];
    if (opt?.effects.treasuryFrac !== undefined) {
      check(Math.abs(n.treasury - (t0 + dT)) < 1e-6, `事件「${ev.title}」国库收支守恒（Δ${dT.toFixed(1)}）`);
    }
    check(Number.isFinite(n.treasury) && Number.isFinite(n.foodStock), `事件「${ev.title}」处理后数值有限`);
  }
  state.rngState = rng.state;
}

/** 月度结算守恒断言（在 tickDay 结算前后） */
function assertMonthlyConservation(state: GameState, map: GameMap, snap: Snapshot, at: string): void {
  const n = state.nations[state.playerNation];
  // 国库守恒：Δ = 收入 - 支出
  const expT = snap.treasury + n.monthly.income - n.monthly.spending;
  check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（${at}: ${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);
  // 商品守恒：生产 + 进口 = 消费 + 出口 + Δ库存（容差 1%）
  for (const g of GOODS) {
    const m = n.market[g];
    const dStock = n.stocks[g] - snap.stocks[g];
    const lhs = m.supply + m.imported;
    const rhs = m.consumed + m.exported + dStock;
    const volume = Math.max(1e-6, Math.abs(lhs) + Math.abs(rhs));
    check(Math.abs(lhs - rhs) <= 0.01 * volume + 1e-6, `商品「${g}」守恒（${at}: 产+进 ${lhs.toFixed(3)} vs 消+出+Δ ${rhs.toFixed(3)}）`);
    // 价格恒正且在 clamp 范围
    check(m.price > 0 && m.price <= m.basePrice * PRICE_CLAMP_MAX + 1e-9 && m.price >= m.basePrice * PRICE_CLAMP_MIN - 1e-9,
      `价格在 clamp 范围（${at}: ${g} ${m.price.toFixed(2)} ∈ [${(m.basePrice * PRICE_CLAMP_MIN).toFixed(2)}, ${(m.basePrice * PRICE_CLAMP_MAX).toFixed(2)}]）`);
  }
  // 省人口 ≤ 住房容量；POP size ≥ 0
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    check(ps.popTotal <= ps.housingCap + 1e-6, `省人口 ≤ 住房容量（${at}: 行省#${p.id + 1} ${ps.popTotal.toFixed(2)} ≤ ${ps.housingCap.toFixed(2)}）`);
    for (const pop of ps.pops) {
      check(pop.size >= -1e-9, `POP size ≥ 0（${at}: 行省#${p.id + 1} ${JOB_LABEL[pop.job]} ${pop.size.toFixed(4)}）`);
    }
  }
  assertFiniteState(state, at);
}

function simulate(seed: number, nation: NationId, years: number): GameState {
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
    if (mod === 1) adjustPolicy(state, map); // 月初：随机策略
    if (mod === DAYS_PER_MONTH - 1) {
      // 月末前快照（结算发生在 tickDay 后 day%30==0）
      const n = state.nations[id];
      snap = { treasury: n.treasury, stocks: { ...n.stocks }, day: state.day };
    }
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1 && snap) {
      // 结算守恒校验
      assertMonthlyConservation(state, map, snap, `第 ${state.day} 日`);
      const n = state.nations[id];
      processQueuedEvents(state, map); // 结算后处理事件（随机关卡）
      minTreasury = Math.min(minTreasury, n.treasury);
      minStability = Math.min(minStability, n.stability);
      minFood = Math.min(minFood, n.foodStock);
    }
  }

  // 终局断言
  check(state.eventQueue.length === 0, `结束时无滞留事件（剩余 ${state.eventQueue.length}）`);
  check(state.stats.spawned === state.stats.processed, `事件全部处理（生成 ${state.stats.spawned} / 处理 ${state.stats.processed}）`);
  check(state.stats.processed >= Math.floor(years * 3), `事件量合理（共 ${state.stats.processed} 条，≥${years * 3}）`);
  check(Number.isFinite(minTreasury), `国库从未出现 NaN/±∞（最低 ${minTreasury.toFixed(1)} 万₭）`);
  check(minStability >= 0 && minStability <= 100, `稳定度全程 0-100（最低 ${minStability.toFixed(1)}）`);
  check(Number.isFinite(minFood), `粮食储备从未出现 NaN/±∞（最低 ${minFood.toFixed(1)} 万吨）`);
  if (minTreasury < BANKRUPTCY_THRESHOLD) {
    const bankruptLogged = state.eventLog.some((e) => e.title === '国库破产');
    check(bankruptLogged, `国库跌破下限触发「破产」事件（最低 ${minTreasury.toFixed(0)} < ${BANKRUPTCY_THRESHOLD}）`);
  }
  assertFiniteState(state, '终局');
  return state;
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
    stocks: n.stocks,
    prices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].price])),
    infra: n.infra,
    emigration: n.emigration,
    log: state.eventLog.length,
    spawned: state.stats.spawned,
    processed: state.stats.processed,
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
  console.log(`  （事件模板 ${EVENT_TEMPLATES.length} 条：12 条 v0.0.0 + 3 条 v0.1 经济事件，其中「国库破产」仅代码触发）`);

  console.log('\n== 50 年沙盒（洛林，seed 42）==');
  const runA = simulate(42, 'lorraine', 50);
  const nA = runA.nations.lorraine;
  console.log(`  终局：${runA.day} 日（新历 ${1023 + Math.floor(runA.day / DAYS_PER_YEAR)} 年）`);
  console.log(`  国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万`);
  console.log(`  识字率 ${(nA.literacy * 100).toFixed(1)}% · 健康 ${(nA.health * 100).toFixed(1)}% · 基建 路${nA.infra.roads.toFixed(0)}/港${nA.infra.ports.toFixed(0)}`);
  console.log(`  月收入 ${nA.monthly.income.toFixed(0)} · 支出 ${nA.monthly.spending.toFixed(0)} · 贸易收支 ${nA.monthly.tradeBalance.toFixed(1)} · 人口增长率 ${(nA.monthly.growthRate * 100).toFixed(2)}%/年`);
  console.log(`  事件 ${runA.stats.spawned} 生成 / ${runA.stats.processed} 处理`);

  console.log('\n== 确定性：同种子两次结果一致 ==');
  const runB = simulate(42, 'lorraine', 50);
  const sa = snapshotOf(runA);
  const sb = snapshotOf(runB);
  const deterministic = sa === sb;
  check(deterministic, '同种子（42）两次 50 年运行快照完全一致');
  if (!deterministic) {
    console.error('  快照A:', sa);
    console.error('  快照B:', sb);
  } else {
    console.log('  快照一致 ✓');
  }

  console.log('\n== 存档往返（v0.0.0 存档功能不回归）==');
  assertSaveRoundtrip(runA);
  console.log('  存档 JSON 序列化/反序列化往返一致 ✓');

  console.log('\n== 时钟不回归（日/月推进正确）==');
  check(runA.day === 50 * DAYS_PER_YEAR, `50 年 = ${50 * DAYS_PER_YEAR} 日（实际 ${runA.day}）`);
  check(runA.day % DAYS_PER_MONTH === 0, '结束于月末（结算完成）');

  console.log('\n== 其他两国冒烟测试（各 10 年，seed 7）==');
  for (const id of ['ianys', 'empire'] as NationId[]) {
    const s = simulate(7, id, 10);
    const n = s.nations[id];
    console.log(`  ${NATIONS[id].name}: 完成 10 年 ✓ 国库 ${n.treasury.toFixed(0)} · 稳定度 ${n.stability.toFixed(1)} · 人口 ${n.popWan.toFixed(0)} 万 · 事件 ${s.stats.processed}`);
  }

  console.log(`\n== 断言汇总 ==`);
  console.log(`  通过 ${checks - failures} / ${checks}${failures === 0 ? ' — 全部通过 ✅' : ` — ${failures} 项失败 ❌`}`);
  if (failures > 0) {
    throw new Error(`模拟断言失败：${failures} 项未通过（${checks - failures}/${checks} 通过）`);
  }
}

main();
