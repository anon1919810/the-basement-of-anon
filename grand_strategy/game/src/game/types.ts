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

/** 商品（国家市场流通物；奢侈品留 v0.2） */
export type GoodId = 'food' | 'clothing' | 'fuel' | 'industrial';

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
