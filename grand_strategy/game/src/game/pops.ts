/**
 * 聚合 POP（v0.1）：每省按 职业×种族 聚合劳动力。
 *  - 职业：农民/矿工/工匠/工程师；种族：乌萨斯/德拉科/菲林/黎博利/阿戈尔/扎拉克/萨卡兹/诺曼
 *  - 每 POP：size（万人）、needs 满足度、happiness（0-100）、wage、job
 *  - 需求四件套（粮食/衣物/住房/燃料）：满足度 → 幸福度 → 生产效率倍率（0.5-1.2）
 */
import type { GameMap, Province } from './map';
import type { GoodId, JobId, NationId, NeedId, RaceId, TaxLevel } from './types';

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

export const GOODS: GoodId[] = ['food', 'clothing', 'fuel', 'industrial', 'luxury'];
export const GOOD_LABEL: Record<GoodId, string> = {
  food: '粮食',
  clothing: '衣物',
  fuel: '燃料',
  industrial: '工业品',
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
/** 职业 → 产出商品 */
export const JOB_GOOD: Record<JobId, GoodId> = {
  farmer: 'food',
  miner: 'fuel',
  artisan: 'clothing',
  engineer: 'industrial',
};
/** 每万从业者月产出（基准单位：万吨 / 万件） */
export const JOB_OUTPUT_PER_WAN: Record<JobId, number> = {
  farmer: 0.022,
  miner: 0.014,
  artisan: 0.016,
  engineer: 0.010,
};
/** 每万人月需求（万吨 / 万件；工业品由军费/基建间接消耗，奢侈品走财富系数公式） */
export const NEED_PER_WAN: Record<GoodId, number> = {
  food: 0.0075,
  clothing: 0.006,
  fuel: 0.005,
  industrial: 0,
  luxury: 0,
};
/** 职业财富系数（决定奢侈品需求权重与精英投资收入占比） */
export const WEALTH_BASE: Record<JobId, number> = {
  farmer: 0.1,
  miner: 0.2,
  artisan: 0.5,
  engineer: 1.0,
};
/** 奢侈品：工匠/工程师附加产出（每万从业者月产单位；× 省奢侈品潜力） */
export const LUXURY_OUTPUT_PER_WAN: Record<JobId, number> = {
  farmer: 0,
  miner: 0,
  artisan: 0.004,
  engineer: 0.003,
};
/** 奢侈品需求基数（× 职业财富 × 幸福度系数 × 国家财富系数） */
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
  job: JobId;
  race: RaceId;
  /** 规模（万人） */
  size: number;
  /** 幸福度 0-100 */
  happiness: number;
  /** 年薪（万₭/人/年，劳动力市场工资） */
  wage: number;
  /** 投资收入（万₭/月，精英/富裕 POP 由全国资本回报池分配） */
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

/** 新建省的聚合 POP（按国家主体种族 × 初始职业构成） */
export function createProvincePops(
  provincePop: number,
  nationId: NationId,
): Pop[] {
  const raceMix = NATION_RACE_MIX[nationId];
  const pops: Pop[] = [];
  for (const race of RACES) {
    const raceShare = raceMix[race] ?? 0;
    if (raceShare <= 0) continue;
    for (const job of JOBS) {
      const size = provincePop * raceShare * INITIAL_JOB_MIX[job];
      if (size < 0.001) continue;
      pops.push({
        job,
        race,
        size,
        happiness: 60,
        wage: BASE_WAGE[job],
        investIncome: 0,
        sat: { food: 0.9, clothing: 0.9, housing: 0.9, fuel: 0.9 },
        retrainMonths: 0,
      });
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
    output: { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 },
    demand: { food: 0, clothing: 0, fuel: 0, industrial: 0, luxury: 0 },
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
