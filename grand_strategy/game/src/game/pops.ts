/**
 * 聚合 POP（v0.3）：每省按 阶级×职业×种族 聚合劳动力。
 *  - 阶级：7 级（见 classes.ts）——税收负担/奢侈品/政治权重/幸福/动乱/流动
 *  - 职业：农民/矿工/工匠/工程师；种族：八族
 *  - 每 POP：size（万人）、class、needs 满足度、happiness（0-100）、wage、investIncome
 *  - 需求四件套（粮食/衣物/住房/燃料）：满足度 → 幸福度 → 生产效率倍率（0.5-1.2）
 *  - 产出：农民产粮（沃土修正）+ 省资源附加（棉/木/渔/盐/毛皮）；矿工按矿藏省出煤/铁；工匠手工衣物；工程师微量工具
 */
import type { GameMap, Province } from './map';
import type { GoodId, JobId, NationId, NeedId, RaceId, TaxLevel } from './types';
import type { ClassId } from './types';
import { CLASSES, CLASS_DEFS, INITIAL_CLASS_MIX, classDef } from './classes';
import { GOODS_LIST, zeroGoods } from './market';
import { provinceHasFur, provinceHasResource, provinceCoastal } from './resources';

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---- 枚举与中文标签 ----
export const RACES: RaceId[] = [
  'ursus', 'draco', 'feline', 'liberi', 'aegir', 'zalak', 'sarkaz', 'norman',
];
export const RACE_LABEL: Record<RaceId, string> = {
  ursus: '乌萨斯',
  draco: '德拉科',
  feline: '菲林',
  liberi: '黎博利',
  aegir: '阿戈尔',
  zalak: '扎拉克',
  sarkaz: '萨卡兹',
  norman: '诺曼',
};

export const JOBS: JobId[] = ['farmer', 'miner', 'artisan', 'engineer'];
export const JOB_LABEL: Record<JobId, string> = {
  farmer: '农民',
  miner: '矿工',
  artisan: '工匠',
  engineer: '工程师',
};

export const GOODS: GoodId[] = GOODS_LIST;
export const GOOD_LABEL: Record<GoodId, string> = {
  food: '粮食',
  timber: '木材',
  cotton: '棉花',
  fur: '毛皮',
  coal: '煤炭',
  ironOre: '铁矿石',
  salt: '盐',
  fish: '渔获',
  lumber: '木料',
  cloth: '布料',
  iron: '铁锭',
  steel: '钢材',
  tools: '工具',
  weapons: '武器',
  sailShip: '帆船',
  clothing: '衣物',
  luxury: '奢侈品',
};

export const NEEDS: NeedId[] = ['food', 'clothing', 'housing', 'fuel'];
export const NEED_LABEL: Record<NeedId, string> = {
  food: '粮食',
  clothing: '衣物',
  housing: '住房',
  fuel: '燃料',
};

// ---- 数值基础 ----
/** 每万人月需求（万吨/万件；工具/武器/帆船等由建筑与政府消耗，不走 POP 需求） */
export const NEED_PER_WAN: Record<GoodId, number> = {
  food: 0.0075,
  clothing: 0.006,
  coal: 0.005, // 燃料需求并入煤炭
  fish: 0.002, // 渔获作为粮食替代（沿海民食）
  timber: 0, cotton: 0, fur: 0, ironOre: 0, salt: 0,
  lumber: 0, cloth: 0, iron: 0, steel: 0,
  tools: 0, weapons: 0, sailShip: 0, luxury: 0,
};

/** 每万从业者月基础产出（基准单位：万吨/万件） */
export const JOB_OUTPUT_PER_WAN: Record<JobId, number> = {
  farmer: 0.022,
  miner: 0.02,
  artisan: 0.012, // 手工衣物（工业化前夜；规模化靠服装厂）
  engineer: 0.002,
};

