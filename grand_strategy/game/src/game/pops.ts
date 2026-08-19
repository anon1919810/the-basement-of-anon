/**
 * 聚合 POP（v0.3）：每省按 阶级×职业×种族 聚合劳动力。
 *  - 阶级：7 级（见 classes.ts）——税收负担/奢侈品/政治权重/幸福/动乱/流动
 *  - 职业：农民/矿工/工匠/工程师；种族：八族
 *  - 每 POP：size（万人）、class、needs 满足度、happiness（0-100）、wage、investIncome
 *  - 需求四件套（粮食/衣物/住房/燃料）：满足度 → 幸福度 → 生产效率倍率（0.5-1.2）
 *  - 产出：农民产粮（沃土修正）+ 省资源附加（棉/木/渔/盐/毛皮）；矿工按矿藏省出煤/铁；工匠手工衣物；工程师微量工具
 */
import type { GameMap, Province } from './map';
import type { GoodId, JobId, NationId, NeedId, RaceId } from './types';
import type { ClassId } from './types';
import { CLASSES, CLASS_DEFS, INITIAL_CLASS_DIST, classDef } from './classes';
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

export const JOBS: JobId[] = ['slave', 'peasant', 'worker', 'technician', 'clerk', 'engineer', 'shopkeeper', 'soldier', 'bureaucrat', 'merchant', 'capitalist', 'banker'];
export const JOB_LABEL: Record<JobId, string> = {
  slave: '奴隶', peasant: '自耕农', worker: '工人', technician: '技术工人',
  clerk: '职员', engineer: '工程师', shopkeeper: '店主',
  soldier: '军人', bureaucrat: '官僚',
  merchant: '商人', capitalist: '资本家', banker: '银行家',
};

/** 零职业分布（UI/统计初始化用） */
export function zeroJobMix(): Record<JobId, number> {
  return {
    slave: 0, peasant: 0, worker: 0, technician: 0, clerk: 0, engineer: 0,
    shopkeeper: 0, soldier: 0, bureaucrat: 0, merchant: 0, capitalist: 0, banker: 0,
  };
}

export const GOODS: GoodId[] = GOODS_LIST;
export const GOOD_LABEL: Record<GoodId, string> = {
  food: '粗粮', wheat: '小麦', cotton: '棉花', fur: '皮毛',
  timber: '木材', coal: '煤炭', ironOre: '铁矿石', copperOre: '铜矿石',
  sulfur: '硫磺', salt: '盐', fish: '渔获', meat: '肉类',
  stone: '石料', oil: '鲸油', coffee: '咖啡', tobacco: '烟草',
  lumber: '木料', cloth: '布料', iron: '铁锭', copper: '铜锭', steel: '钢',
  flour: '面粉', sugar: '糖', leather: '皮革', gunpowder: '火药',
  dynamite: '炸药', machines: '机器',
  tools: '工具', swords: '刀剑', muskets: '燧发枪', cannons: '火炮',
  sailShip: '帆船', clothing: '服装', fineFood: '高级食物',
  luxury: '奢侈品', transport: '运力',
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
  wheat: 0.001, // 细粮（上层多，消费矩阵 C 阶段细化）
  meat: 0.0015,
  clothing: 0.004, // v0.9 平衡：0.006→0.004（穿衣需求更现实）
  coal: 0.006, // 燃料需求（v0.9 平衡：0.005→0.006，消煤过剩不过头）
  fish: 0.002, // 渔获作为粮食替代（沿海民食）
  sugar: 0.0006,
  coffee: 0.0004,
  tobacco: 0.0006,
  fineFood: 0.0003,
  timber: 0, cotton: 0, fur: 0, ironOre: 0, copperOre: 0, sulfur: 0, salt: 0, stone: 0, oil: 0,
  lumber: 0, cloth: 0, iron: 0, copper: 0, steel: 0,
  flour: 0, leather: 0, gunpowder: 0, dynamite: 0, machines: 0,
  tools: 0, swords: 0, muskets: 0, cannons: 0, sailShip: 0, luxury: 0, transport: 0,
};

