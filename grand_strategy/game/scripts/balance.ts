// 平衡实测：3 年洛林沙盒，逐月记录价格/缺口/建筑盈利/资本池/运力，输出平衡警告
// 用途：定位失衡点（价格爆表/缺口持续/亏损建筑/运力短缺）→ 调参
import { loadMap } from '../src/game/map';
import { newGameState, tickDay } from '../src/game/state';
import { GOODS_LIST, BASE_PRICE } from '../src/game/market';
import { GOOD_LABEL } from '../src/game/pops';
import { BUILDING_DEFS, BUILDING_KINDS, buildingUnlock, startInvestment } from '../src/game/buildings';
import { provinceHasResource } from '../src/game/resources';
import type { GameState } from '../src/game/state';
import type { Province } from '../src/game/map';
import type { BuildingKind } from '../src/game/buildings';

const DAYS_PER_YEAR = 360;
const DAYS_PER_MONTH = 30;
const YEARS = 3;

interface MonthRec {
  day: number;
  price: Record<string, number>;
  unmet: Record<string, number>;
  transpPrice: number;
  transpStock: number;
  capitalWealth: number;
  treasury: number;
  profitPos: number;
  profitNeg: number;
  loss: number;
  avgStd: number;      // 平均生活水平（全省 POP 加权）
  unrestful: number;   // 不满 ≥20 的 POP 数（改行前兆）
}

function provAvgPrice(state: GameState, g: string): number {
  let s = 0, w = 0;
  for (const pid of Object.keys(state.nations[state.playerNation].provinceMarkets)) {
    const pm = (state.nations[state.playerNation].provinceMarkets[Number(pid)] as Record<string, { price: number; supply: number }>)[g];
    if (pm) { s += pm.price * pm.supply; w += pm.supply; }
  }
  return w > 0 ? s / w : BASE_PRICE[g as never];
}

// 温和策略：运力价高优先建基建（破死循环）；否则补"产出<需求"的商品建筑（私营自动进行）
function investBalanced(state: GameState, map: ReturnType<typeof loadMap>): void {
  const n = state.nations[state.playerNation];
  // 运力价 > 2.2×base → 先修基建（road 便宜/port 沿海）
  if (n.market.transport.price > 2.2 * BASE_PRICE.transport) {
    for (const kind of ['road', 'port', 'lighthouse'] as const) {
      for (const p of map.provinces) {
        if (p.owner !== 'lorraine' || p.isUndiscovered) continue;
        const unlock = buildingUnlock(map, kind, p, n.infra, { stocks: n.stocks, projects: n.projects, literacy: n.literacy });
        if (!unlock.ok) continue;
        startInvestment(state, map, kind, p.id);
        return;
      }
    }
  }
  // 找缺口商品
  let best: { g: string; gap: number } | null = null;
  for (const g of GOODS_LIST) {
    const m = n.market[g];
    const gap = m.demand - m.supply;
    if (gap > 0.3 && (!best || gap > best.gap)) best = { g, gap };
  }
  if (!best) return;
  // 找生产该商品的可建建筑（未达上限）
  for (const kind of BUILDING_KINDS) {
    const def = BUILDING_DEFS[kind];
    if (def.output !== (best.g as never) && !(def.variants ?? []).some((v) => v.output === (best.g as never))) continue;
    for (const p of map.provinces) {
      if (p.owner !== 'lorraine' || p.isUndiscovered) continue;
      const unlock = buildingUnlock(map, kind, p, n.infra, { stocks: n.stocks, projects: n.projects, literacy: n.literacy });
      if (!unlock.ok) continue;
      startInvestment(state, map, kind, p.id);
      return;
    }
  }
}

function record(state: GameState): MonthRec {
  const n = state.nations[state.playerNation];
  const price: Record<string, number> = {};
  const unmet: Record<string, number> = {};
  for (const g of GOODS_LIST) {
    price[g] = provAvgPrice(state, g);
    unmet[g] = n.market[g].unmet;
  }
  let profitPos = 0, profitNeg = 0, loss = 0;
  for (const p of n.projects) {
    if (p.status !== 'active') continue;
    const def = BUILDING_DEFS[p.kind];
    const ret = p.lastRevenue - p.lastInputCost - def.opCost;
    if (ret >= 0) profitPos++; else { profitNeg++; if (ret < -def.opCost) loss++; }
  }
  // 生活水平统计
  let stdSum = 0, stdW = 0, unrestful = 0;
  for (const pid of Object.keys(state.provinces)) {
    const ps = state.provinces[Number(pid)];
    if (!ps || !ps.pops) continue;
    for (const pop of ps.pops) {
      stdSum += pop.livingStd * pop.size;
      stdW += pop.size;
      if (pop.unrest >= 20) unrestful++;
    }
  }
  return {
    day: state.day,
    price,
    unmet,
    transpPrice: n.market.transport.price,
    transpStock: n.stocks.transport,
    capitalWealth: n.capitalWealth,
    treasury: n.treasury,
    profitPos,
    profitNeg,
    loss,
    avgStd: stdW > 0 ? stdSum / stdW : 0,
    unrestful,
  };
}

