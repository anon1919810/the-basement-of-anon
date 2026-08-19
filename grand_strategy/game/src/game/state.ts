/**
 * 游戏状态机（v0.3）：新游戏 / 日 tick / 月度结算（经济全循环：三级市场 + 产业链 + 阶级系统 + 政策）。
 * 纯逻辑、无 DOM 依赖，浏览器 UI 与无头模拟（scripts/sim.ts）共用。
 * 确定性：月度结算完全无随机（纯函数式演化）；
 * 仅玩家操作（sim 中的随机策略 / UI 的政令）经 game.rngState 恢复的 Rng（mulberry32）。
 */
import { Rng } from './rng';
import type { GameMap } from './map';
import type { GoodId, NationId, ProvinceOwner, Speed } from './types';
import { DAYS_PER_MONTH, monthIndex, yearOf } from './clock';
import { NATIONS } from './nations';
import { isCoastal } from './logistics';
import { BASE_HOUSING_PER_CELL } from './pops';
import {
  BANKRUPTCY_COOLDOWN,
  BANKRUPTCY_THRESHOLD,
  nationAvgHappiness,
  nationClassMixOf,
  settleEconomyMonth,
  zeroLedger,
} from './economy';
import type { MonthlyLedger } from './economy';
import { initProvinceEcon } from './pops';
import type { Pop } from './pops';
import { GOODS_LIST, newMarket, zeroGoods } from './market';
import type { CountyMarket, MarketGood, ProvinceMarket } from './market';
import type { InvestmentProject } from './buildings';
import { MANUAL_EVENTS } from './manualEvents';
import { CLASSES } from './classes';
// 注意：tax 必须在 economy/pops 之后导入（tax → market，避免 market 半初始化时 pops 读取 GOODS_LIST）
import { defaultNationTax } from './tax';
import type { NationTax } from './tax';

export const SAVE_VERSION = 9;
export const SAVE_KEY = 'kalt-save-v9';
/** 旧存档键（v0.8 起存档不兼容，提示用；含 v0.7 的 v8 键） */
export const OLD_SAVE_KEYS = ['kalt-save-v8', 'kalt-save-v7', 'kalt-save-v6', 'kalt-save-v5', 'kalt-save-v4', 'kalt-save-v3'];

/** 国家政策（v0.3）：作用于当前国，写入状态与存档 */
export interface NationPolicies {
  /** 废农奴制：一次性转型（奴隶→佃农/自耕农），短期稳定度↓ + 人口效率长期↑ */
  abolishedSerfdom: boolean;
  /** 累进税：上层税负↑下层↓，可开关 */
  progressiveTax: boolean;
  /** 普选：下阶层政治权重↑上阶层↓，稳定度混合影响 */
  universalSuffrage: boolean;
}

export function defaultPolicies(): NationPolicies {
  return { abolishedSerfdom: false, progressiveTax: false, universalSuffrage: false };
}

