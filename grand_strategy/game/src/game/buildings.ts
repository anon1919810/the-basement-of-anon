/**
 * 建筑投资（v0.9 五部门经济）：农业/矿业/加工/工业/基建，42 种建筑。
 *
 *  - 配方语法：inputs=必输（都要）；anyOf=任一输入即可；opt=可选加强项（不输入也正常产出，启用提效）
 *  - 多输出：output2（如 牲畜农场 肉+皮毛）；变体产线：variants（兵工厂 刀剑/燧发枪/火炮）
 *  - 服务类建筑（学校/银行/市场）无 output：提供加成（识字率/资本/贸易），阶段 C/D 接入
 *  - 加工损耗：输出 < 输入量，价值随加工链上升
 *  - 技能链：farmer/miner/artisan/engineer（职业三分后扩展，见设计文档 v0.9 第十节）
 */
import type { GameMap, Province } from './map';
import { isCoastal } from './logistics';
import type { GameState } from './state';
import type { GoodId, JobId } from './types';
import { provinceHasResource } from './resources';
import { zeroGoods } from './market';

export type BuildingKind =
  // 农业（9）
  | 'cottonFarm' | 'wheatFarm' | 'ryeFarm' | 'beetFarm' | 'caneFarm'
  | 'coffeeFarm' | 'tobaccoFarm' | 'livestockFarm' | 'fishFarm'
  // 矿业与开采业（8）
  | 'lumberCamp' | 'quarry' | 'ironMine' | 'coalMine' | 'sulfurMine'
  | 'copperMine' | 'saltMine' | 'whalingStation'
  // 加工业一级（8）
  | 'sawmill' | 'textile' | 'ironWorks' | 'copperWorks' | 'mill'
  | 'sugarWorks' | 'gunpowderWorks' | 'tannery'
  // 加工业二级（4）
  | 'steelWorks' | 'clothingWorks' | 'foodFactory' | 'luxuryWorkshop'
  // 工业（5）
  | 'toolWorks' | 'armory' | 'shipyard' | 'dynamiteWorks' | 'machineWorks'
  // 基建与公共服务（8）
  | 'road' | 'railroad' | 'canal' | 'port' | 'lighthouse'
  | 'school' | 'bank' | 'market';

export type BuildingCategory = 'agriculture' | 'extraction' | 'processing' | 'heavy' | 'fine' | 'infra';

export interface BuildingVariant {
  label: string;
  output: GoodId;
  /** 必输（都要） */
  inputs: Partial<Record<GoodId, number>>;
  /** 任一输入即可 */
  anyOf?: GoodId[];
  /** 可选加强项（不输入也正常产出，输入提效） */
  opt?: Partial<Record<GoodId, number>>;
}

