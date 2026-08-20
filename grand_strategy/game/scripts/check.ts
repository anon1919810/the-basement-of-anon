// 经济体检：3 年洛林沙盒，检查关键系统健康度（职业/阶级分布、生活水平分化、消费矩阵、资本池、建造力、收支、政治）
import { loadMap } from '../src/game/map';
import { newGameState, tickDay, GOV_LABEL } from '../src/game/state';
import { GOODS_LIST } from '../src/game/market';
import { JOB_LABEL, zeroJobMix } from '../src/game/pops';
import { CLASS_DEFS } from '../src/game/classes';
import { startInvestment } from '../src/game/buildings';
import { provinceHasResource } from '../src/game/resources';
import { LAW_TIERS } from '../src/game/politics';
import { actualRateOf, creditLimitOf } from '../src/game/finance';
import type { Province } from '../src/game/map';
import type { BuildingKind } from '../src/game/buildings';

const DAYS_PER_YEAR = 360, YEARS = 3;
let issues = 0;
const issue = (msg: string) => { console.log('⚠ ' + msg); issues++; };
const ok = (msg: string) => console.log('✓ ' + msg);

function main(): void {
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

  console.log('=== 经济体检（洛林 3 年）===\n');
  // 1. 国库 / 资本池 / 建造力
  console.log(`国库 ${n.treasury.toFixed(0)} · 资本池 ${n.capitalWealth.toFixed(1)} · 建造力 ${n.buildPower.toFixed(0)} · 运力价 ${n.market.transport.price.toFixed(2)}`);
  if (n.treasury < -500) issue(`国库过度赤字 ${n.treasury.toFixed(0)}（玩家需调税）`);
  else ok('国库可玩（> -500）');
  if (n.capitalWealth > 60) ok(`投资池增长 ${(n.capitalWealth - 60).toFixed(1)}`); else issue('投资池未增长（私营不赚钱）');

  // 2. 职业分布（12 职业占比）——仅玩家国家省（他国省为静态背景，不结算）
  const nationProvIds = map.provinces
    .filter((p) => p.owner === 'lorraine' && !p.isUndiscovered)
    .map((p) => p.id);
  const jobMix = zeroJobMix();
  for (const pid of nationProvIds) {
    const ps = state.provinces[pid];
    if (ps?.pops) for (const p of ps.pops) jobMix[p.job] += p.size;
  }
  const total = Object.values(jobMix).reduce((a, b) => a + b, 0) || 1;
  const jobStr = Object.entries(jobMix).map(([j, s]) => `${JOB_LABEL[j as never]}:${(s / total * 100).toFixed(0)}%`).join(' ');
  console.log(`\n职业分布：${jobStr}`);
  if (jobMix.peasant / total < 0.3) issue('自耕农占比过低'); else ok('自耕农为主体');
  if (jobMix.soldier / total > 0.15) issue('军人占比过高'); else ok('军人占比合理');
  if (jobMix.capitalist / total > 0.1) issue('资本家过多'); else ok('资本侧占比合理');

  // 3. 阶级分布（金字塔）
  const classMix: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const pid of nationProvIds) {
    const ps = state.provinces[pid];
    if (ps?.pops) for (const p of ps.pops) classMix[p.class] += p.size;
  }
  const classStr = [1, 2, 3, 4, 5, 6, 7].map((c) => `${(CLASS_DEFS as Record<number, { label: string }>)[c].label}:${(classMix[c] / total * 100).toFixed(0)}%`).join(' ');
  console.log(`\n阶级分布：${classStr}`);

  // 4. 生活水平按阶级分化（贵族 vs 奴役）
  let stdByClass: Record<number, { sum: number; w: number }> = {};
  for (let c = 1; c <= 7; c++) stdByClass[c] = { sum: 0, w: 0 };
  for (const pid of nationProvIds) {
    const ps = state.provinces[pid];
    if (ps?.pops) for (const p of ps.pops) { stdByClass[p.class].sum += p.livingStd * p.size; stdByClass[p.class].w += p.size; }
  }
  const avgOf = (c: number) => (stdByClass[c].w > 0 ? stdByClass[c].sum / stdByClass[c].w : 0);
  console.log(`\n生活水平按阶级：贵族 ${avgOf(1).toFixed(0)} · 温饱 ${avgOf(4).toFixed(0)} · 奴役 ${avgOf(7).toFixed(0)}`);
  if (avgOf(1) <= avgOf(7)) issue('贵族生活水平不高于奴役（分化失效）');
  else ok('阶级生活水平分化正常');
  if (avgOf(1) - avgOf(7) < 10) issue('分化幅度过小（<10）');

  // 5. 政治系统（v0.10：合法性/行政效率/法律状态）
  console.log(`\n政治：政体 ${GOV_LABEL[n.policies.gov] ?? n.policies.gov} · 选举 ${LAW_TIERS.suffrage[n.policies.suffrage]?.label} · 人身 ${LAW_TIERS.liberty[n.policies.liberty]?.label} · 合法性 ${n.legitimacy.toFixed(0)} · 行政效率 ${((n.adminEff ?? 1) * 100).toFixed(0)}%`);
  console.log(`民生：教育 ${LAW_TIERS.education[n.policies.education]?.label} · 医疗 ${LAW_TIERS.health[n.policies.health]?.label} · 国防 ${LAW_TIERS.military[n.policies.military]?.label} · 治安 ${LAW_TIERS.policing[n.policies.policing]?.label} · 言论 ${LAW_TIERS.press[n.policies.press]?.label}`);
  if (n.legitimacy < 20) issue(`合法性过低 ${n.legitimacy.toFixed(0)}（执政联盟失势）`);
  else ok('合法性正常');
  if ((n.adminEff ?? 1) < 0.5) issue(`行政效率过低 ${((n.adminEff ?? 1) * 100).toFixed(0)}%（行政支出不足）`);
  else ok('行政效率正常');
  if (n.policies.liberty === 0 && n.slavePop > 1) {
    // 农奴制 + 有奴隶：正常组合；若 liberty=2 但仍有奴隶则异常
  }
  if (n.policies.liberty === 2 && n.slavePop > 0.01) issue('废奴法律已立但仍有奴隶（转化异常）');
  else if (n.policies.liberty === 0 || n.policies.liberty === 1) ok('人身自由法律与奴隶人口一致');

  // 6. 金融系统（v0.11：货币/债务/通胀健康度）
  const rate = actualRateOf(n);
  const limit = creditLimitOf(n);
  const f = (x: number) => Math.round(x).toLocaleString('zh-CN');
  console.log(`\n金融：货币供给 ${f(n.moneySupply)} · 国债 ${f(n.debtTotal)}（上限 ${f(limit)}）· 利率 ${rate.toFixed(1)}% · 通胀 ${((n.inflation ?? 0) * 100).toFixed(1)}% · 资本池 ${f(n.capitalWealth)}`);
  if (n.debtTotal > limit * 0.9) issue(`国债接近上限 ${(n.debtTotal / Math.max(1, limit) * 100).toFixed(0)}%（债务风险）`);
  else ok('债务水平安全');
  if ((n.inflation ?? 0) > 0.15) issue(`通胀过高 ${((n.inflation ?? 0) * 100).toFixed(1)}%（货币超发）`);
  else ok('通胀温和');
  if (n.finCrisisMonths > 0) issue(`金融危机中（资本池透支，投资冻结 ${n.finCrisisMonths} 月）`);
  else ok('金融稳定');

  console.log('\n=== 体检完成 ===');
  console.log(issues === 0 ? '✅ 全部健康' : `⚠ ${issues} 项需关注`);
}

main();
