/** 可玩国家 */
export type NationId = 'lorraine' | 'ianys' | 'empire';

/** 气候区（由 temp/prec 推导） */
export type ClimateId = 'arctic' | 'coldTemp' | 'temperate' | 'humid' | 'dry';

/** 地形（由海拔 h 推导） */
export type TerrainKind = 'plain' | 'hill' | 'mountain';

/** 税率档位 */
export type TaxLevel = 'light' | 'medium' | 'heavy' | 'oppressive';

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
 * 商品（v0.3 产业链：资源 → 半成品 → 工业制成品）。
 * v0.2 兼容：fuel → coal（燃料并入煤炭）；industrial 拆分为 iron/steel/tools/weapons/sailShip/lumber/cloth。
 */
export type GoodId =
  // 资源
  | 'food' // 粮食
  | 'timber' // 木材
  | 'cotton' // 棉花
  | 'fur' // 毛皮（寒带林产出）
  | 'coal' // 煤炭（原 fuel）
  | 'ironOre' // 铁矿石
  | 'salt' // 盐
  | 'fish' // 渔获
  // 半成品
  | 'lumber' // 木料
  | 'cloth' // 布料
  | 'iron' // 铁锭
  | 'steel' // 钢材
  // 成品
  | 'tools' // 工具
  | 'weapons' // 武器
  | 'sailShip' // 帆船
  | 'clothing' // 衣物
  | 'luxury'; // 奢侈品

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