/** 职业 → 主产出商品 */
export const JOB_GOOD: Record<JobId, GoodId> = {
  farmer: 'food',
  miner: 'coal',
  artisan: 'clothing',
  engineer: 'tools',
};

/** 农民省资源附加产出（每万从业者月产，按省资源/沿海/气候） */
export const FARMER_EXTRA_OUTPUT: Record<GoodId, number> = {
  timber: 0.004,
  cotton: 0.005,
  fish: 0.006,
  salt: 0.002,
  fur: 0.0016,
  food: 0, clothing: 0, coal: 0, ironOre: 0, lumber: 0, cloth: 0, iron: 0, steel: 0, tools: 0, weapons: 0, sailShip: 0, luxury: 0,
};

/** 矿工产出：煤（矿藏省）/ 铁（矿藏省）；无矿藏省产出 0（资源修正：矿工需矿场） */
export const MINER_OUTPUT: Record<GoodId, number> = {
  coal: 0.02,
  ironOre: 0.014,
  food: 0, timber: 0, cotton: 0, fur: 0, salt: 0, fish: 0,
  lumber: 0, cloth: 0, iron: 0, steel: 0, tools: 0, weapons: 0, sailShip: 0, clothing: 0, luxury: 0,
};

/** 奢侈品：工匠/工程师附加产出（每万从业者月产单位；× 省奢侈品潜力） */
export const LUXURY_OUTPUT_PER_WAN: Record<JobId, number> = {
  farmer: 0,
  miner: 0,
  artisan: 0.001,
  engineer: 0.0008,
};
/** 奢侈品需求基数（× 阶级奢侈权重 × 幸福度系数 × 国家财富系数） */
export const LUXURY_NEED_BASE = 0.0022;
/** 国家财富系数 clamp 范围（国民财富↑ → 奢侈品需求↑） */
export const LUXURY_WEALTH_MIN = 0.7;
export const LUXURY_WEALTH_MAX = 2.2;

/** 省奢侈品潜力（省份文化/财富系数，由经济产出倍率推导，0.5-1.5） */
export function provinceLuxuryPotential(prov: Province): number {
  return clamp(0.5 + prov.productivity * 0.5, 0.5, 1.5);
}
/** 国家财富系数：人口年收入与国库共同决定（0.7-2.2） */
export function luxuryWealthCoef(n: { popWan: number; treasury: number }): number {
  const annualIncome = n.popWan * 3.0; // PER_CAPITA_INCOME 常量内联，避免循环依赖
  return clamp(0.8 + annualIncome / 6000 + Math.max(0, n.treasury) / 8000, LUXURY_WEALTH_MIN, LUXURY_WEALTH_MAX);
}
/** 职业基础年薪（万₭/人/年） */
export const BASE_WAGE: Record<JobId, number> = {
  farmer: 2.4,
  miner: 3.0,
  artisan: 3.4,
  engineer: 4.2,
};
/** 每格住房容量（万人）——基建可提升 */
export const BASE_HOUSING_PER_CELL = 4.5;
/** 转职代价：该 POP 3 个月产出减半 */
export const RETRAIN_MONTHS = 3;
export const RETRAIN_OUTPUT_PENALTY = 0.5;
/** 技能梯子（下一职业；engineer 为顶端） */
export const JOB_LADDER: Record<JobId, JobId | null> = {
  farmer: 'miner',
  miner: 'artisan',
  artisan: 'engineer',
  engineer: null,
};
/** 技能梯子识字率门槛 */
export const LITERACY_REQ: Record<JobId, number> = {
  farmer: 0,
  miner: 0.1,
  artisan: 0.25,
  engineer: 0.5,
};
/** 各国主体种族构成（初始化 POP 用） */
export const NATION_RACE_MIX: Record<NationId, Record<RaceId, number>> = {
  lorraine: {
    feline: 0.93, liberi: 0.04, aegir: 0.02, sarkaz: 0.01,
    ursus: 0, draco: 0, zalak: 0, norman: 0,
  },
  ianys: {
    liberi: 0.9, feline: 0.04, aegir: 0.03, zalak: 0.02, norman: 0.01,
    ursus: 0, draco: 0, sarkaz: 0,
  },
  empire: {
    ursus: 0.8, draco: 0.15, sarkaz: 0.03, zalak: 0.01, feline: 0.01,
    liberi: 0, aegir: 0, norman: 0,
  },
};
/** 初始职业构成（工业化前夜） */
export const INITIAL_JOB_MIX: Record<JobId, number> = {
  farmer: 0.55,
  miner: 0.15,
  artisan: 0.22,
  engineer: 0.08,
};