/** 每万从业者月基础产出（基准单位：万吨/万件；军人/官僚为俸禄职业不产商品） */
export const JOB_OUTPUT_PER_WAN: Record<JobId, number> = {
  slave: 0.008,
  peasant: 0.022,
  worker: 0.02,
  technician: 0.012, // 技术工种（精加工前夜）
  clerk: 0.004,      // 管理岗（产出少，效率加成角色）
  engineer: 0.002,
  shopkeeper: 0.001, // 店主：小商业（小资产阶级）
  soldier: 0,        // 军人：吃军饷
  bureaucrat: 0.002, // 官僚：行政管理产出
  merchant: 0, capitalist: 0, banker: 0, // 资本侧不出产商品
};

/** 职业 → 主产出商品 */
export const JOB_GOOD: Record<JobId, GoodId> = {
  slave: 'food',
  peasant: 'food',
  worker: 'coal',
  technician: 'clothing',
  clerk: 'clothing',
  engineer: 'tools',
  shopkeeper: 'luxury',
  soldier: 'food',
  bureaucrat: 'clothing',
  merchant: 'luxury',
  capitalist: 'luxury',
  banker: 'luxury',
};

/** 农民省资源附加产出（每万从业者月产，按省资源/沿海/气候；无建筑自然经济底子，不受加强项加成） */
export const FARMER_EXTRA_OUTPUT: Record<GoodId, number> = {
  food: 0, // 基础产出口粮（farmerOutput 主产）
  wheat: 0.002,
  timber: 0.004,
  cotton: 0.005,
  fish: 0.006,
  salt: 0.002,
  fur: 0.0016,
  meat: 0.001,
  sugar: 0.0008,
  coffee: 0, tobacco: 0, coal: 0, ironOre: 0, copperOre: 0, sulfur: 0, stone: 0, oil: 0,
  lumber: 0, cloth: 0, iron: 0, copper: 0, steel: 0, flour: 0, leather: 0, gunpowder: 0, dynamite: 0, machines: 0,
  tools: 0, swords: 0, muskets: 0, cannons: 0, sailShip: 0, clothing: 0, fineFood: 0, luxury: 0, transport: 0,
};

/** 矿工产出：煤（矿藏省）/ 铁 / 铜 / 硫 / 石料（矿藏省）；无矿藏省产出 0（资源修正：矿工需矿场） */
export const MINER_OUTPUT: Record<GoodId, number> = {
  coal: 0.02,
  ironOre: 0.014,
  copperOre: 0.012,
  sulfur: 0.01,
  stone: 0.015,
  food: 0, wheat: 0, timber: 0, cotton: 0, fur: 0, salt: 0, fish: 0, meat: 0, sugar: 0, coffee: 0, tobacco: 0, oil: 0,
  lumber: 0, cloth: 0, iron: 0, copper: 0, steel: 0, flour: 0, leather: 0, gunpowder: 0, dynamite: 0, machines: 0,
  tools: 0, swords: 0, muskets: 0, cannons: 0, sailShip: 0, clothing: 0, fineFood: 0, luxury: 0, transport: 0,
};

/** 奢侈品：工匠/工程师附加产出（每万从业者月产单位；× 省奢侈品潜力） */
export const LUXURY_OUTPUT_PER_WAN: Record<JobId, number> = {
  slave: 0, peasant: 0, worker: 0,
  technician: 0.001,
  clerk: 0,
  engineer: 0.0008,
  shopkeeper: 0.0004,
  soldier: 0, bureaucrat: 0,
  merchant: 0, capitalist: 0, banker: 0,
};
/** 奢侈品需求基数（× 阶级奢侈权重 × 幸福度系数 × 国家财富系数）；v0.9 平衡：0.0022→0.0006（工业化前奢侈品本就稀少） */
export const LUXURY_NEED_BASE = 0.0006;
/** 国家财富系数 clamp 范围（国民财富↑ → 奢侈品需求↑） */
export const LUXURY_WEALTH_MIN = 0.7;
export const LUXURY_WEALTH_MAX = 2.2;

// ---- 消费矩阵（v0.9 10.4：商品 × 阶级权重 + 商品 × 职业乘数）----
/** 消费性商品（设矩阵；生产性商品不设） */
export const CONSUMER_GOODS: GoodId[] = [
  'food', 'wheat', 'meat', 'fish', 'sugar', 'coffee', 'tobacco',
  'clothing', 'fineFood', 'luxury', 'coal',
];

