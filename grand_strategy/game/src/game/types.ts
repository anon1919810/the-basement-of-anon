/** 可玩国家（v0.4：8 国全可玩） */
export type NationId =
  | 'empire' // 申斯戈维克帝国
  | 'lorraine' // 洛林共和国
  | 'ianys' // 伊尼亚斯王国
  | 'orange' // 奥兰治亲王国
  | 'zalakN' // 北扎拉克选帝侯国
  | 'zalakS' // 南扎拉克选帝侯国
  | 'angland' // 盎格伦撒自由城邦
  | 'normandy'; // 诺曼尼亚帝国

/** 气候区（由 temp/prec 推导） */
export type ClimateId = 'arctic' | 'coldTemp' | 'temperate' | 'humid' | 'dry';

/** 地形（由海拔 h 推导） */
export type TerrainKind = 'plain' | 'hill' | 'mountain';

/** 时钟速度：0=暂停，1x/2x/3x */
export type Speed = 0 | 1 | 2 | 3;

/** 省份所有者：三个可玩国或未探明新大陆 */
export type ProvinceOwner = NationId | 'undiscovered';

/** 种族（八族，人形兽耳） */
export type RaceId =
  | 'ursus'
  | 'draco'
  | 'feline'
  | 'liberi'
  | 'aegir'
  | 'zalak'
  | 'sarkaz'
  | 'norman';

/** 职业（技能梯子：农民→矿工→工匠→工程师） */
export type JobId = 'farmer' | 'miner' | 'artisan' | 'engineer';

/**
 * 商品（v0.9 五部门：资源 → 半成品 → 成品，36 种）。
 */
export type GoodId =
  // 资源（16）
  | 'food' // 粗粮（黑麦级）
  | 'wheat' // 小麦（高端谷物）
  | 'cotton' // 棉花
  | 'fur' // 皮毛
  | 'timber' // 木材
  | 'coal' // 煤炭
  | 'ironOre' // 铁矿石
  | 'copperOre' // 铜矿石
  | 'sulfur' // 硫矿石
  | 'salt' // 盐
  | 'fish' // 渔获
  | 'meat' // 肉类
  | 'stone' // 石料
  | 'oil' // 油（捕鲸）
  | 'coffee' // 咖啡（成瘾物）
  | 'tobacco' // 烟草（成瘾物）
  // 半成品（11）
  | 'lumber' // 木料
  | 'cloth' // 布料
  | 'iron' // 铁锭
  | 'copper' // 铜锭
  | 'steel' // 钢
  | 'flour' // 面粉
  | 'sugar' // 糖
  | 'leather' // 皮革
  | 'gunpowder' // 火药
  | 'dynamite' // 炸药
  | 'machines' // 机器
  // 成品（9）
  | 'tools' // 工具
  | 'swords' // 刀剑
  | 'muskets' // 燧发枪
  | 'cannons' // 火炮
  | 'sailShip' // 帆船
  | 'clothing' // 服装
  | 'fineFood' // 高级食物
  | 'luxury' // 奢侈品
  | 'transport'; // 运力（基建产出）

/**
 * 阶级（v0.3，7 级，数字越小越上层）。
 * 1 大贵族·大资本家·大地主 → 2 大银行家·贵族·资本家 → 3 技术阶层·官僚·地主·教士
 * → 4 职员·工匠·富农·市民 → 5 自耕农·工人 → 6 无业游民·佃农 → 7 奴隶
 */
export type ClassId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 需求四件套 */
export type NeedId = 'food' | 'clothing' | 'housing' | 'fuel';

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
