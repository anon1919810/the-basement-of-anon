/**
 * 无头模拟（v0.4，tsx 运行）：
 *  - 洛林 50 年沙盒断言（seed 42，随机策略：税率滑块/支出/转职/建筑投资/政策）
 *  - 8 国冒烟：每国 10 年（随机策略）不崩、无 NaN、守恒
 *  - 洛林 50 年全断言：守恒（含六税种收入与传导账）、价格恒正 clamp、阶级恒正、
 *    单一商品税生效（煤炭税 15% → 煤有效价↑、炼铁成本↑、钢材价↑，含单元级传导测试）、
 *    确定性（同种子两次快照一致）、存档往返
 *  - 帝国 10 年冒烟：废农奴制
 * 运行：npx.cmd tsx scripts/sim.ts
 */
import { loadMap, mapStats, provinceOwnerTable } from '../src/game/map';
import type { GameMap } from '../src/game/map';
import { newGameState, tickDay, allFinite, abolishSerfdom, setPolicy, scaledNationPops, nationHousingCap } from '../src/game/state';
import type { GameState } from '../src/game/state';
import { NATIONS, NATION_LIST } from '../src/game/nations';
import { Rng } from '../src/game/rng';
import { DAYS_PER_MONTH, DAYS_PER_YEAR, monthIndex } from '../src/game/clock';
import { BANKRUPTCY_THRESHOLD, nationClassMixOf, nationSlavePop, GOOD_PRODUCERS } from '../src/game/economy';
import { GOODS, GOOD_LABEL, JOB_LABEL } from '../src/game/pops';
import { CLASSES, CLASS_LABEL } from '../src/game/classes';
import { TAX_KINDS, TAX_MAX } from '../src/game/tax';
import { retrainPop } from '../src/game/labor';
import { newMarket, PRICE_CLAMP_MAX, PRICE_CLAMP_MIN, settleMarket, zeroGoods } from '../src/game/market';
import type { MarketInput, MarketState } from '../src/game/market';
import { BUILDING_DEFS, BUILDING_KINDS, buildingUnlock, cancelInvestment, nationHasGood, startInvestment } from '../src/game/buildings';
import { MANUAL_EVENTS } from '../src/game/manualEvents';
import type { GoodId, NationId } from '../src/game/types';
import { provinceHasResource } from '../src/game/resources';

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
  check(Number.isFinite(n.unrest) && n.unrest >= 0, `动乱指数有限非负（${at}: ${n.unrest.toFixed(3)}）`);
}

interface Snapshot {
  treasury: number;
  stocks: Record<GoodId, number>;
  day: number;
}