export interface NationState {
  popWan: number; // 人口（万人）
  literacy: number; // 识字率 0-1
  health: number; // 健康水平 0-1（人口质量）
  treasury: number; // 国库（万₭）
  foodStock: number; // 粮食储备（万吨，== stocks.food 镜像）
  stability: number; // 稳定度 0-100
  /** v0.4 立体税制：五税种 + 单一商品税（连续滑块 0%-30%，写入存档） */
  tax: NationTax;
  spending: { military: number; admin: number; infra: number; court: number; health: number }; // 万₭/月
  cells: number; // 所辖陆地格数（静态）
  // ---- 三级市场（v0.2/v0.3：17 商品；v0.8 省为结算单元） ----
  stocks: Record<GoodId, number>; // 国家聚合库存（= Σ 省库存；UI/建筑解锁显示）
  market: Record<GoodId, MarketGood>; // 国家聚合市场视图（省结算后派生，非结算实体）
  provinceMarkets: Record<number, Record<GoodId, ProvinceMarket>>; // 省市场（v0.8 结算单元）
  countyMarkets: Record<number, Record<GoodId, CountyMarket>>; // 本地市场（县，展示）
  /** v0.8 省库存（真正结算账本；守恒按省核算） */
  provStocks: Record<number, Record<GoodId, number>>;
  /** v0.8 开放贸易（false=自给不贸易；true=按世界价进出口+关税） */
  openTrade: boolean;
  /** v0.8 出口权：省 id → 是否获权（沿海/港口省默认获权，内陆省可授予/收回） */
  exportRights: Record<number, boolean>;
  /** v0.9 运力政策：'auto'=省运力库存足则自动启用加强项；'off'=全部禁用 */
  transportPolicy: 'auto' | 'off';
  /** v0.9 双轨制：资本财富池（资本家/银行家积累 → 私营自动投资） */
  capitalWealth: number;
  /** v0.9 战时状态：战时开放义务兵役（强制征兵）；平时禁止国家强行转职（靠待遇吸引） */
  warTime: boolean;
  /** 政体（义务兵役率/征兵强度判定） */
  gov: string;
  // ---- 投资（v0.3 产业链建筑） ----
  projects: InvestmentProject[]; // 在建/已投产项目
  nextProjectId: number;
  investCostAcc: number; // 本月投资支出累计（结算时并入账本并清零）
  investRefundAcc: number; // 本月取消退款累计
  infra: { roads: number; ports: number }; // 基建水平 0-100
  emigration: number; // 上月流亡人口（万人）
  monthly: MonthlyLedger; // 上月账本（UI/断言）
  bankruptMonths: number; // 破产冷却（月）
  // ---- 阶级（v0.3） ----
  policies: NationPolicies;
  /** 上月奴隶人口（万人，政策/断言/UI） */
  slavePop: number;
  /** 上月动乱指数（下层不满加权，0 起） */
  unrest: number;
}

export interface ProvinceState {
  owner: ProvinceOwner;
  // ---- v0.1 省经济 ----
  pops: Pop[];
  popTotal: number; // 万人
  housingCap: number; // 万人
  efficiency: number; // 0.5-1.2
  happiness: number; // 0-100
  output: Record<GoodId, number>;
  demand: Record<GoodId, number>;
  freight: number; // 运费系数
}

/** 大事记条目（v0.2：被动信息，非交互事件） */
export interface ChronicleEntry {
  month: number;
  day: number;
  title: string;
  detail?: string;
}

// ---- v0.7 月度历史快照（侧栏图表：仅保留近 HISTORY_MAX 个月） ----

/** 历史保留月数 */
export const HISTORY_MAX = 12;
/** 市场图表主要商品（4-6 种价格走势多线） */
export const HISTORY_GOODS: GoodId[] = ['food', 'coal', 'iron', 'steel', 'tools', 'luxury'];

export interface HistoryMonth {
  /** 0 基月序号（自新历 1023 年 1 月起） */
  month: number;
  /** 年份（新历） */
  year: number;
  /** 国库（万₭） */
  treasury: number;
  /** 上月收入（万₭/月） */
  income: number;
  /** 上月支出（万₭/月） */
  spending: number;
  /** 人口（万人） */
  popWan: number;
  /** 稳定度 0-100 */
  stability: number;
  /** 人口加权平均幸福度 0-100 */
  happiness: number;
  /** 七级阶级分布（万人，[1..7]） */
  classMix: number[];
  /** 主要商品价格（HISTORY_GOODS） */
  prices: Record<string, number>;
  /** 六税种实收（万₭/月） */
  tax: { poll: number; land: number; consumption: number; tariff: number; other: number; goods: number };
}

export interface GameState {
  version: number;
  seed: number;
  day: number;
  speed: Speed;
  prevSpeed: Speed;
  playerNation: NationId;
  rngState: number;
  nations: Record<NationId, NationState>;
  provinces: Record<number, ProvinceState>;
  chronicle: ChronicleEntry[];
  lastAutosaveMonth: number;
  /** v0.7 月度历史快照（按国；仅当月主国推进；每国保留近 12 月） */
  history: Partial<Record<NationId, HistoryMonth[]>>;
}