function main(): void {
  const map = loadMap();
  const state = newGameState('lorraine', 42, map);
  const n = state.nations.lorraine;
  n.openTrade = true;
  n.tax.rates.poll = 0.2;
  n.tax.rates.consumption = 0.1;
  for (const g of GOODS_LIST) n.tax.goods[g] = 0.15;

  // 开局预置基础产业链（模拟已发展国家，测价格传导与循环）
  const findProv = (pred: (p: Province) => boolean): Province | null =>
    map.provinces.find((p) => p.owner === 'lorraine' && !p.isUndiscovered && pred(p)) ?? null;
  const build = (kind: BuildingKind, pred: (p: Province) => boolean): void => {
    const prov = findProv(pred);
    if (prov) {
      const r = startInvestment(state, map, kind, prov.id);
      if (!r) console.log(`⚠ 预建 ${kind} 失败（解锁/资金）`);
    } else console.log(`⚠ 无合适省份建 ${kind}`);
  };
  build('ryeFarm', (p) => provinceHasResource(p, 'farmland'));
  build('ryeFarm', (p) => provinceHasResource(p, 'farmland'));
  build('coalMine', (p) => provinceHasResource(p, 'coal'));
  build('ironMine', (p) => provinceHasResource(p, 'iron'));
  build('ironWorks', (p) => provinceHasResource(p, 'coal'));
  build('steelWorks', (p) => provinceHasResource(p, 'coal'));
  build('cottonFarm', (p) => provinceHasResource(p, 'cotton'));
  build('textile', (p) => provinceHasResource(p, 'cotton'));
  build('clothingWorks', (p) => provinceHasResource(p, 'cotton') || provinceHasResource(p, 'farmland'));
  build('road', (p) => provinceHasResource(p, 'stone'));
  build('port', () => true);
  build('fishFarm', () => true);
  build('mill', (p) => provinceHasResource(p, 'farmland'));

  const recs: MonthRec[] = [];
  for (let d = 0; d < YEARS * DAYS_PER_YEAR; d++) {
    const mod = state.day % DAYS_PER_MONTH;
    if (mod === 1) investBalanced(state, map);
    tickDay(state, map);
    if (mod === DAYS_PER_MONTH - 1) recs.push(record(state));
  }

  // ---- 输出：关键商品价格轨迹 ----
  const watch = ['food', 'wheat', 'coal', 'iron', 'steel', 'tools', 'luxury', 'transport'];
  console.log('=== 关键商品省均价轨迹（月）===');
  console.log('月 | ' + watch.map((g) => String(GOOD_LABEL[g as never] ?? g).padEnd(4)).join(' '));
  for (let i = 0; i < recs.length; i += 6) {
    const r = recs[i];
    const cells = watch.map((g) => {
      const v = r.price[g];
      const base = BASE_PRICE[g as never];
      const flag = v >= base * 2.3 ? '▲' : v <= base * 0.5 ? '▼' : ' ';
      return `${v.toFixed(1)}${flag}`;
    });
    console.log(`${String(Math.floor(r.day / 30)).padStart(3)} | ${cells.join(' ')}`);
  }

  // ---- 输出：月末指标 ----
  const last = recs[recs.length - 1];
  console.log(`\n=== 终局（${last.day} 日）===\n国库 ${last.treasury.toFixed(0)} · 资本池 ${last.capitalWealth.toFixed(0)} · 运力价 ${last.transpPrice.toFixed(2)}（base 1.6）· 运力库存 ${last.transpStock.toFixed(1)}`);
  console.log(`建筑：盈利 ${last.profitPos} / 亏损 ${last.profitNeg}（严重 ${last.loss}）`);
  console.log(`生活水平：均值 ${last.avgStd.toFixed(1)} · 不满 POP ${last.unrestful} 个`);

  // ---- 平衡警告 ----
  console.log('\n=== 平衡警告 ===');
  let warns = 0;
  for (const g of GOODS_LIST) {
    const base = BASE_PRICE[g];
    const endP = last.price[g];
    const maxP = Math.max(...recs.map((r) => r.price[g]));
    const endUnmet = last.unmet[g];
    if (endP >= base * 2.3) { console.log(`▲ ${GOOD_LABEL[g]} 价格爆表 ${endP.toFixed(1)}（base ${base}，峰值 ${maxP.toFixed(1)}）`); warns++; }
    if (endUnmet > 1) { console.log(`⚠ ${GOOD_LABEL[g]} 月缺口 ${endUnmet.toFixed(1)}`); warns++; }
  }
  if (last.transpPrice >= 1.6 * 2.3) { console.log(`▲ 运力价格爆表 ${last.transpPrice.toFixed(1)}（运力不足）`); warns++; }
  if (last.profitNeg > last.profitPos) { console.log(`⚠ 亏损建筑多于盈利建筑（${last.profitNeg}/${last.profitPos + last.profitNeg}）`); warns++; }
  const capGrowth = last.capitalWealth - 60;
  if (capGrowth < 0) { console.log(`⚠ 资本池缩水（+${capGrowth.toFixed(0)}）——私营不赚钱`); warns++; }
  if (warns === 0) console.log('✅ 无明显失衡');

  // ---- 末月国库收支明细 ----
  console.log('\n=== 末月国库收支 ===');
  console.log(JSON.stringify({
    income: n.monthly.income, spending: n.monthly.spending,
    poll: n.monthly.pollTax, land: n.monthly.landTax, cons: n.monthly.consumptionTax,
    tariff: n.monthly.tariff, goods: n.monthly.goodsTax,
    investReturn: n.monthly.investReturn, investCost: n.monthly.investCost,
    investIncome: n.monthly.investIncome,
  }));
}

main();