/** 月初随机调整税率滑块与支出 + 随机开关政策（确定性：经 rng） */
function adjustPolicy(state: GameState, map: GameMap, rng: Rng): void {
  const id = state.playerNation;
  const n = state.nations[id];
  // v0.4 立体税制：60% 概率随机调一个税种（0-30%，0.5% 步进），40% 概率随机调 1-2 个商品税
  if (rng.chance(0.6)) {
    const kind = TAX_KINDS[rng.int(0, TAX_KINDS.length)];
    n.tax.rates[kind] = rng.int(0, 61) / 200;
  } else {
    const nGoods = 1 + rng.int(0, 2);
    for (let i = 0; i < nGoods; i++) {
      const g = GOODS[rng.int(0, GOODS.length)];
      n.tax.goods[g] = rng.int(0, 61) / 200;
    }
  }
  check(Object.values(n.tax.rates).every((v) => v >= 0 && v <= TAX_MAX), `五税种税率在 0-30%（${JSON.stringify(n.tax.rates)}）`);
  const max = NATIONS[id].sliderMax;
  // 总预算内随机分配五类支出：上限 = min(滑杆上限, 上月收入×1.3 + 60) —— 随机会超支但不至于永久破产
  const cap = Math.min(max + 1, Math.max(60, Math.floor(n.monthly.income * 1.3) + 1));
  const budget = rng.int(0, cap);
  let rem = budget;
  const kinds = ['military', 'admin', 'infra', 'court', 'health'] as const;
  for (let i = 0; i < kinds.length; i++) {
    const isLast = i === kinds.length - 1;
    const v = isLast ? rem : rng.int(0, rem + 1);
    n.spending[kinds[i]] = v;
    rem -= v;
  }
  // 随机开关政策（累进税 12% / 普选 8% 概率切换）
  if (rng.chance(0.12)) setPolicy(state, 'progressiveTax', !n.policies.progressiveTax);
  if (rng.chance(0.08)) setPolicy(state, 'universalSuffrage', !n.policies.universalSuffrage);
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

/** 随机建筑投资：选「国家层已解锁」的种类 + 「省层解锁」的省份（每月至多 2 次）/ 取消在建 */
function investRandom(state: GameState, map: GameMap, rng: Rng, costAcc: { cost: number; refund: number }): void {
  const n = state.nations[state.playerNation];
  const view = { stocks: n.stocks, projects: n.projects, literacy: n.literacy };
  const provIds = map.provinces
    .filter((p) => p.owner === state.playerNation && !p.isUndiscovered)
    .map((p) => p.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!rng.chance(0.5)) continue;
    // 国家层解锁的种类（半成品链条门控：先产铁锭才能炼钢等）
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
    if (eligible.length > 0) {
      const pid = eligible[rng.int(0, eligible.length)];
      const cost = BUILDING_DEFS[kind].cost;
      if (n.treasury >= cost) {
        const p = startInvestment(state, map, kind, pid);
        if (p) {
          costAcc.cost += cost;
          check(p.monthsLeft === BUILDING_DEFS[kind].duration, `新建建筑工期正确（${BUILDING_DEFS[kind].label} ${p.monthsLeft} 月）`);
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

/** 建筑输入消耗（守恒断言：生产+进口 = 消费+出口+Δ库存+建筑消耗） */
function buildingUsedOf(n: { projects: { lastInputUsed: Record<GoodId, number> }[] }, g: GoodId): number {
  let sum = 0;
  for (const p of n.projects) sum += p.lastInputUsed[g] ?? 0;
  return sum;
}

/** 月度结算守恒断言（在 tickDay 结算前后） */
function assertMonthlyConservation(state: GameState, map: GameMap, snap: Snapshot, at: string): void {
  const n = state.nations[state.playerNation];
  // 国库守恒：Δ = 收入 - 支出 + 建筑回报 - 投资成本 + 取消退款（收入含六税种）
  const expT =
    snap.treasury +
    n.monthly.income -
    n.monthly.spending +
    n.monthly.investReturn -
    n.monthly.investCost +
    n.monthly.investRefund;
  check(Math.abs(n.treasury - expT) < 1e-6, `国库守恒（${at}: ${expT.toFixed(1)} vs ${n.treasury.toFixed(1)}）`);
  // 税制账本：收入 = 六税种之和（土地+人头+消费+关税+特别+商品税）
  const taxSum =
    n.monthly.pollTax + n.monthly.landTax + n.monthly.consumptionTax +
    n.monthly.tariff + n.monthly.otherTax + n.monthly.goodsTax;
  check(Math.abs(n.monthly.income - taxSum) < 1e-6, `税制账本一致（收入 ${n.monthly.income.toFixed(2)} = 六税种 ${taxSum.toFixed(2)}）`);
  // 商品守恒：生产 + 进口 = 消费 + 出口 + Δ库存 + 建筑消耗（容差 1%）；价格恒正且在 clamp 范围
  for (const g of GOODS) {
    const m = n.market[g];
    const dStock = n.stocks[g] - snap.stocks[g];
    const bUsed = buildingUsedOf(n, g);
    const lhs = m.supply + m.imported;
    const rhs = m.consumed + m.exported + dStock + bUsed;
    const volume = Math.max(1e-6, Math.abs(lhs) + Math.abs(rhs));
    check(Math.abs(lhs - rhs) <= 0.01 * volume + 1e-6, `商品「${GOOD_LABEL[g]}」守恒（${at}: 产+进 ${lhs.toFixed(3)} vs 消+出+Δ+建 ${rhs.toFixed(3)}）`);
    check(m.price > 0 && m.price <= m.basePrice * PRICE_CLAMP_MAX + 1e-9 && m.price >= m.basePrice * PRICE_CLAMP_MIN - 1e-9,
      `国家价在 clamp 范围（${at}: ${g} ${m.price.toFixed(2)} ∈ [${(m.basePrice * PRICE_CLAMP_MIN).toFixed(2)}, ${(m.basePrice * PRICE_CLAMP_MAX).toFixed(2)}]）`);
    check(Number.isFinite(m.effPrice) && Number.isFinite(m.costPush), `有效价/传导有限（${at}: ${g}）`);
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
  // 省人口 ≤ 住房容量；POP size ≥ 0；阶级规模恒正、七级总和 = 总人口
  const natMix = nationClassMixOf(map, state, state.playerNation);
  let natMixSum = 0;
  for (const c of CLASSES) {
    check(natMix[c] >= -1e-9, `阶级 ${CLASS_LABEL[c]} 规模 ≥ 0（${at}: ${natMix[c].toFixed(3)}）`);
    natMixSum += natMix[c];
  }
  check(Math.abs(natMixSum - n.popWan) < 0.05, `七级总和 = 总人口（${at}: ${natMixSum.toFixed(2)} vs ${n.popWan.toFixed(2)}）`);
  // v0.5 迁移软化：省人口可临时超容（≤容量×1.1）；月迁移上限（单省 2% 容量）生效
  const natCap = nationHousingCap(map, state.playerNation);
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    check(ps.popTotal <= ps.housingCap * 1.1 + 1e-6, `省人口 ≤ 容量×1.1（${at}: 行省#${p.id + 1} ${ps.popTotal.toFixed(2)} ≤ ${(ps.housingCap * 1.1).toFixed(2)}）`);
    let provSum = 0;
    for (const pop of ps.pops) {
      check(pop.size >= -1e-9, `POP size ≥ 0（${at}: 行省#${p.id + 1} ${JOB_LABEL[pop.job]}/${CLASS_LABEL[pop.class]} ${pop.size.toFixed(4)}）`);
      provSum += pop.size;
    }
    check(Math.abs(provSum - ps.popTotal) < 1e-6, `省阶级总和 = 省人口（${at}: 行省#${p.id + 1}）`);
  }
  check(n.monthly.migrationOut <= natCap * 0.02 + 1e-6,
    `迁移月上限生效（${at}: 迁出 ${n.monthly.migrationOut.toFixed(3)} ≤ 容量×2% ${(natCap * 0.02).toFixed(2)}）`);
  check(n.emigration <= natCap * 0.02 + 1e-6,
    `流民不超月上限（${at}: ${n.emigration.toFixed(3)} ≤ ${(natCap * 0.02).toFixed(2)}）`);
  check(n.monthly.migrationOut >= -1e-9 && n.monthly.migrationIn >= -1e-9, `迁移账非负（${at}）`);
  // 建筑账目：进度合法、技能要求生效（0 技能 POP → 产能 0）、输入可用系数 0-1
  for (const pr of n.projects) {
    check(pr.monthsLeft >= 0 && pr.monthsLeft <= pr.duration, `建筑进度合法（${at}: ${BUILDING_DEFS[pr.kind].label} 剩余 ${pr.monthsLeft}/${pr.duration} 月）`);
    if (pr.status === 'active') {
      check(pr.lastSkillFactor >= 0 && pr.lastSkillFactor <= 1, `技能满足系数 0-1（${at}: ${BUILDING_DEFS[pr.kind].label} ${pr.lastSkillFactor.toFixed(3)}）`);
      check(pr.lastRunFactor >= 0 && pr.lastRunFactor <= 1, `输入可用系数 0-1（${at}: ${BUILDING_DEFS[pr.kind].label} ${pr.lastRunFactor.toFixed(3)}）`);
      const ps = state.provinces[pr.provId];
      const skillPop = ps ? ps.pops.filter((x) => x.job === BUILDING_DEFS[pr.kind].skill).reduce((s, x) => s + x.size, 0) : 0;
      if (skillPop < 1e-9) {
        check(pr.lastOutput < 1e-9, `无对应职业 POP → 建筑产能打折为 0（${at}: ${BUILDING_DEFS[pr.kind].label} 产出 ${pr.lastOutput.toFixed(4)}）`);
      }
    }
  }
  assertFiniteState(state, at);
}

/**
 * 主模拟循环。
 * opts:
 *  - abolishAtMonth: 指定月份执行废农奴制（帝国冒烟）
 *  - quiet: 不做随机策略/随机投资（确定性传导测试用）；配合 coalTax/forceChain
 *  - coalTax: quiet 模式下每月固定煤炭税（0 = 对照组）
 *  - forceChain: quiet 模式下确定性建造 炼铁厂→炼钢厂（洛林煤省；测试产业链传导）
 */
function simulate(
  seed: number,
  nation: NationId,
  years: number,
  opts?: { abolishAtMonth?: number; quiet?: boolean; coalTax?: number; forceChain?: boolean },
): { state: GameState; costAcc: { cost: number; refund: number }; ironCostAt15: number | null } {
  const map = loadMap();
  const state = newGameState(nation, seed, map);
  const id = state.playerNation;
  const n = state.nations[id];
  const days = years * DAYS_PER_YEAR;
  const startPop = n.popWan; // v0.5 存活断言基准

  let minTreasury = Infinity;
  let minStability = Infinity;
  let minFood = Infinity;
  let snap: Snapshot | null = null;
  const costAcc = { cost: 0, refund: 0 };
  // 全程累计（终局账目一致断言）
  let accIncomeSpending = 0;
  let accReturn = 0;
  // 传导测试记录（第 15 月：炼铁厂首个运行月）
  let ironCostAt15: number | null = null;
  let injectedTreasury = 0;
  const ironChain = opts?.quiet && opts.forceChain === true;
  if (ironChain) {
    // 测试注入：洛林无铁矿资源（煤税测试需确定性产铁），补充 煤炭/铁矿 库存与国库
    n.stocks.coal += 200;
    n.stocks.ironOre += 100;
    injectedTreasury = 2000;
    n.treasury += injectedTreasury;
    n.spending = { military: 40, admin: 30, infra: 60, court: 15, health: 10 };
  }
  let ironStarted = false;
  let steelStarted = false;

  for (let d = 0; d < days; d++) {
    const mod = state.day % DAYS_PER_MONTH;
    const mi = monthIndex(state.day);
    if (mod === 1) {
      if (!opts?.quiet) {
        // 月初：随机策略（税率滑块/支出/转职/政策）
        const rng = new Rng(state.rngState);
        adjustPolicy(state, map, rng);
        // 帝国冒烟：指定月份执行废农奴制
        if (opts?.abolishAtMonth !== undefined && mi === opts.abolishAtMonth - 1) {
          const before = nationSlavePop(map, state, id);
          check(before > 0, `废农奴制前奴隶 > 0（${before.toFixed(1)} 万）`);
          const stabBefore = state.nations[id].stability;
          const ok = abolishSerfdom(state, map);
          check(ok, '废农奴制政策执行成功');
          check(state.nations[id].stability <= stabBefore - 10, `废农奴制短期稳定度下降（${stabBefore.toFixed(1)} → ${state.nations[id].stability.toFixed(1)}）`);
          check(nationSlavePop(map, state, id) <= 1e-6, '废农奴制后奴隶归零');
        }
        state.rngState = rng.state;
      } else if ((opts?.coalTax ?? 0) > 0) {
        // quiet 模式：固定煤炭税
        n.tax.goods.coal = opts.coalTax as number;
      }
    }
    if (mod === DAYS_PER_MONTH - 1) {
      // 月末前快照（结算发生在 tickDay 后 day%30==0）
      const n2 = state.nations[id];
      snap = { treasury: n2.treasury, stocks: { ...n2.stocks }, day: state.day };
      if (!opts?.quiet) {
        // 随机建筑投资（快照后、结算前，成本/退款即时入账）
        const rng = new Rng(state.rngState);
        investRandom(state, map, rng, costAcc);
        state.rngState = rng.state;
      }
      // quiet 传导链：确定性建造 炼铁厂（第 6 月，道路达标）→ 炼钢厂（第 14 月，已有铁锭库存）。
      // 与 investRandom 同窗口（快照后、结算前），保证守恒断言口径一致；成本计入 costAcc。
      if (ironChain) {
        if (!ironStarted && mi >= 6) {
          const prov = map.provinces.find((p) => p.owner === nation && !p.isUndiscovered && provinceHasResource(p, 'coal'));
          if (prov) {
            const p = startInvestment(state, map, 'ironWorks', prov.id);
            if (p) {
              ironStarted = true;
              costAcc.cost += BUILDING_DEFS.ironWorks.cost;
            }
          }
        }
        if (!steelStarted && mi >= 14) {
          const view = { stocks: n.stocks, projects: n.projects, literacy: n.literacy };
          if (nationHasGood(view, 'iron')) {
            const prov = map.provinces.find((p) => p.owner === nation && !p.isUndiscovered);
            if (prov) {
              const p = startInvestment(state, map, 'steelWorks', prov.id);
              if (p) {
                steelStarted = true;
                costAcc.cost += BUILDING_DEFS.steelWorks.cost;
              }
            }
          }
        }
      }
    }
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1 && snap) {
      // 结算守恒校验
      assertMonthlyConservation(state, map, snap, `第 ${state.day} 日`);
      const n2 = state.nations[id];
      accIncomeSpending += n2.monthly.income - n2.monthly.spending;
      accReturn += n2.monthly.investReturn;
      minTreasury = Math.min(minTreasury, n2.treasury);
      minStability = Math.min(minStability, n2.stability);
      minFood = Math.min(minFood, n2.foodStock);
      // 传导测试：第 15 月（炼铁厂首个完整运行月）记录输入成本
      if (ironChain && mi === 14) {
        const iw = n2.projects.find((p) => p.kind === 'ironWorks' && p.status === 'active');
        if (iw) ironCostAt15 = iw.lastInputCost;
      }
    }
  }

  // 终局断言
  check(Number.isFinite(minTreasury), `国库从未出现 NaN/±∞（最低 ${minTreasury.toFixed(1)} 万₭）`);
  check(minStability >= 0 && minStability <= 100, `稳定度全程 0-100（最低 ${minStability.toFixed(1)}）`);
  check(Number.isFinite(minFood), `粮食储备从未出现 NaN/±∞（最低 ${minFood.toFixed(1)} 万吨）`);
  if (minTreasury < BANKRUPTCY_THRESHOLD) {
    const bankruptLogged = state.chronicle.some((e) => e.title === '国库破产');
    check(bankruptLogged, `国库跌破下限记入大事记（最低 ${minTreasury.toFixed(0)} < ${BANKRUPTCY_THRESHOLD}）`);
  }
  // 建筑账目一致：全程累计 国库终值 = 初始（含测试注入） + Σ(收支差 + 回报) - Σ成本 + Σ退款
  const expFinal =
    NATIONS[nation].treasury + injectedTreasury + accIncomeSpending + accReturn - costAcc.cost + costAcc.refund;
  check(Math.abs(n.treasury - expFinal) < 1e-4, `建筑账目一致（终局国库 ${n.treasury.toFixed(1)} vs 累计推算 ${expFinal.toFixed(1)}）`);
  const activeCount = n.projects.filter((p) => p.status === 'active').length;
  const buildingCount = n.projects.filter((p) => p.status === 'building').length;
  check(activeCount + buildingCount === n.projects.length, `建筑状态合法（在建 ${buildingCount} / 投产 ${activeCount}）`);
  check(n.investCostAcc === 0 && n.investRefundAcc === 0, `投资账本月清月结（累计 ${n.investCostAcc}/${n.investRefundAcc}）`);
  // 无事件系统：人工事件列表为空 → 休眠检查点 no-op；状态中不存在事件队列
  check(MANUAL_EVENTS.length === 0, `人工事件列表为空（${MANUAL_EVENTS.length} 条，休眠检查点 no-op）`);
  check(!('eventQueue' in state) && !('stats' in state), '状态中无事件队列/事件统计（事件系统已移除）');
  // v0.5 人口修复：10 年（及 50 年）后人口不得塌缩到起始 40% 以下（伊尼亚斯/奥兰治等小国）
  check(n.popWan > startPop * 0.4,
    `终局人口 > 起始 40%（${NATIONS[nation].name} ${years} 年: ${n.popWan.toFixed(1)} > ${(startPop * 0.4).toFixed(1)}）`);
  assertFiniteState(state, '终局');
  return { state, costAcc, ironCostAt15 };
}

function snapshotOf(state: GameState): string {
  const n = state.nations[state.playerNation];
  const mix = nationClassMixOf(loadMap(), state, state.playerNation);
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
    unrest: n.unrest,
    slavePop: n.slavePop,
    policies: n.policies,
    tax: n.tax,
    classMix: mix,
    stocks: n.stocks,
    prices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].price])),
    effPrices: Object.fromEntries(GOODS.map((g) => [g, n.market[g].effPrice])),
    costPushes: Object.fromEntries(GOODS.map((g) => [g, n.market[g].costPush])),
    provSample,
    countySample,
    infra: n.infra,
    emigration: n.emigration,
    chronicle: state.chronicle.length,
    projects: n.projects.map((p) => ({ k: p.kind, pid: p.provId, ml: p.monthsLeft, s: p.status, sf: p.lastSkillFactor, rf: p.lastRunFactor })),
    monthly: n.monthly,
  });
}