/** 商品 × 阶级（1 贵族→7 奴役）消费权重：上层细粮糖奢侈品多，下层粗粮多（仅消费性商品设矩阵） */
export const CONSUME_MATRIX: Partial<Record<GoodId, Record<ClassId, number>>> = {
  food: { 1: 0.5, 2: 0.6, 3: 0.8, 4: 1.0, 5: 1.15, 6: 1.25, 7: 1.35 },
  wheat: { 1: 2.0, 2: 1.6, 3: 1.2, 4: 0.7, 5: 0.3, 6: 0.1, 7: 0 },
  meat: { 1: 2.2, 2: 1.8, 3: 1.4, 4: 1.0, 5: 0.5, 6: 0.25, 7: 0.12 },
  fish: { 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.1, 5: 1.2, 6: 1.3, 7: 1.4 },
  sugar: { 1: 2.5, 2: 2.0, 3: 1.5, 4: 1.0, 5: 0.5, 6: 0.2, 7: 0.1 },
  coffee: { 1: 2.0, 2: 1.7, 3: 1.3, 4: 1.0, 5: 0.6, 6: 0.3, 7: 0.1 },
  tobacco: { 1: 1.2, 2: 1.2, 3: 1.1, 4: 1.0, 5: 1.1, 6: 1.0, 7: 0.6 },
  clothing: { 1: 1.5, 2: 1.4, 3: 1.2, 4: 1.0, 5: 0.9, 6: 0.8, 7: 0.6 },
  fineFood: { 1: 3.0, 2: 2.2, 3: 1.5, 4: 0.8, 5: 0.3, 6: 0.1, 7: 0 },
  luxury: { 1: 4.0, 2: 2.5, 3: 1.0, 4: 0.2, 5: 0, 6: 0, 7: 0 },
  coal: { 1: 1.3, 2: 1.2, 3: 1.1, 4: 1.0, 5: 0.95, 6: 0.9, 7: 0.8 },
};

/** 商品 × 职业消费乘数（默认 1；军人烟酒多、官僚服装咖啡多、工人烟草多；仅消费性商品设矩阵） */
export const JOB_CONSUME: Partial<Record<GoodId, Partial<Record<JobId, number>>>> = {
  food: { soldier: 1.5, peasant: 1.3, worker: 1.1, bureaucrat: 1.2, shopkeeper: 1.1 },
  meat: { soldier: 1.5, peasant: 1.1, worker: 1.1, merchant: 1.2, shopkeeper: 1.2 },
  tobacco: { soldier: 2.0, worker: 1.6, peasant: 1.2, bureaucrat: 1.2, merchant: 1.3, shopkeeper: 1.3 },
  coffee: { bureaucrat: 2.5, clerk: 1.8, merchant: 1.5, capitalist: 1.5, banker: 1.6, soldier: 1.2, shopkeeper: 1.4 },
  clothing: { bureaucrat: 1.8, clerk: 1.3, engineer: 1.2, soldier: 1.2, capitalist: 1.3, shopkeeper: 1.3 },
  fineFood: { bureaucrat: 1.5, merchant: 1.3, capitalist: 1.4, banker: 1.5, soldier: 1.2, shopkeeper: 1.2 },
  sugar: { capitalist: 1.3, banker: 1.4, merchant: 1.2 },
  luxury: { capitalist: 1.2, banker: 1.3, merchant: 1.2 },
};