/** 月度结算后记录历史快照（确定性：纯函数式数据） */
export function recordHistory(state: GameState, map: GameMap): void {
  const id = state.playerNation;
  const n = state.nations[id];
  const mi = monthIndex(state.day);
  const happy = nationAvgHappiness(map, state, id);
  const mix = nationClassMixOf(map, state, id);
  const prices: Record<string, number> = {};
  for (const g of HISTORY_GOODS) prices[g] = n.market[g].price;
  const rec: HistoryMonth = {
    month: mi,
    year: yearOf(state.day),
    treasury: n.treasury,
    income: n.monthly.income,
    spending: n.monthly.spending,
    popWan: n.popWan,
    stability: n.stability,
    happiness: happy,
    classMix: CLASSES.map((c) => mix[c]),
    prices,
    tax: {
      poll: n.monthly.pollTax,
      land: n.monthly.landTax,
      consumption: n.monthly.consumptionTax,
      tariff: n.monthly.tariff,
      other: n.monthly.otherTax,
      goods: n.monthly.goodsTax,
    },
  };
  const list = state.history[id] ?? [];
  list.push(rec);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  state.history[id] = list;
}

/** 追加一条大事记（破产/工厂落成等被动信息） */
export function addChronicle(state: GameState, title: string, detail?: string): void {
  state.chronicle.push({ month: monthIndex(state.day), day: state.day, title, detail });
  if (state.chronicle.length > 500) state.chronicle.splice(0, state.chronicle.length - 500);
}

function nationCellCount(map: GameMap, id: NationId): number {
  let n = 0;
  for (const p of map.provinces) {
    if (p.owner === id && !p.isUndiscovered) n += p.cellIds.length;
  }
  return n;
}

// ---- v0.5 人口按住房容量缩放（消除首月大崩溃） ----

/** 初始总人口目标 = 全图住房容量 × 0.75（"容量×0.75 左右"） */
export const POP_SCALE_TARGET = 0.75;

/** 国家住房容量（万人）= 所辖陆地格 × 每格容量（与省 housingCap 同口径） */
export function nationHousingCap(map: GameMap, id: NationId): number {
  let cap = 0;
  for (const p of map.provinces) {
    if (p.owner === id && !p.isUndiscovered) cap += p.cellIds.length * BASE_HOUSING_PER_CELL;
  }
  return cap;
}

/**
 * v0.5 初始人口水填法缩放：
 *  - 总目标 = 全图容量 × POP_SCALE_TARGET；
 *  - 先按世界观人口比例缩放，超容量国家封顶到自身容量，释放的配额按比例分给未封顶国家（迭代至稳定）；
 *  - 保留国家间相对比例（容量允许范围内）；阶级构成/识字率/政体本来就是比例与属性，天然保留；
 *  - 消除「伊尼亚斯 1300 万挤 10 格」的首月瞬间流亡。
 */
export function scaledNationPops(map: GameMap): Record<NationId, number> {
  const ids = Object.keys(NATIONS) as NationId[];
  const caps = {} as Record<NationId, number>;
  let totalCap = 0;
  for (const id of ids) {
    caps[id] = nationHousingCap(map, id);
    totalCap += caps[id];
  }
  let target = totalCap * POP_SCALE_TARGET;
  let worldPool = ids.reduce((s, id) => s + NATIONS[id].popWan, 0);
  const pops = {} as Record<NationId, number>;
  const capped = new Set<NationId>();
  let guard = 0;
  while (guard++ < 32) {
    const scale = worldPool > 0 ? target / worldPool : 0;
    const tentative = {} as Record<NationId, number>;
    let overflow = 0;
    for (const id of ids) {
      if (capped.has(id)) continue;
      const scaled = NATIONS[id].popWan * scale;
      if (scaled > caps[id]) {
        tentative[id] = caps[id];
        overflow += scaled - caps[id];
      } else {
        tentative[id] = scaled;
      }
    }
    if (overflow <= 1e-9) {
      for (const id of ids) if (!capped.has(id)) pops[id] = tentative[id];
      break;
    }
    // 封顶本轮超限国家，释放其配额
    for (const id of ids) {
      if (capped.has(id)) continue;
      if (tentative[id] >= caps[id] - 1e-9) {
        pops[id] = caps[id];
        capped.add(id);
        target -= caps[id];
        worldPool -= NATIONS[id].popWan;
      }
    }
  }
  // 兜底（理论不会触发）：剩余未定国家按剩余配额均分
  for (const id of ids) {
    if (pops[id] === undefined) pops[id] = 0;
  }
  return pops;
}

