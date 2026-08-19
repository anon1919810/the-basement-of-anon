import { loadMap } from './src/game/map';
import { newGameState, tickDay } from './src/game/state';
import { GOODS_LIST } from './src/game/market';
import { startInvestment } from './src/game/buildings';
import { provinceHasResource } from './src/game/resources';
import type { Province } from './src/game/map';
import type { BuildingKind } from './src/game/buildings';
import { CLASS_STD_SHIFT, CLASS_WAGE_MULT } from './src/game/economy';

const DAYS_PER_YEAR = 360, YEARS = 3;
const map = loadMap();
const state = newGameState('lorraine', 42, map);
const n = state.nations.lorraine;
n.openTrade = true;
n.tax.rates.poll = 0.2;
n.tax.rates.consumption = 0.1;
for (const g of GOODS_LIST) n.tax.goods[g] = 0.15;
n.buildPower = 500;
const findProv = (pred: (p: Province) => boolean): Province | null =>
  map.provinces.find((p) => p.owner === 'lorraine' && !p.isUndiscovered && pred(p)) ?? null;
const build = (kind: BuildingKind, pred: (p: Province) => boolean): void => {
  const prov = findProv(pred);
  if (prov) startInvestment(state, map, kind, prov.id);
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
for (let d = 0; d < YEARS * DAYS_PER_YEAR; d++) tickDay(state, map);

console.log(`n.avgIncome=${n.avgIncome?.toFixed?.(3) ?? 'n/a'}`);
const clsNames: Record<number, string> = { 1: '贵族', 2: '富裕', 3: '中产', 4: '温饱', 5: '贫困', 6: '赤贫', 7: '奴役' };
const byCls: Record<number, { pop: number; stdSum: number; wageSum: number; satSum: number; ratioSum: number; expSum: number }> = {};
for (let c = 1; c <= 7; c++) byCls[c] = { pop: 0, stdSum: 0, wageSum: 0, satSum: 0, ratioSum: 0, expSum: 0 };
for (const pid of Object.keys(state.provinces)) {
  const ps = state.provinces[Number(pid)];
  if (ps?.pops) for (const p of ps.pops) {
    const c = byCls[p.class];
    c.pop += p.size;
    c.stdSum += p.livingStd * p.size;
    c.wageSum += p.wage * p.size;
    c.expSum += p.expected * p.size;
  }
}
for (let c = 1; c <= 7; c++) {
  const b = byCls[c];
  if (b.pop === 0) { console.log(`${clsNames[c]}: 无人口`); continue; }
  console.log(`${clsNames[c]}: pop=${(b.pop/10000).toFixed(1)}万 livingStd=${(b.stdSum/b.pop).toFixed(1)} wage=${(b.wageSum/b.pop).toFixed(2)} expected=${(b.expSum/b.pop).toFixed(1)} shift=${CLASS_STD_SHIFT[c]} mult=${CLASS_WAGE_MULT[c]}`);
}
// 打一个具体贵族 POP 的公式分量
console.log('\n--- 具体 POP 详情（前 8）---');
let shown = 0;
for (const pid of Object.keys(state.provinces)) {
  const ps = state.provinces[Number(pid)];
  if (ps?.pops) for (const p of ps.pops) {
    if (shown >= 8) break;
    const ratio = p.wage / (n.avgIncome || 1);
    console.log(`job=${p.job} class=${clsNames[p.class]} size=${(p.size/10000).toFixed(1)}万 std=${p.livingStd.toFixed(1)} wage=${p.wage.toFixed(2)} ratio=${ratio.toFixed(2)} expected=${p.expected.toFixed(1)} unrest=${p.unrest.toFixed(2)}`);
    shown++;
  }
  if (shown >= 8) break;
}