/** 省奢侈品潜力（省份文化/财富系数，由经济产出倍率推导，0.5-1.5） */
export function provinceLuxuryPotential(prov: Province): number {
  return clamp(0.5 + prov.productivity * 0.5, 0.5, 1.5);
}
/** 国家财富系数：人口年收入与国库共同决定（0.7-2.2） */
export function luxuryWealthCoef(n: { popWan: number; treasury: number }): number {
  const annualIncome = n.popWan * 3.0; // PER_CAPITA_INCOME 常量内联，避免循环依赖
  return clamp(0.8 + annualIncome / 6000 + Math.max(0, n.treasury) / 8000, LUXURY_WEALTH_MIN, LUXURY_WEALTH_MAX);
}
/** 职业基础年薪（万₭/人/年）；军人/官僚俸禄随军费/行政开支调整（economy 挂钩） */
export const BASE_WAGE: Record<JobId, number> = {
  slave: 1.0,
  peasant: 2.4,
  worker: 3.0,
  technician: 3.4,
  clerk: 3.2,
  engineer: 4.2,
  shopkeeper: 3.5, // 店主：小资产阶级
  soldier: 3.0,
  bureaucrat: 3.8,
  merchant: 4.0,
  capitalist: 5.0,
  banker: 5.5,
};
/** 每格住房容量（万人）——基建可提升 */
export const BASE_HOUSING_PER_CELL = 4.5;
/** 转职代价：该 POP 3 个月产出减半 */
export const RETRAIN_MONTHS = 3;
export const RETRAIN_OUTPUT_PENALTY = 0.5;
/** 技能梯子（生产侧；资本侧 商人→资本家→银行家；店主→商人；军人/官僚为俸禄职业） */
export const JOB_LADDER: Record<JobId, JobId | null> = {
  slave: 'peasant',
  peasant: 'worker',
  worker: 'technician',
  technician: 'engineer',
  clerk: 'engineer',
  engineer: null,
  shopkeeper: 'merchant',
  soldier: null,
  bureaucrat: null,
  merchant: 'capitalist',
  capitalist: 'banker',
  banker: null,
};
/** 旁路转职（v0.9）：工人/职员/店主/工程师可获取军人/官僚资质（转职 UI 展开选项） */
export const JOB_LATERAL: Record<JobId, JobId[]> = {
  worker: ['soldier'],
  clerk: ['bureaucrat'],
  technician: ['bureaucrat'],
  engineer: ['soldier', 'bureaucrat'],
  shopkeeper: ['bureaucrat', 'soldier'],
  peasant: ['soldier'],
  soldier: ['peasant', 'worker'],
  bureaucrat: ['worker', 'clerk'],
  slave: [], merchant: [], capitalist: [], banker: [],
};
/** 技能梯子识字率门槛（资质获取） */
export const LITERACY_REQ: Record<JobId, number> = {
  slave: 0,
  peasant: 0,
  worker: 0.1,
  technician: 0.25,
  clerk: 0.15,
  engineer: 0.5,
  shopkeeper: 0.18,
  soldier: 0.15,
  bureaucrat: 0.2,
  merchant: 0.2,
  capitalist: 0.3,
  banker: 0.4,
};