/** 单一国家初始人口（UI 国家选择器显示用） */
export function scaledNationPop(map: GameMap, id: NationId): number {
  return scaledNationPops(map)[id];
}

/** 初始国家库存（17 商品；资源给足、半成品/成品少量起步；按缩放后人口计） */
function initialStocks(popWan: number, foodMonths: number): Record<GoodId, number> {
  const fm = foodMonths;
  const s = zeroGoods();
  s.food = (popWan * 0.09 * fm) / 12;
  s.clothing = popWan * 0.006 * fm;
  s.coal = popWan * 0.005 * fm;
  const resBase = popWan * 0.001 * fm;
  for (const g of ['timber', 'cotton', 'fur', 'ironOre', 'salt', 'fish'] as GoodId[]) s[g] = resBase;
  const semiBase = popWan * 0.0003 * fm;
  for (const g of ['lumber', 'cloth', 'iron', 'copper', 'steel', 'tools', 'swords', 'muskets', 'cannons', 'sailShip', 'luxury', 'transport'] as GoodId[]) {
    s[g] = semiBase;
  }
  return s;
}

export function newGameState(playerNation: NationId, seed: number, map: GameMap): GameState {
  const rng = new Rng(seed);
  const scaledPops = scaledNationPops(map); // v0.5：8 国人口按容量缩放
  const nations = {} as Record<NationId, NationState>;
  (Object.keys(NATIONS) as NationId[]).forEach((id) => {
    const def = NATIONS[id];
    const popWan = scaledPops[id];
    // v0.8 初始库存按省拆分（按格数分摊）+ 出口权（沿海/港口省默认获权）
    const initial = initialStocks(popWan, def.foodMonths);
    const provStocks: Record<number, Record<GoodId, number>> = {};
    const exportRights: Record<number, boolean> = {};
    const ownedProvs = map.provinces.filter((p) => p.owner === id && !p.isUndiscovered);
    const totalCells = Math.max(1, ownedProvs.reduce((s, p) => s + p.cellIds.length, 0));
    for (const p of ownedProvs) {
      const share = p.cellIds.length / totalCells;
      const ps = zeroGoods();
      for (const g of GOODS_LIST) ps[g] = initial[g] * share;
      // v0.9 初始运力库存：沿海省给基础运力（现有港口/码头），破「无运力→无贸易→无钱建基建」死循环
      ps.transport = isCoastal(map, p) ? 18 : 10;
      provStocks[p.id] = ps;
      exportRights[p.id] = isCoastal(map, p);
    }
    const stocks = zeroGoods();
    for (const pid of Object.keys(provStocks)) {
      for (const g of GOODS_LIST) stocks[g] += provStocks[Number(pid)][g];
    }
    nations[id] = {
      popWan,
      literacy: def.literacy,
      health: 0.6,
      treasury: def.treasury,
      foodStock: stocks.food,
      stability: def.stability,
      tax: defaultNationTax(def.taxDefaults),
      spending: { ...def.defaultSpending, court: 6, health: 5 },
      cells: nationCellCount(map, id),
      stocks,
      market: newMarket(),
      provinceMarkets: {},
      countyMarkets: {},
      provStocks,
      openTrade: false,
      exportRights,
      transportPolicy: 'auto',
      capitalWealth: 60, // 初始资本（资本家/银行家底子）
      warTime: false,
      gov: def.gov,
      projects: [],
      nextProjectId: 1,
      investCostAcc: 0,
      investRefundAcc: 0,
      infra: { roads: 10, ports: 10 },
      emigration: 0,
      monthly: zeroLedger(),
      bankruptMonths: 0,
      policies: defaultPolicies(),
      slavePop: 0,
      unrest: 0,
    };
  });

  const provinces: Record<number, ProvinceState> = {};
  for (const p of map.provinces) {
    const owner = p.owner;
    if (owner !== 'undiscovered') {
      const def = NATIONS[owner];
      const econ = initProvinceEcon(p, owner, scaledPops[owner], nations[owner].cells, def.stability);
      provinces[p.id] = { owner, ...econ };
    } else {
      provinces[p.id] = {
        owner,
        pops: [],
        popTotal: 0,
        housingCap: 0,
        efficiency: 1,
        happiness: 50,
        output: zeroGoods(),
        demand: zeroGoods(),
        freight: 1,
      };
    }
  }

  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    day: 0,
    speed: 3,
    prevSpeed: 3,
    playerNation,
    rngState: rng.state,
    nations,
    provinces,
    chronicle: [],
    lastAutosaveMonth: 0,
    history: {},
  };
  state.rngState = rng.state;
  return state;
}