export interface Pop {
  class: ClassId;
  job: JobId;
  race: RaceId;
  /** 规模（万人） */
  size: number;
  /** 幸福度 0-100 */
  happiness: number;
  /** 年薪（万₭/人/年，劳动力市场工资） */
  wage: number;
  /** 投资收入（万₭/月，上层阶级由全国资本回报池分配） */
  investIncome: number;
  /** 四件套满足度 0-1 */
  sat: Record<NeedId, number>;
  /** 转职惩罚剩余月数（期间产出减半） */
  retrainMonths: number;
}

export interface ProvinceEcon {
  pops: Pop[];
  /** 省总人口（万人） */
  popTotal: number;
  /** 住房容量（万人） */
  housingCap: number;
  /** 生产效率倍率 0.5-1.2 */
  efficiency: number;
  /** 平均幸福度 0-100 */
  happiness: number;
  /** 上月各商品产出 */
  output: Record<GoodId, number>;
  /** 上月各商品需求 */
  demand: Record<GoodId, number>;
  /** 本省运费系数 */
  freight: number;
}

/** 新建省的聚合 POP（按国家主体种族 × 初始职业构成 × 初始阶级分布） */
export function createProvincePops(
  provincePop: number,
  nationId: NationId,
): Pop[] {
  const raceMix = NATION_RACE_MIX[nationId];
  const classMix = INITIAL_CLASS_MIX[nationId];
  const pops: Pop[] = [];
  for (const race of RACES) {
    const raceShare = raceMix[race] ?? 0;
    if (raceShare <= 0) continue;
    for (const job of JOBS) {
      const jobShare = INITIAL_JOB_MIX[job];
      const perClass = classMix[job];
      for (const c of CLASSES) {
        const w = perClass[c] ?? 0;
        if (w <= 0) continue;
        const size = provincePop * raceShare * jobShare * w;
        if (size < 0.001) continue;
        pops.push({
          class: c,
          job,
          race,
          size,
          happiness: CLASS_DEFS[c].baseHappiness,
          wage: BASE_WAGE[job],
          investIncome: 0,
          sat: { food: 0.9, clothing: 0.9, housing: 0.9, fuel: 0.9 },
          retrainMonths: 0,
        });
      }
    }
  }
  return pops;
}

/** 初始化省经济状态（国家人口按格数分摊） */
export function initProvinceEcon(
  prov: Province,
  nationId: NationId,
  nationPopWan: number,
  nationCells: number,
  stability: number,
): ProvinceEcon {
  const share = prov.cellIds.length / Math.max(1, nationCells);
  const popTotal = nationPopWan * share;
  return {
    pops: createProvincePops(popTotal, nationId),
    popTotal,
    housingCap: prov.cellIds.length * BASE_HOUSING_PER_CELL,
    efficiency: 0.5 + 0.7 * (stability / 100),
    happiness: stability,
    output: zeroGoods(),
    demand: zeroGoods(),
    freight: 1,
  };
}

/** 人口增长政策系数（苛税 → 增长低 → 恶性循环） */
export const POLICY_GROWTH: Record<TaxLevel, number> = {
  light: 1.2,
  medium: 1.0,
  heavy: 0.85,
  oppressive: 0.7,
};