/** 存档可序列化（JSON 往返一致） */
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

/**
 * 商品税传导测试（v0.4 核心验证）：
 *  - 单元级：合成市场输入直接测 settleMarket 的成本传导机制（煤炭税 15% → 铁/钢传导 + 商品税收入）
 *  - 集成级：洛林 quiet 24 个月，确定性建 炼铁厂→炼钢厂，煤炭税 15% vs 对照组：
 *      煤有效价↑（= 市价×1.15）、炼铁厂输入成本↑（按税后价）、钢材价↑（传导进市场定价）
 */
function commodityTaxTransmissionTest(): void {
  const coalTax = 0.15;
  // ---- 单元级 ----
  {
    const markets: MarketState = { national: newMarket(), province: {}, county: {} };
    const goodsTax = zeroGoods();
    goodsTax.coal = coalTax;
    const input: MarketInput = {
      counties: [],
      factorySupply: zeroGoods(),
      govDemand: zeroGoods(),
      buildingDemand: zeroGoods(),
      buildingConsumed: zeroGoods(),
      stocks: zeroGoods(),
      routeCoef: 1,
      tariffRate: 0.1,
      goodsTax,
      producers: GOOD_PRODUCERS,
      crossFreight: {},
      natFreight: 1,
    };
    input.factorySupply.coal = 10;
    input.govDemand.coal = 10;
    input.buildingConsumed.coal = 2;
    const snap = settleMarket(input, markets);
    const nat = snap.goods;
    check(Math.abs(nat.coal.effPrice - nat.coal.price * (1 + coalTax)) < 1e-9,
      `单元：煤有效价 = 市价×(1+15%)（${nat.coal.effPrice.toFixed(3)} vs ${(nat.coal.price * 1.15).toFixed(3)}）`);
    check(nat.iron.costPush > 0, `单元：铁锭成本传导 > 0（煤炭税 → 炼铁成本 ${nat.iron.costPush.toFixed(4)}）`);
    check(nat.steel.costPush > nat.iron.costPush, `单元：钢材传导放大（钢 ${nat.steel.costPush.toFixed(4)} > 铁 ${nat.iron.costPush.toFixed(4)}）`);
    check(nat.tools.costPush > 0, `单元：工具传导 > 0（钢 → 工具 ${nat.tools.costPush.toFixed(4)}）`);
    check(Math.abs(snap.commodityTax - coalTax * (10 + 0 + 2)) < 1e-9,
      `单元：商品税收入 = 税率×成交量（${snap.commodityTax.toFixed(3)} = ${coalTax}×12）`);
    console.log(`  单元：煤有效价 ${nat.coal.effPrice.toFixed(3)} · 铁传导 +${nat.iron.costPush.toFixed(4)} · 钢传导 +${nat.steel.costPush.toFixed(4)} · 工具传导 +${nat.tools.costPush.toFixed(4)} · 商品税收入 ${snap.commodityTax.toFixed(2)}/月`);
  }

  // ---- 集成级：对照组 vs 煤炭税 15% ----
  const ctrl = simulate(42, 'lorraine', 2, { quiet: true, coalTax: 0, forceChain: true });
  const test = simulate(42, 'lorraine', 2, { quiet: true, coalTax, forceChain: true });
  const cm = ctrl.state.nations.lorraine.market;
  const tm = test.state.nations.lorraine.market;
  const tN = test.state.nations.lorraine;

  check(Math.abs(tm.coal.effPrice - tm.coal.price * (1 + coalTax)) < 1e-6,
    `集成：煤有效价 = 市价×1.15（${tm.coal.effPrice.toFixed(3)} vs ${(tm.coal.price * 1.15).toFixed(3)}）`);
  check(tm.coal.effPrice > cm.coal.effPrice, `集成：煤有效价高于对照组（${tm.coal.effPrice.toFixed(3)} > ${cm.coal.effPrice.toFixed(3)}）`);
  check(tm.iron.costPush > cm.iron.costPush, `集成：铁锭传导高于对照组（${tm.iron.costPush.toFixed(4)} > ${cm.iron.costPush.toFixed(4)}）`);
  check(tm.steel.costPush > cm.steel.costPush, `集成：钢材传导高于对照组（${tm.steel.costPush.toFixed(4)} > ${cm.steel.costPush.toFixed(4)}）`);
  check(tm.steel.price >= cm.steel.price - 1e-9, `集成：钢材价随成本上升（${tm.steel.price.toFixed(2)} ≥ ${cm.steel.price.toFixed(2)}）`);
  check(tm.tools.price >= cm.tools.price - 1e-9, `集成：工具价随成本上升（${tm.tools.price.toFixed(2)} ≥ ${cm.tools.price.toFixed(2)}）`);
  check(tN.monthly.goodsTax > 0, `集成：商品税收入 > 0（${tN.monthly.goodsTax.toFixed(2)} 万₭/月）`);
  // 炼铁厂输入成本（按税后价）：第 15 月记录
  if (ctrl.ironCostAt15 !== null && test.ironCostAt15 !== null) {
    check(test.ironCostAt15 > ctrl.ironCostAt15,
      `集成：炼铁厂输入成本↑（煤税后价：${test.ironCostAt15.toFixed(3)} > 对照 ${ctrl.ironCostAt15.toFixed(3)}）`);
  } else {
    check(false, '集成：第 15 月炼铁厂在产记录缺失');
  }
  console.log(`  集成：煤 市价 ${tm.coal.price.toFixed(2)} → 有效价 ${tm.coal.effPrice.toFixed(2)}（对照 ${cm.coal.effPrice.toFixed(2)}）`);
  console.log(`       铁锭 市价 ${tm.iron.price.toFixed(2)}（对照 ${cm.iron.price.toFixed(2)}）· 传导 +${tm.iron.costPush.toFixed(4)}（对照 +${cm.iron.costPush.toFixed(4)}）`);
  console.log(`       钢材 市价 ${tm.steel.price.toFixed(2)}（对照 ${cm.steel.price.toFixed(2)}）· 传导 +${tm.steel.costPush.toFixed(4)}（对照 +${cm.steel.costPush.toFixed(4)}）`);
  console.log(`       工具 市价 ${tm.tools.price.toFixed(2)}（对照 ${cm.tools.price.toFixed(2)}）· 商品税收入 ${tN.monthly.goodsTax.toFixed(2)} 万₭/月`);
}

