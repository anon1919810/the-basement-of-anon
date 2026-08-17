/**
 * 无头模拟（tsx 运行）：30 年沙盒断言。
 *   - 选洛林，随机策略每月调税率/支出，随机处理事件
 *   - 断言：国库/粮食收支守恒（无 NaN / ±Infinity）、稳定度 0-100、
 *           事件全部处理、确定性（同种子两次结果一致）、30 年跑完不崩
 * 运行：npx.cmd tsx scripts/sim.ts
 */
import { loadMap, mapStats } from '../src/game/map';
import type { GameMap } from '../src/game/map';
import { newGameState, tickDay, processEvent, allFinite } from '../src/game/state';
import type { GameState } from '../src/game/state';
import { NATIONS } from '../src/game/nations';
import { Rng } from '../src/game/rng';
import { DAYS_PER_YEAR } from '../src/game/clock';
import { TAX_LEVELS, nationMonthlyIncome, nationMonthlySpending, nationMonthlyGrain, nationGrainConsumption } from '../src/game/economy';
import type { NationId } from '../src/game/types';

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
  check(allFinite(state), `数值全部有限（${at}）`);
  for (const id of Object.keys(state.nations) as NationId[]) {
    const n = state.nations[id];
    check(n.stability >= 0 && n.stability <= 100, `${NATIONS[id].name} 稳定度在 0-100（${at}: ${n.stability.toFixed(2)}）`);
    check(n.popWan > 0, `${NATIONS[id].name} 人口为正（${at}）`);
    check(n.literacy >= 0 && n.literacy <= 1, `${NATIONS[id].name} 识字率在 0-1（${at}）`);
  }
}

interface Snapshot {
  treasury: number;
  food: number;
  incomeM: number;
  spendM: number;
  grainM: number;
  consYear: number;
}

/** 月初随机调整税率与支出（确定性：经 state.rngState） */
function adjustPolicy(state: GameState): void {
  const rng = new Rng(state.rngState);
  const id = state.playerNation;
  const n = state.nations[id];
  n.taxLevel = TAX_LEVELS[rng.int(0, TAX_LEVELS.length)];
  const max = NATIONS[id].sliderMax;
  n.spending.military = rng.int(0, max + 1);
  n.spending.admin = rng.int(0, max + 1);
  n.spending.infra = rng.int(0, max + 1);
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
    const incomeM = nationMonthlyIncome(map, state, id);
    const consYear = nationGrainConsumption(state, id);
    const t0 = state.nations[id].treasury;
    const f0 = state.nations[id].foodStock;
    const dT = (opt?.effects.treasuryFrac ?? 0) * incomeM;
    const dF = (opt?.effects.foodFrac ?? 0) * consYear;
    processEvent(state, map, choice);
    const n = state.nations[id];
    check(Math.abs(n.treasury - (t0 + dT)) < 1e-6, `事件「${ev.title}」国库收支守恒（Δ${dT.toFixed(1)}）`);
    check(Math.abs(n.foodStock - (f0 + dF)) < 1e-6, `事件「${ev.title}」粮食收支守恒（Δ${dF.toFixed(1)}）`);
  }
  state.rngState = rng.state;
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
    const mod = state.day % 30;
    if (mod === 1) adjustPolicy(state); // 月初：随机策略
    if (mod === 29) {
      // 月末前快照（结算发生在 tickDay 后 day%30==0）
      const n = state.nations[id];
      snap = {
        treasury: n.treasury,
        food: n.foodStock,
        incomeM: nationMonthlyIncome(map, state, id),
        spendM: nationMonthlySpending(state, id),
        grainM: nationMonthlyGrain(map, state, id),
        consYear: nationGrainConsumption(state, id),
      };
    }
    tickDay(state, map);
    if (mod === 29 && snap) {
      // 结算守恒校验
      const n = state.nations[id];
      const expT = snap.treasury + snap.incomeM - snap.spendM;
      check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（第 ${state.day} 日：${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);
      let expF = snap.food + snap.grainM;
      if (expF < -snap.consYear) expF = -snap.consYear; // 与 settleMonth 的缺粮下限一致
      check(Math.abs(n.foodStock - expF) < 1e-6, `粮食守恒（第 ${state.day} 日：${expF.toFixed(1)} vs ${n.foodStock.toFixed(1)}）`);
      assertFiniteState(state, `第 ${state.day} 日`);
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
    log: state.eventLog.length,
    spawned: state.stats.spawned,
    processed: state.stats.processed,
  });
}

function main(): void {
  const map = loadMap();
  console.log('== 地图导入统计 ==');
  console.log(JSON.stringify(mapStats(map), null, 2));
  console.log('== 国家初始辖区 ==');
  for (const id of Object.keys(NATIONS) as NationId[]) {
    const def = NATIONS[id];
    const provs = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered);
    const cells = provs.reduce((s, p) => s + p.cellIds.length, 0);
    console.log(`  ${def.name}: ${provs.length} 行省 / ${cells} 格`);
  }
  console.log(`  （未探明新大陆: ${map.provinces.filter((p) => p.isUndiscovered).length} 行省）`);

  console.log('\n== 30 年沙盒（洛林，seed 42）==');
  const runA = simulate(42, 'lorraine', 30);
  const nA = runA.nations.lorraine;
  console.log(`  终局：${runA.day} 日（新历 ${1023 + Math.floor(runA.day / DAYS_PER_YEAR)} 年）`);
  console.log(`  国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万 · 识字率 ${(nA.literacy * 100).toFixed(1)}%`);
  console.log(`  事件 ${runA.stats.spawned} 生成 / ${runA.stats.processed} 处理`);

  console.log('\n== 确定性：同种子两次结果一致 ==');
  const runB = simulate(42, 'lorraine', 30);
  const sa = snapshotOf(runA);
  const sb = snapshotOf(runB);
  const deterministic = sa === sb;
  check(deterministic, '同种子（42）两次 30 年运行快照完全一致');
  if (!deterministic) {
    console.error('  快照A:', sa);
    console.error('  快照B:', sb);
  } else {
    console.log('  快照一致 ✓');
  }

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