export interface BuildingDef {
  kind: BuildingKind;
  label: string;
  category: BuildingCategory;
  /** 技能要求（对应职业 POP；职业三分后扩展） */
  skill: JobId;
  /** 必输输入（每月单位，按满产能；'+'=都要） */
  inputs: Partial<Record<GoodId, number>>;
  /** 任一输入即可（'、'=任一） */
  anyOf?: GoodId[];
  /** 可选加强项（'/' 斜杠项；不输入也能正常产出，输入则提效） */
  opt?: Partial<Record<GoodId, number>>;
  /** 主输出商品（服务类建筑可空） */
  output?: GoodId;
  /** 第二输出（如 牲畜农场 皮毛） */
  output2?: GoodId;
  /** 输出比例（output2 相对 output 的每月量） */
  output2Rate?: number;
  /** 变体产线（兵工厂三武器） */
  variants?: BuildingVariant[];
  /** 满产能月产出（单位/月，同时进入市场供给） */
  capacity: number;
  /** 建造成本（万₭） */
  cost: number;
  /** 工期（月） */
  duration: number;
  /** 单位运营成本（万₭/月，闲置时按维护比例计） */
  opCost: number;
  /** 基建门槛 */
  infra: { roads?: number; ports?: number };
  /** 省资源解锁条件 */
  requireResource?: 'coal' | 'iron' | 'cotton' | 'timber' | 'copper' | 'sulfur' | 'stone' | 'farmland' | 'salt';
  /** 半成品解锁条件（国家已有该商品产出/库存） */
  requireGood?: GoodId;
  /** 识字率门槛 */
  requireLiteracy?: number;
  /** 需沿海 */
  requireCoastal?: boolean;
  desc: string;
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  // ==================== 农业（9）====================
  cottonFarm: {
    kind: 'cottonFarm', label: '棉田', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'cotton', capacity: 1.6,
    cost: 100, duration: 5, opCost: 0.35, infra: {}, requireResource: 'cotton',
    desc: '暖湿平原植棉，纺织业原料之源。',
  },
  wheatFarm: {
    kind: 'wheatFarm', label: '小麦农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'wheat', capacity: 1.8,
    cost: 110, duration: 5, opCost: 0.35, infra: {}, requireResource: 'farmland',
    desc: '细粮：更高等的食物，磨坊/食品场上游。',
  },
  ryeFarm: {
    kind: 'ryeFarm', label: '黑麦农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'food', capacity: 2.0,
    cost: 80, duration: 4, opCost: 0.3, infra: {}, requireResource: 'farmland',
    desc: '粗粮：基础口粮，耐寒耐贫瘠。',
  },
  beetFarm: {
    kind: 'beetFarm', label: '甜菜农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'sugar', capacity: 1.0,
    cost: 100, duration: 5, opCost: 0.35, infra: {}, requireResource: 'farmland',
    desc: '糖料：较高纬度可种但产量低。',
  },
  caneFarm: {
    kind: 'caneFarm', label: '甘蔗农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'sugar', capacity: 2.2,
    cost: 140, duration: 6, opCost: 0.45, infra: {}, requireResource: 'cotton',
    desc: '糖料：仅低纬度暖湿可种，产量高。',
  },
  coffeeFarm: {
    kind: 'coffeeFarm', label: '咖啡农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'coffee', capacity: 1.2,
    cost: 150, duration: 6, opCost: 0.5, infra: {}, requireResource: 'cotton',
    desc: '成瘾物：需求刚性、缺货暴怒、适合高税。',
  },
  tobaccoFarm: {
    kind: 'tobaccoFarm', label: '烟草农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'tobacco', capacity: 1.4,
    cost: 140, duration: 6, opCost: 0.45, infra: {}, requireResource: 'farmland',
    desc: '成瘾物：工人烟瘾大（消费矩阵 ×1.6）。',
  },
  livestockFarm: {
    kind: 'livestockFarm', label: '牲畜农场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1 }, output: 'meat', output2: 'fur', output2Rate: 0.4,
    capacity: 1.4, cost: 130, duration: 6, opCost: 0.5, infra: {}, requireResource: 'farmland',
    desc: '肉 + 皮毛，草场畜牧业。',
  },
  fishFarm: {
    kind: 'fishFarm', label: '渔场', category: 'agriculture', skill: 'peasant',
    inputs: {}, opt: { tools: 0.2, transport: 0.1, sailShip: 0.2 }, output: 'meat', capacity: 1.5,
    cost: 90, duration: 4, opCost: 0.3, infra: {}, requireCoastal: true,
    desc: '近海捕捞，沿海肉食来源。',
  },
  // ==================== 矿业与开采业（8）====================
  lumberCamp: {
    kind: 'lumberCamp', label: '伐木场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.2, transport: 0.2 }, output: 'timber', capacity: 2.2,
    cost: 80, duration: 4, opCost: 0.3, infra: {}, requireResource: 'timber',
    desc: '林地采伐，建材与造纸之源。',
  },
  quarry: {
    kind: 'quarry', label: '采石场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, transport: 0.3, dynamite: 0.2 }, output: 'stone', capacity: 2.4,
    cost: 90, duration: 4, opCost: 0.35, infra: {}, requireResource: 'stone',
    desc: '石料：基建（公路/铁路/港口）的骨料。',
  },
  ironMine: {
    kind: 'ironMine', label: '铁矿场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, transport: 0.3, dynamite: 0.2 }, output: 'ironOre', capacity: 1.8,
    cost: 180, duration: 7, opCost: 0.65, infra: { roads: 10 }, requireResource: 'iron',
    desc: '铁矿石，重工业命脉。',
  },
  coalMine: {
    kind: 'coalMine', label: '煤矿场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, transport: 0.3, dynamite: 0.2 }, output: 'coal', capacity: 2.0,
    cost: 160, duration: 6, opCost: 0.6, infra: { roads: 10 }, requireResource: 'coal',
    desc: '煤炭：冶炼/取暖/蒸汽之源。',
  },
  sulfurMine: {
    kind: 'sulfurMine', label: '硫矿场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, transport: 0.3, dynamite: 0.2 }, output: 'sulfur', capacity: 1.4,
    cost: 170, duration: 7, opCost: 0.6, infra: { roads: 10 }, requireResource: 'sulfur',
    desc: '硫磺：火药/炸药上游。',
  },
  copperMine: {
    kind: 'copperMine', label: '铜矿场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, transport: 0.3, dynamite: 0.2 }, output: 'copperOre', capacity: 1.6,
    cost: 190, duration: 7, opCost: 0.65, infra: { roads: 10 }, requireResource: 'copper',
    desc: '铜矿石：铜锭/机器/银行上游。',
  },
  saltMine: {
    kind: 'saltMine', label: '盐矿场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.2, transport: 0.2, dynamite: 0.15 }, output: 'salt', capacity: 2.2,
    cost: 100, duration: 5, opCost: 0.4, infra: {}, requireResource: 'salt',
    desc: '内陆/沿海均可采盐。',
  },
  whalingStation: {
    kind: 'whalingStation', label: '捕鲸场', category: 'extraction', skill: 'worker',
    inputs: {}, opt: { tools: 0.3, sailShip: 0.3 }, output: 'oil', output2: 'meat', output2Rate: 0.5,
    capacity: 1.2, cost: 200, duration: 8, opCost: 0.8, infra: {}, requireCoastal: true,
    desc: '鲸油 + 鲸肉，油是火药/化工加强项。',
  },
  // ==================== 加工业 · 一级（8）====================
  sawmill: {
    kind: 'sawmill', label: '锯木厂', category: 'processing', skill: 'technician',
    inputs: { timber: 2.0 }, opt: { tools: 0.3 }, output: 'lumber', capacity: 1.6,
    cost: 90, duration: 4, opCost: 0.5, infra: {}, requireResource: 'timber',
    desc: '木材 → 木料（损耗 20%），造船/基建建材。',
  },
  textile: {
    kind: 'textile', label: '纺织厂', category: 'processing', skill: 'technician',
    inputs: { cotton: 2.0 }, opt: { tools: 0.3 }, output: 'cloth', capacity: 1.5,
    cost: 150, duration: 6, opCost: 0.8, infra: { roads: 10 },
    desc: '棉花 → 布料（损耗 25%），衣物/船帆/奢侈品中间品。',
  },
  ironWorks: {
    kind: 'ironWorks', label: '炼铁厂', category: 'heavy', skill: 'engineer',
    inputs: { ironOre: 2.0, coal: 1.0 }, opt: { tools: 0.3, machines: 0.2, transport: 0.3 },
    output: 'iron', capacity: 2.0, cost: 200, duration: 8, opCost: 1.1, infra: { roads: 15 },
    desc: '铁矿石＋煤 → 铁锭；需煤矿省或港口（进口矿）。',
  },
  copperWorks: {
    kind: 'copperWorks', label: '炼铜厂', category: 'heavy', skill: 'engineer',
    inputs: { copperOre: 2.0, coal: 1.0 }, opt: { tools: 0.3, machines: 0.2, transport: 0.3 },
    output: 'copper', capacity: 2.0, cost: 210, duration: 8, opCost: 1.1, infra: { roads: 15 },
    desc: '铜矿石＋煤 → 铜锭；机器/银行/船坞上游。',
  },
  mill: {
    kind: 'mill', label: '磨坊', category: 'processing', skill: 'technician',
    inputs: {}, anyOf: ['wheat', 'food'], opt: { tools: 0.2 }, output: 'flour', capacity: 1.4,
    cost: 70, duration: 3, opCost: 0.3, infra: {},
    desc: '小麦 或 黑麦 → 面粉；食品场上游。',
  },
  sugarWorks: {
    kind: 'sugarWorks', label: '制糖厂', category: 'processing', skill: 'technician',
    inputs: { sugar: 1.5 }, opt: { tools: 0.2 }, output: 'sugar', capacity: 1.8,
    cost: 110, duration: 5, opCost: 0.5, infra: {},
    desc: '糖料精炼 → 白糖；上层嗜甜。',
  },
  gunpowderWorks: {
    kind: 'gunpowderWorks', label: '火药厂', category: 'heavy', skill: 'technician',
    inputs: { sulfur: 1.2 }, opt: { tools: 0.2, machines: 0.2, oil: 0.2 }, output: 'gunpowder', capacity: 1.6,
    cost: 160, duration: 6, opCost: 0.8, infra: {},
    desc: '硫磺 → 火药；燧发枪/火炮/炸药上游。',
  },
  tannery: {
    kind: 'tannery', label: '制革场', category: 'processing', skill: 'technician',
    inputs: { fur: 1.5 }, opt: { tools: 0.2, machines: 0.15 }, output: 'leather', capacity: 1.5,
    cost: 120, duration: 5, opCost: 0.6, infra: {},
    desc: '毛皮 → 皮革；服装/奢侈品原料。',
  },
  // ==================== 加工业 · 二级（4）====================
  steelWorks: {
    kind: 'steelWorks', label: '炼钢厂', category: 'heavy', skill: 'engineer',
    inputs: { iron: 2.0, coal: 1.0 }, opt: { tools: 0.3, machines: 0.2, transport: 0.3 },
    output: 'steel', capacity: 2.0, cost: 240, duration: 9, opCost: 1.3, infra: { roads: 15 },
    requireGood: 'iron', desc: '铁锭＋煤 → 钢；工具/武器/铁路上游。',
  },
  clothingWorks: {
    kind: 'clothingWorks', label: '服装厂', category: 'fine', skill: 'technician',
    inputs: {}, anyOf: ['cloth', 'fur'], opt: { tools: 0.2, machines: 0.15 },
    output: 'clothing', capacity: 1.6, cost: 130, duration: 5, opCost: 0.7, infra: {},
    desc: '布料 或 毛皮 → 服装；大众刚需。',
  },
  foodFactory: {
    kind: 'foodFactory', label: '食品场', category: 'fine', skill: 'technician',
    inputs: {}, anyOf: ['flour', 'sugar', 'meat'], opt: { tools: 0.2 }, output: 'fineFood', capacity: 1.4,
    cost: 140, duration: 6, opCost: 0.7, infra: {},
    desc: '面粉/糖/肉 → 高级食物；上层餐桌。',
  },
  luxuryWorkshop: {
    kind: 'luxuryWorkshop', label: '奢侈品工坊', category: 'fine', skill: 'engineer',
    inputs: {}, anyOf: ['cloth', 'fur'], opt: { tools: 0.2, machines: 0.15 },
    output: 'luxury', capacity: 0.8, cost: 280, duration: 10, opCost: 1.3, infra: {},
    requireLiteracy: 0.55, desc: '精工 → 奢侈品；需高识字率工匠，供上层。',
  },
  // ==================== 工业（5）====================
  toolWorks: {
    kind: 'toolWorks', label: '工具厂', category: 'fine', skill: 'engineer',
    inputs: { iron: 1.5 }, anyOf: ['machines', 'steel'], opt: { transport: 0.2 },
    output: 'tools', capacity: 1.5, cost: 220, duration: 8, opCost: 1.2, infra: {},
    requireGood: 'iron', desc: '铁锭（/机器/钢）→ 工具；一切加强项的钥匙。',
  },
  armory: {
    kind: 'armory', label: '兵工厂', category: 'fine', skill: 'engineer',
    inputs: { iron: 1.0 }, output: 'swords', capacity: 1.2, cost: 260, duration: 10, opCost: 1.4,
    infra: {}, requireGood: 'iron',
    variants: [
      { label: '刀剑', output: 'swords', inputs: { iron: 1.0 }, anyOf: ['steel'], opt: { transport: 0.2 } },
      { label: '燧发枪', output: 'muskets', inputs: { iron: 1.0, gunpowder: 0.8 }, opt: { machines: 0.15 } },
      { label: '火炮', output: 'cannons', inputs: { iron: 1.5, gunpowder: 1.0 }, opt: { machines: 0.2 } },
    ],
    desc: '三产线：刀剑（铁/钢）、燧发枪、火炮（铁＋火药）。',
  },
  shipyard: {
    kind: 'shipyard', label: '造船厂', category: 'fine', skill: 'engineer',
    inputs: { lumber: 1.0, iron: 1.0, cloth: 1.0, copper: 0.5 }, opt: { tools: 0.3, oil: 0.3 },
    output: 'sailShip', capacity: 1.0, cost: 320, duration: 12, opCost: 1.5,
    infra: { ports: 15 }, requireCoastal: true,
    desc: '木料＋铁锭＋布料＋铜锭 → 帆船；海军与贸易。',
  },
  dynamiteWorks: {
    kind: 'dynamiteWorks', label: '炸药厂', category: 'fine', skill: 'engineer',
    inputs: { gunpowder: 1.0 }, opt: { machines: 0.15 }, output: 'dynamite', capacity: 1.5,
    cost: 170, duration: 6, opCost: 0.9, infra: {},
    desc: '火药 → 炸药；矿场/采石加强项。',
  },
  machineWorks: {
    kind: 'machineWorks', label: '机器厂', category: 'fine', skill: 'engineer',
    inputs: { steel: 1.5, tools: 0.5 }, output: 'machines', capacity: 1.2,
    cost: 280, duration: 10, opCost: 1.3, infra: {}, requireGood: 'steel',
    desc: '钢＋工具 → 机器；工业化的心脏。',
  },
  // ==================== 基建与公共服务（8）====================
  road: {
    kind: 'road', label: '公路', category: 'infra', skill: 'technician',
    inputs: { stone: 1.0, timber: 0.8 }, opt: { tools: 0.2 }, output: 'transport', capacity: 2.0,
    cost: 120, duration: 6, opCost: 0.5, infra: {},
    desc: '产运力：平原效率 ×1.4（地形乘数）。',
  },
  railroad: {
    kind: 'railroad', label: '铁路', category: 'infra', skill: 'engineer',
    inputs: { steel: 1.0, iron: 1.0, stone: 0.8 }, opt: { tools: 0.3, machines: 0.2 },
    output: 'transport', capacity: 3.0, cost: 300, duration: 12, opCost: 1.0, infra: {},
    requireGood: 'steel', desc: '产运力：山地效率 ×1.6；重工业时代主力。',
  },
  canal: {
    kind: 'canal', label: '运河', category: 'infra', skill: 'technician',
    inputs: { stone: 1.0, timber: 0.8 }, opt: { tools: 0.2, machines: 0.15 },
    output: 'transport', capacity: 1.5, cost: 200, duration: 9, opCost: 0.6, infra: {},
    desc: '水路廉价运力；连接水域省。',
  },
  port: {
    kind: 'port', label: '港口', category: 'infra', skill: 'technician',
    inputs: { stone: 1.0, timber: 0.8, steel: 0.5 }, output: 'transport', capacity: 2.5,
    cost: 260, duration: 10, opCost: 0.9, infra: { ports: 15 }, requireCoastal: true,
    desc: '产运力 + 贸易容量（出口权联动）。',
  },
  lighthouse: {
    kind: 'lighthouse', label: '灯塔', category: 'infra', skill: 'technician',
    inputs: { stone: 0.8 }, opt: { tools: 0.15 }, output: 'transport', capacity: 0.8,
    cost: 100, duration: 5, opCost: 0.3, infra: {}, requireCoastal: true,
    desc: '轻量运力与贸易加成，便宜。',
  },
  school: {
    kind: 'school', label: '学校', category: 'infra', skill: 'technician',
    inputs: { lumber: 0.8, stone: 0.8 }, output: undefined, capacity: 0,
    cost: 150, duration: 6, opCost: 0.5, infra: {},
    desc: '公共服务：识字率↑ → 职员/技术工人资质（C 阶段接入）。',
  },
  bank: {
    kind: 'bank', label: '银行', category: 'infra', skill: 'technician',
    inputs: { stone: 0.8, copper: 0.5 }, output: undefined, capacity: 0,
    cost: 220, duration: 8, opCost: 0.8, infra: {},
    desc: '公共服务：资本积累速度↑（私营扩张加速，D 阶段接入）。',
  },
  market: {
    kind: 'market', label: '市场', category: 'infra', skill: 'technician',
    inputs: { lumber: 0.8, stone: 0.8 }, output: undefined, capacity: 0,
    cost: 130, duration: 5, opCost: 0.4, infra: {},
    desc: '公共服务：贸易容量↑、价格传导更顺（B 阶段接入）。',
  },
};