function makeRng(state: GameState): Rng {
  return new Rng(state.rngState);
}

function commitRng(state: GameState, rng: Rng): void {
  state.rngState = rng.state;
}

/** 月度结算（仅玩家国家；他国为静态背景） */
export function settleMonth(state: GameState, map: GameMap): void {
  const rng = makeRng(state);
  const id = state.playerNation;
  const n = state.nations[id];

  // 1) 经济全循环（三级市场/产业链/阶级/政策/财政/识字率/稳定度）——纯函数式，无随机
  settleEconomyMonth(state, map);

  // 1b) v0.7 月度历史快照（侧栏图表数据源）
  recordHistory(state, map);

  // 2) 破产保护：国库允许为负，但记入大事记（带冷却，避免刷屏）
  if (n.treasury < BANKRUPTCY_THRESHOLD && n.bankruptMonths <= 0) {
    addChronicle(state, '国库破产', `国库跌破 ${BANKRUPTCY_THRESHOLD} 万₭，朝野震动，需设法扭转财政`);
    n.stability = Math.max(0, n.stability - 6);
    n.bankruptMonths = BANKRUPTCY_COOLDOWN;
  }
  if (n.bankruptMonths > 0) n.bankruptMonths--;

  // 3) 人工事件预留（v0.2 休眠检查点）：MANUAL_EVENTS 为空 → no-op。
  const mi = monthIndex(state.day);
  for (const ev of MANUAL_EVENTS) {
    if (ev.triggerMonth >= 0 && ev.triggerMonth === mi) {
      addChronicle(state, ev.title, ev.desc);
    }
  }

  commitRng(state, rng);
}

/** 推进一天（月末触发结算） */
export function tickDay(state: GameState, map: GameMap): void {
  state.day += 1;
  if (state.day % DAYS_PER_MONTH === 0) settleMonth(state, map);
}

/**
 * 政策操作：
 *  - 废农奴制（一次性）：奴隶 → 佃农(6) 60% / 自耕农(5) 40%，短期稳定度 -15，废除农奴制效率惩罚
 *  - 累进税 / 普选：开关切换（作用于当前国）
 */
export function setPolicy(state: GameState, policy: 'progressiveTax' | 'universalSuffrage', on: boolean): void {
  const n = state.nations[state.playerNation];
  if (policy === 'progressiveTax') {
    n.policies.progressiveTax = on;
    addChronicle(state, on ? '推行累进税' : '废止累进税', '上层多缴、下层减负；贵族啧有烦言');
  } else {
    n.policies.universalSuffrage = on;
    addChronicle(state, on ? '颁布普选' : '废止普选', on ? '庶民入朝堂，旧贵失其柄' : '选权收回，议会重归旧制');
    if (on) {
      // 普选对稳定度的混合影响：识字率高受益，低则动荡
      n.stability = Math.max(0, Math.min(100, n.stability + (n.literacy >= 0.5 ? 3 : -4)));
    }
  }
}