/** 统计省职业构成（UI 用） */
export function provinceJobMix(p: ProvinceEcon): Record<JobId, number> {
  const mix: Record<JobId, number> = { farmer: 0, miner: 0, artisan: 0, engineer: 0 };
  for (const pop of p.pops) mix[pop.job] += pop.size;
  return mix;
}

/** 统计省种族构成（UI 用） */
export function provinceRaceMix(p: ProvinceEcon): Record<RaceId, number> {
  const mix: Record<RaceId, number> = {
    ursus: 0, draco: 0, feline: 0, liberi: 0, aegir: 0, zalak: 0, sarkaz: 0, norman: 0,
  };
  for (const pop of p.pops) mix[pop.race] += pop.size;
  return mix;
}

/** 统计省阶级构成（UI 用，万人） */
export function provinceClassMix(p: ProvinceEcon): Record<ClassId, number> {
  const mix: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const pop of p.pops) mix[pop.class] += pop.size;
  return mix;
}

/** 从国家维度聚合各职业人口（万人） */
export function nationJobSupply(map: GameMap, state: { provinces: Record<number, ProvinceEcon> }, nationId: NationId): Record<JobId, number> {
  const supply: Record<JobId, number> = { farmer: 0, miner: 0, artisan: 0, engineer: 0 };
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) supply[pop.job] += pop.size;
  }
  return supply;
}

/** 从国家维度聚合各阶级人口（万人，UI/政治权重用） */
export function nationClassMix(map: GameMap, state: { provinces: Record<number, ProvinceEcon> }, nationId: NationId): Record<ClassId, number> {
  const mix: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const p of map.provinces) {
    if (p.owner !== nationId || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps) continue;
    for (const pop of ps.pops) mix[pop.class] += pop.size;
  }
  return mix;
}

/** 找省内同职业同种族的指定阶级 POP（阶级流动目标；不存在返回 null） */
export function findClassPop(pops: Pop[], job: JobId, race: RaceId, cls: ClassId): Pop | null {
  for (const pop of pops) {
    if (pop.job === job && pop.race === race && pop.class === cls) return pop;
  }
  return null;
}

/** 省份农业修正：沃土省产粮加成，非沃土省减产（设计文档：沃土=农业加成） */
export function provinceFoodMod(prov: Province): number {
  return provinceHasResource(prov, 'farmland') ? 1.2 : 0.9;
}

/** 农民产出（含资源附加）：沃土修正 × 气候 grainMod */
export function farmerOutput(prov: Province, size: number, mult: number): Record<GoodId, number> {
  const out = zeroGoods();
  out.food = size * JOB_OUTPUT_PER_WAN.farmer * provinceFoodMod(prov) * prov.grainMod * mult;
  // 省资源附加：棉/木/渔/盐（沿海）/毛皮（寒带林）
  if (provinceHasResource(prov, 'timber')) out.timber += size * FARMER_EXTRA_OUTPUT.timber * mult;
  if (provinceHasResource(prov, 'cotton')) out.cotton += size * FARMER_EXTRA_OUTPUT.cotton * mult;
  if (provinceCoastal(prov)) {
    out.fish += size * FARMER_EXTRA_OUTPUT.fish * mult;
    out.salt += size * FARMER_EXTRA_OUTPUT.salt * mult;
  }
  if (provinceHasFur(prov)) out.fur += size * FARMER_EXTRA_OUTPUT.fur * mult;
  return out;
}

/** 矿工产出（按矿藏省：煤/铁；无矿藏 → 0，需建矿场） */
export function minerOutput(prov: Province, size: number, mult: number): Record<GoodId, number> {
  const out = zeroGoods();
  if (provinceHasResource(prov, 'coal')) out.coal += size * MINER_OUTPUT.coal * mult;
  if (provinceHasResource(prov, 'iron')) out.ironOre += size * MINER_OUTPUT.ironOre * mult;
  return out;
}

/** 阶级定义快捷访问 */
export { classDef };