export const BUILDING_KINDS: BuildingKind[] = [
  'cottonFarm', 'wheatFarm', 'ryeFarm', 'beetFarm', 'caneFarm',
  'coffeeFarm', 'tobaccoFarm', 'livestockFarm', 'fishFarm',
  'lumberCamp', 'quarry', 'ironMine', 'coalMine', 'sulfurMine',
  'copperMine', 'saltMine', 'whalingStation',
  'sawmill', 'textile', 'ironWorks', 'copperWorks', 'mill',
  'sugarWorks', 'gunpowderWorks', 'tannery',
  'steelWorks', 'clothingWorks', 'foodFactory', 'luxuryWorkshop',
  'toolWorks', 'armory', 'shipyard', 'dynamiteWorks', 'machineWorks',
  'road', 'railroad', 'canal', 'port', 'lighthouse',
  'school', 'bank', 'market',
];

/** 建筑技能需求规模（万人）：产能 × 0.3，至少 0.2 万 */
export function buildingSkillReqPop(def: BuildingDef): number {
  return Math.max(0.2, def.capacity * 0.3);
}

export interface InvestmentProject {
  id: number;
  kind: BuildingKind;
  provId: number;
  totalCost: number;
  duration: number;
  monthsLeft: number;
  status: 'building' | 'active';
  /** 兵工厂产线（未选 = 主输出） */
  variant?: number;
  // ---- 建筑运营记录（UI/断言用） ----
  /** 上月技能满足系数 0-1（无对应职业 POP → <1 产能打折） */
  lastSkillFactor: number;
  /** 上月输入可用系数 0-1（库存不足 → 减产） */
  lastRunFactor: number;
  /** 上月实际产出 */
  lastOutput: number;
  /** 上月输入消耗（单位，守恒断言用） */
  lastInputUsed: Record<GoodId, number>;
  /** 上月输入成本（万₭） */
  lastInputCost: number;
  /** 上月产出收入（万₭） */
  lastRevenue: number;
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
}