/** 废农奴制（一次性）：奴隶 → 佃农/自耕农；帝国初始可用 */
export function abolishSerfdom(state: GameState, map: GameMap): boolean {
  const n = state.nations[state.playerNation];
  if (n.policies.abolishedSerfdom) return false;
  // 统计奴隶并按职业转化（奴隶多为 farmer/miner；目标阶级 POP 不存在则创建）
  let converted = 0;
  for (const p of map.provinces) {
    if (p.owner !== state.playerNation || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    const slaves = ps.pops.filter((pop) => pop.class === 7);
    for (const s of slaves) {
      const toTenant = s.size * 0.6; // 佃农
      const toOwner = s.size * 0.4; // 自耕农
      if (toTenant > 0) {
        let t = ps.pops.find((x) => x.class === 6 && x.job === s.job && x.race === s.race);
        if (!t) {
          t = { class: 6, job: s.job, race: s.race, size: 0, happiness: 46, wage: s.wage, investIncome: 0, sat: { ...s.sat }, retrainMonths: 0 };
          ps.pops.push(t);
        }
        t.size += toTenant;
      }
      if (toOwner > 0) {
        let o = ps.pops.find((x) => x.class === 5 && x.job === s.job && x.race === s.race);
        if (!o) {
          o = { class: 5, job: s.job, race: s.race, size: 0, happiness: 54, wage: s.wage, investIncome: 0, sat: { ...s.sat }, retrainMonths: 0 };
          ps.pops.push(o);
        }
        o.size += toOwner;
      }
      converted += s.size;
      s.size = 0;
    }
    // 清空零规模奴隶 POP
    ps.pops = ps.pops.filter((x) => x.size > 1e-9 || x.class !== 7);
    ps.popTotal = 0;
    for (const pop of ps.pops) ps.popTotal += pop.size;
  }
  if (converted <= 0) return false;
  n.policies.abolishedSerfdom = true;
  n.slavePop = 0;
  n.stability = Math.max(0, n.stability - 15); // 短期动荡：地主震怒、秩序重排
  addChronicle(state, '废农奴制', `解放奴隶 ${converted.toFixed(0)} 万 → 佃农/自耕农；地主震怒，稳定度 -15`);
  return true;
}

/** 月度结束时检查所有数值有限（调试/断言用） */
export function allFinite(state: GameState): boolean {
  for (const id of Object.keys(state.nations) as NationId[]) {
    const n = state.nations[id];
    const nums: number[] = [
      n.popWan, n.literacy, n.health, n.treasury, n.foodStock, n.stability,
      n.emigration, n.infra.roads, n.infra.ports, n.slavePop, n.unrest,
      n.monthly.income, n.monthly.spending,
      n.monthly.pollTax, n.monthly.landTax, n.monthly.consumptionTax, n.monthly.tariff, n.monthly.otherTax, n.monthly.goodsTax,
      n.monthly.investIncome, n.monthly.investReturn, n.monthly.investCost, n.monthly.investRefund,
      n.investCostAcc, n.investRefundAcc,
    ];
    for (const v of nums) if (!Number.isFinite(v)) return false;
    // v0.4 税制字段
    for (const k of Object.keys(n.tax.rates) as (keyof NationTax['rates'])[]) {
      if (!Number.isFinite(n.tax.rates[k]) || n.tax.rates[k] < 0 || n.tax.rates[k] > 0.3) return false;
    }
    for (const g of Object.keys(n.tax.goods) as GoodId[]) {
      if (!Number.isFinite(n.tax.goods[g]) || n.tax.goods[g] < 0 || n.tax.goods[g] > 0.3) return false;
    }
    for (const g of Object.keys(n.stocks) as GoodId[]) {
      if (!Number.isFinite(n.stocks[g])) return false;
      const m = n.market[g];
      for (const v of [m.price, m.prevPrice, m.effPrice, m.costPush, m.supply, m.demand, m.consumed, m.exported, m.imported, m.unmet, m.trend]) {
        if (!Number.isFinite(v)) return false;
      }
    }
    // v0.8 省库存（结算账本）与开放度
    for (const pid of Object.keys(n.provStocks)) {
      const ps = n.provStocks[Number(pid)];
      if (!ps) return false;
      for (const g of Object.keys(ps) as GoodId[]) {
        if (!Number.isFinite(ps[g])) return false;
      }
    }
    if (typeof n.openTrade !== 'boolean') return false;
    // 区域市场（省）
    for (const pid of Object.keys(n.provinceMarkets)) {
      const pm = n.provinceMarkets[Number(pid)];
      if (!pm) return false;
      for (const g of Object.keys(pm) as GoodId[]) {
        const m = pm[g];
        for (const v of [m.price, m.prevPrice, m.effPrice, m.costPush, m.supply, m.demand, m.consumed, m.exported, m.imported, m.unmet, m.netFlow, m.flowIn, m.flowOut, m.trend]) {
          if (!Number.isFinite(v)) return false;
        }
      }
    }
    // 本地市场（县）
    for (const cid of Object.keys(n.countyMarkets)) {
      const cm = n.countyMarkets[Number(cid)];
      if (!cm) return false;
      for (const g of Object.keys(cm) as GoodId[]) {
        const m = cm[g];
        for (const v of [m.price, m.prevPrice, m.supply, m.demand, m.consumed, m.unmet, m.netFlow, m.trend]) {
          if (!Number.isFinite(v)) return false;
        }
      }
    }
    // 投资项目
    for (const p of n.projects) {
      if (!Number.isFinite(p.totalCost) || !Number.isFinite(p.duration) || !Number.isFinite(p.monthsLeft)) return false;
      if (!Number.isFinite(p.lastSkillFactor) || !Number.isFinite(p.lastRunFactor) || !Number.isFinite(p.lastOutput)) return false;
      if (p.monthsLeft < 0 || p.monthsLeft > p.duration) return false;
    }
  }
  for (const p of Object.values(state.provinces)) {
    if (!Number.isFinite(p.popTotal) || !Number.isFinite(p.housingCap) || !Number.isFinite(p.efficiency) || !Number.isFinite(p.happiness)) {
      return false;
    }
    for (const pop of p.pops) {
      if (!Number.isFinite(pop.size) || !Number.isFinite(pop.happiness) || !Number.isFinite(pop.wage) || !Number.isFinite(pop.investIncome)) return false;
      if (pop.size < 0) return false;
    }
  }
  // v0.7 历史快照校验
  for (const list of Object.values(state.history ?? {})) {
    if (!list || list.length === 0) continue;
    if (list.length > HISTORY_MAX) return false;
    for (const h of list) {
      const nums = [h.treasury, h.income, h.spending, h.popWan, h.stability, h.happiness, ...(h.classMix ?? [])];
      for (const v of nums) if (!Number.isFinite(v)) return false;
      for (const g of HISTORY_GOODS) if (!Number.isFinite(h.prices?.[g])) return false;
      if (!Number.isFinite(h.tax?.poll) || !Number.isFinite(h.tax?.land) || !Number.isFinite(h.tax?.consumption) || !Number.isFinite(h.tax?.tariff) || !Number.isFinite(h.tax?.other) || !Number.isFinite(h.tax?.goods)) return false;
    }
  }
  return true;
}

// ---- 存档（localStorage；无 DOM 环境自动跳过） ----
export function saveGame(state: GameState): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): GameState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const text = localStorage.getItem(SAVE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as GameState;
    if (
      parsed &&
      parsed.version === SAVE_VERSION &&
      typeof parsed.day === 'number' &&
      parsed.nations &&
      parsed.nations.lorraine &&
      parsed.nations.lorraine.policies &&
      parsed.nations.lorraine.tax &&
      parsed.nations.lorraine.tax.rates &&
      parsed.nations.lorraine.tax.goods &&
      parsed.nations.lorraine.provStocks &&
      typeof parsed.nations.lorraine.openTrade === 'boolean'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** 是否存在旧版本存档（v0.3 存档不兼容提示） */
export function hasOldSave(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return OLD_SAVE_KEYS.some((k) => localStorage.getItem(k) !== null);
  } catch {
    return false;
  }
}

export function clearSave(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(SAVE_KEY);
    for (const k of OLD_SAVE_KEYS) localStorage.removeItem(k);
  } catch {
    // 忽略
  }
}