/** 生活水平预期（v0.9 固定基准：该职业人群的期望生活水准；低于则积累不满并尝试改行） */
export const EXPECTED_STD: Record<JobId, number> = {
  slave: 25,
  peasant: 40,
  worker: 45,
  technician: 50,
  clerk: 52,
  engineer: 60,
  shopkeeper: 55,
  soldier: 50,
  bureaucrat: 65,
  merchant: 58,
  capitalist: 70,
  banker: 75,
};
/** 各国主体种族构成（v0.4 八国，初始化 POP 用；世界观种族分布） */
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
  orange: {
    aegir: 0.8, liberi: 0.08, feline: 0.06, sarkaz: 0.04, zalak: 0.02,
    ursus: 0, draco: 0, norman: 0,
  },
  zalakN: {
    zalak: 0.95, sarkaz: 0.02, feline: 0.02, ursus: 0.01,
    draco: 0, liberi: 0, aegir: 0, norman: 0,
  },
  zalakS: {
    zalak: 0.95, sarkaz: 0.03, liberi: 0.01, feline: 0.01,
    ursus: 0, draco: 0, aegir: 0, norman: 0,
  },
  angland: {
    aegir: 0.45, sarkaz: 0.2, feline: 0.15, liberi: 0.1, zalak: 0.05, norman: 0.03,
    ursus: 0.01, draco: 0.01,
  },
  normandy: {
    norman: 0.85, sarkaz: 0.08, aegir: 0.04, liberi: 0.03,
    ursus: 0, draco: 0, feline: 0, zalak: 0,
  },
};
/** 初始职业构成（工业化前夜；军人/官僚/资本侧少量） */
export const INITIAL_JOB_MIX: Record<JobId, number> = {
  slave: 0.04,
  peasant: 0.44,
  worker: 0.14,
  technician: 0.12,
  clerk: 0.05,
  engineer: 0.04,
  shopkeeper: 0.03,
  soldier: 0.04,
  bureaucrat: 0.03,
  merchant: 0.05,
  capitalist: 0.02,
  banker: 0.01,
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
  /** v0.9 生活水平指数 0-100（实际收入/生活成本 × 0.5 + 满足度 × 0.5） */
  livingStd: number;
  /** v0.9 生活水平预期（EXPECTED_STD 职业基准，固定） */
  expected: number;
  /** v0.9 不满积累（低于预期每点缺口 +1/月；触发自发改行） */
  unrest: number;
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

/** 新建省的聚合 POP（按国家主体种族 × 初始职业构成 × 初始阶级分布；职业与阶级独立） */
export function createProvincePops(
  provincePop: number,
  nationId: NationId,
): Pop[] {
  const raceMix = NATION_RACE_MIX[nationId];
  const classDist = INITIAL_CLASS_DIST[nationId];
  const pops: Pop[] = [];
  for (const race of RACES) {
    const raceShare = raceMix[race] ?? 0;
    if (raceShare <= 0) continue;
    for (const job of JOBS) {
      const jobShare = INITIAL_JOB_MIX[job];
      if (jobShare <= 0) continue;
      for (const c of CLASSES) {
        const w = classDist[c] ?? 0;
        if (w <= 0) continue;
        // 军人/官僚为俸禄职业：不到赤贫/奴役（阶级 1-5；边缘省穷官僚由低行政开支造成）
        if ((job === 'soldier' || job === 'bureaucrat') && c > 5) continue;
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
          livingStd: 50,
          expected: EXPECTED_STD[job],
          unrest: 0,
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

/** 人口增长政策系数已迁移至 tax.ts（policyGrowthCoef，由综合税负推导） */

/** 统计省职业构成（UI 用） */
export function provinceJobMix(p: ProvinceEcon): Record<JobId, number> {
  const mix = zeroJobMix();
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
  const supply = zeroJobMix();
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

/** 农民产出（含资源附加）：沃土修正 × 气候 grainMod；自然经济底子（无建筑也产，不受加强项加成） */
export function farmerOutput(prov: Province, size: number, mult: number): Record<GoodId, number> {
  const out = zeroGoods();
  out.food = size * JOB_OUTPUT_PER_WAN.peasant * provinceFoodMod(prov) * prov.grainMod * mult;
  // 省资源附加：棉/木/渔/盐（沿海）/毛皮（寒带林）/细粮·肉·糖（沃土）
  if (provinceHasResource(prov, 'timber')) out.timber += size * FARMER_EXTRA_OUTPUT.timber * mult;
  if (provinceHasResource(prov, 'cotton')) out.cotton += size * FARMER_EXTRA_OUTPUT.cotton * mult;
  if (provinceCoastal(prov)) {
    out.fish += size * FARMER_EXTRA_OUTPUT.fish * mult;
    out.salt += size * FARMER_EXTRA_OUTPUT.salt * mult;
  }
  if (provinceHasFur(prov)) out.fur += size * FARMER_EXTRA_OUTPUT.fur * mult;
  if (provinceHasResource(prov, 'farmland')) {
    out.wheat += size * FARMER_EXTRA_OUTPUT.wheat * mult;
    out.meat += size * FARMER_EXTRA_OUTPUT.meat * mult;
    out.sugar += size * FARMER_EXTRA_OUTPUT.sugar * mult;
  }
  return out;
}

/** 矿工产出（按矿藏省：煤/铁/铜/硫/石料；无矿藏 → 0，需建矿场） */
export function minerOutput(prov: Province, size: number, mult: number): Record<GoodId, number> {
  const out = zeroGoods();
  if (provinceHasResource(prov, 'coal')) out.coal += size * MINER_OUTPUT.coal * mult;
  if (provinceHasResource(prov, 'iron')) out.ironOre += size * MINER_OUTPUT.ironOre * mult;
  if (provinceHasResource(prov, 'copper')) out.copperOre += size * MINER_OUTPUT.copperOre * mult;
  if (provinceHasResource(prov, 'sulfur')) out.sulfur += size * MINER_OUTPUT.sulfur * mult;
  if (provinceHasResource(prov, 'stone')) out.stone += size * MINER_OUTPUT.stone * mult;
  return out;
}

/** 阶级定义快捷访问 */
export { classDef };