export interface NationBuildingView {
  stocks: Record<GoodId, number>;
  projects: InvestmentProject[];
  literacy: number;
}

/** 半成品解锁判定：国家库存 > 0.5 或有在产建筑产出该商品 */
export function nationHasGood(view: NationBuildingView, g: GoodId): boolean {
  if ((view.stocks[g] ?? 0) > 0.5) return true;
  return view.projects.some((p) => {
    const def = BUILDING_DEFS[p.kind];
    if (!def.output) return false;
    if (def.output === g) return true;
    return (def.variants ?? [])[p.variant ?? 0]?.output === g;
  });
}

/** 省份/基建/资源/半成品解锁检查（UI 与 sim 共用） */
export function buildingUnlock(
  map: GameMap, kind: BuildingKind, prov: Province,
  infra: { roads: number; ports: number }, nation: NationBuildingView,
): UnlockResult {
  const def = BUILDING_DEFS[kind];
  if (infra.roads < (def.infra.roads ?? 0)) return { ok: false, reason: `道路需 ≥${def.infra.roads}` };
  if (infra.ports < (def.infra.ports ?? 0)) return { ok: false, reason: `港口需 ≥${def.infra.ports}` };
  if (def.requireCoastal && !isCoastal(map, prov)) return { ok: false, reason: '需沿海省份' };
  if (def.requireResource && !provinceHasResource(prov, def.requireResource)) {
    return { ok: false, reason: `需省资源「${def.requireResource}」` };
  }
  if (def.requireGood && !nationHasGood(nation, def.requireGood)) {
    return { ok: false, reason: `需本国已产「${def.requireGood}」` };
  }
  if (def.requireLiteracy !== undefined && nation.literacy < def.requireLiteracy) {
    return { ok: false, reason: `识字率需 ≥${(def.requireLiteracy * 100).toFixed(0)}%` };
  }
  // 炼铁厂特殊：煤矿省或港口（进口矿）
  if (kind === 'ironWorks' && !provinceHasResource(prov, 'coal') && infra.ports < 15) {
    return { ok: false, reason: '需煤矿省或港口≥15' };
  }
  return { ok: true };
}