function main(): void {
  const map = loadMap();
  console.log('== 地图导入统计（v0.5 国界重绘 + 海峡判定）==');
  console.log(JSON.stringify(mapStats(map), null, 2));

  console.log('\n== v0.5 初始人口按住房容量缩放（8 国）==');
  const fresh = newGameState('lorraine', 42, map);
  const scaled = scaledNationPops(map);
  for (const def of NATION_LIST) {
    const cap = nationHousingCap(map, def.id);
    const pop = scaled[def.id];
    check(pop <= cap * 1.1 + 1e-6, `初始人口 ≤ 容量×1.1（${def.name} ${pop.toFixed(1)} 万 ≤ ${(cap * 1.1).toFixed(1)} 万）`);
    check(fresh.nations[def.id].popWan <= cap * 1.1 + 1e-6, `开局状态人口 ≤ 容量×1.1（${def.name} ${fresh.nations[def.id].popWan.toFixed(1)}）`);
    console.log(`  ${def.name}: 初始 ${pop.toFixed(0)} 万 / 容量 ${cap.toFixed(0)} 万（${(pop / cap * 100).toFixed(0)}% · 世界观 ${def.popWan} 万）`);
  }

  console.log('\n== v0.5 省份-归属表（id/质心/格数/沿海/海峡/属国）==');
  for (const r of provinceOwnerTable(map)) {
    console.log(`  #${r.id + 1}(${r.id}) (${r.x},${r.y}) ${r.cells}格 沿海${r.coastal ? 'Y' : 'N'} 海峡${r.strait ? 'Y' : 'N'} → ${r.owner}`);
  }

  console.log('\n== 各国辖区与要道（海峡省份）==');
  for (const def of NATION_LIST) {
    const provs = map.provinces.filter((p) => p.owner === def.id && !p.isUndiscovered);
    const cells = provs.reduce((s, p) => s + p.cellIds.length, 0);
    const counties = provs.reduce((s, p) => s + p.counties.length, 0);
    const straits = provs.filter((p) => p.isStrait).map((p) => `#${p.id + 1}`).join(',');
    console.log(`  ${def.name}: ${provs.length} 行省 / ${counties} 县 / ${cells} 格 · 海峡要道[${straits || '—'}]`);
  }
  console.log(`  （未探明新大陆: ${map.provinces.filter((p) => p.isUndiscovered).length} 行省）`);
  console.log(`  （v0.5：国界重绘/地形底图/经纬线/人口缩放/迁移软化；事件系统仍休眠）`);

  console.log('\n== 50 年沙盒（洛林，seed 42）==');
  const runA = simulate(42, 'lorraine', 50);
  const stateA = runA.state;
  const nA = stateA.nations.lorraine;
  const mixA = nationClassMixOf(map, stateA, 'lorraine');
  console.log(`  终局：${stateA.day} 日（新历 ${1023 + Math.floor(stateA.day / DAYS_PER_YEAR)} 年）`);
  console.log(`  国库 ${nA.treasury.toFixed(0)} 万₭ · 粮食 ${nA.foodStock.toFixed(0)} 万吨 · 稳定度 ${nA.stability.toFixed(1)} · 人口 ${nA.popWan.toFixed(0)} 万`);
  console.log(`  识字率 ${(nA.literacy * 100).toFixed(1)}% · 健康 ${(nA.health * 100).toFixed(1)}% · 基建 路${nA.infra.roads.toFixed(0)}/港${nA.infra.ports.toFixed(0)}`);
  console.log(`  月收入 ${nA.monthly.income.toFixed(0)}（人头 ${nA.monthly.pollTax.toFixed(1)} · 土地 ${nA.monthly.landTax.toFixed(1)} · 消费 ${nA.monthly.consumptionTax.toFixed(1)} · 关税 ${nA.monthly.tariff.toFixed(1)} · 特别 ${nA.monthly.otherTax.toFixed(1)} · 商品税 ${nA.monthly.goodsTax.toFixed(1)}）`);
  console.log(`  支出 ${nA.monthly.spending.toFixed(0)} · 贸易收支 ${nA.monthly.tradeBalance.toFixed(1)} · 人口增长率 ${(nA.monthly.growthRate * 100).toFixed(2)}%/年`);
  console.log(`  动乱 ${nA.unrest.toFixed(2)} · 政策 废奴${nA.policies.abolishedSerfdom ? '✓' : '—'} 累进${nA.policies.progressiveTax ? '✓' : '—'} 普选${nA.policies.universalSuffrage ? '✓' : '—'}`);
  console.log(`  阶级：${CLASSES.map((c) => `${CLASS_LABEL[c]} ${mixA[c].toFixed(0)}万`).join(' · ')}`);
  const activeA = nA.projects.filter((p) => p.status === 'active').length;
  const buildingA = nA.projects.filter((p) => p.status === 'building').length;
  console.log(`  建筑：累计投入 ${runA.costAcc.cost.toFixed(0)} / 退款 ${runA.costAcc.refund.toFixed(0)} · 在产 ${activeA} / 在建 ${buildingA}`);
  console.log(`  大事记 ${stateA.chronicle.length} 条`);

  console.log('\n== 市场终局样例（洛林 · 17 商品：市价 → 有效价）==');
  for (const g of GOODS) {
    const m = nA.market[g];
    const arrow = m.effPrice > m.price ? ` → ${m.effPrice.toFixed(2)}` : '';
    console.log(`  ${GOOD_LABEL[g]}: 国价 ${m.price.toFixed(2)}${arrow} (供需 ${m.demand.toFixed(1)}/${m.supply.toFixed(1)}) · 产 ${m.supply.toFixed(1)} 消 ${m.consumed.toFixed(1)} 出 ${m.exported.toFixed(1)} 进 ${m.imported.toFixed(1)} 库 ${nA.stocks[g].toFixed(1)}`);
  }

  console.log('\n== 确定性：同种子两次结果一致 ==');
  const runB = simulate(42, 'lorraine', 50);
  const sa = snapshotOf(stateA);
  const sb = snapshotOf(runB.state);
  const deterministic = sa === sb;
  check(deterministic, '同种子（42）两次 50 年运行快照完全一致（含税率/建筑/阶级/政策/三级市场/大事记）');
  if (!deterministic) {
    console.error('  快照A:', sa);
    console.error('  快照B:', sb);
  } else {
    console.log('  快照一致 ✓');
  }

  console.log('\n== 存档往返 ==');
  assertSaveRoundtrip(stateA);
  console.log('  存档 JSON 序列化/反序列化往返一致 ✓');

  console.log('\n== 时钟不回归（日/月推进正确）==');
  check(stateA.day === 50 * DAYS_PER_YEAR, `50 年 = ${50 * DAYS_PER_YEAR} 日（实际 ${stateA.day}）`);
  check(stateA.day % DAYS_PER_MONTH === 0, '结束于月末（结算完成）');

  console.log('\n== 8 国冒烟测试（各 10 年，seed 7 · 随机税制策略）==');
  for (const def of NATION_LIST) {
    const s = simulate(7, def.id, 10);
    const n = s.state.nations[def.id];
    const active = n.projects.filter((p) => p.status === 'active').length;
    console.log(`  ${def.name}: 完成 10 年 ✓ 国库 ${n.treasury.toFixed(0)} · 稳定度 ${n.stability.toFixed(1)} · 人口 ${n.popWan.toFixed(0)} 万 · 识字 ${(n.literacy * 100).toFixed(0)}% · 建筑 ${active} 在产`);
  }

  console.log('\n== 帝国 10 年冒烟：废农奴制（seed 7，第 3 月执行）==');
  const emp = simulate(7, 'empire', 10, { abolishAtMonth: 3 });
  const nE = emp.state.nations.empire;
  const mixE = nationClassMixOf(map, emp.state, 'empire');
  check(nationSlavePop(map, emp.state, 'empire') <= 1e-6, `帝国终局奴隶 = 0（当前 ${nationSlavePop(map, emp.state, 'empire').toFixed(3)}）`);
  check(emp.state.nations.empire.policies.abolishedSerfdom, '帝国政策已标记废农奴制');
  check(mixE[6] + mixE[5] > 0, `废奴后佃农/自耕农在册（佃农 ${mixE[6].toFixed(0)} 万 / 自耕农 ${mixE[5].toFixed(0)} 万）`);
  check(emp.state.chronicle.some((e) => e.title === '废农奴制'), '大事记记录废农奴制');
  console.log(`  帝国终局：奴隶 ${nationSlavePop(map, emp.state, 'empire').toFixed(1)} 万 · 佃农 ${mixE[6].toFixed(0)} 万 · 自耕农 ${mixE[5].toFixed(0)} 万 · 稳定度 ${nE.stability.toFixed(1)}`);

  console.log('\n== 商品税传导实证（煤炭税 15% → 煤有效价↑ / 炼铁成本↑ / 钢材价↑）==');
  commodityTaxTransmissionTest();

  console.log(`\n== 断言汇总 ==`);
  console.log(`  通过 ${checks - failures} / ${checks}${failures === 0 ? ' — 全部通过 ✅' : ` — ${failures} 项失败 ❌`}`);
  if (failures > 0) {
    throw new Error(`模拟断言失败：${failures} 项未通过（${checks - failures}/${checks} 通过）`);
  }
}

main();