export function projectProgress(p: InvestmentProject): number {
  return clamp01(1 - p.monthsLeft / Math.max(1, p.duration));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function provAvgH(map: GameMap, prov: Province): number {
  let s = 0, n = 0;
  for (const cid of prov.cellIds) {
    const c = map.cellsById.get(cid);
    if (c) { s += c.h; n++; }
  }
  return n ? s / n : 0;
}

/** 地形造价系数（v0.9）：山地施工难 → 铁路/公路造价↑；运河旱地挖河贵 */
export function terrainCostFactor(map: GameMap, kind: BuildingKind, prov: Province): number {
  const mountainous = provAvgH(map, prov) >= 28;
  switch (kind) {
    case 'railroad': return mountainous ? 1.5 : 1.0;
    case 'road': return mountainous ? 1.3 : 1.0;
    case 'canal': return 1.3;
    default: return 1.0;
  }
}

/** 新建建筑项目（立即从国库扣除成本；失败返回 null） */
export function startInvestment(state: GameState, map: GameMap, kind: BuildingKind, provId: number, variant?: number): InvestmentProject | null {
  const n = state.nations[state.playerNation];
  const def = BUILDING_DEFS[kind];
  const prov = map.provinceById.get(provId);
  if (!prov) return null;
  const unlock = buildingUnlock(map, kind, prov, n.infra, { stocks: n.stocks, projects: n.projects, literacy: n.literacy });
  if (!unlock.ok) return null;
  const cost = def.cost * terrainCostFactor(map, kind, prov); // 地形造价（山地基建贵）
  if (n.treasury < cost) return null;
  n.treasury -= cost;
  n.investCostAcc += cost;
  const p: InvestmentProject = {
    id: n.nextProjectId++,
    kind,
    provId,
    totalCost: cost,
    duration: def.duration,
    monthsLeft: def.duration,
    status: 'building',
    variant,
    lastSkillFactor: 0,
    lastRunFactor: 0,
    lastOutput: 0,
    lastInputUsed: zeroGoods(),
    lastInputCost: 0,
    lastRevenue: 0,
  };
  n.projects.push(p);
  return p;
}

/** 取消在建项目：退款 = 总成本 × (1 - 进度)，退回国库 */
export function cancelInvestment(state: GameState, projectId: number): number | null {
  const n = state.nations[state.playerNation];
  const idx = n.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const p = n.projects[idx];
  if (p.status !== 'building') return null; // 已投产不可取消
  const refund = p.totalCost * (1 - projectProgress(p));
  n.treasury += refund;
  n.investRefundAcc += refund;
  n.projects.splice(idx, 1);
  return refund;
}
