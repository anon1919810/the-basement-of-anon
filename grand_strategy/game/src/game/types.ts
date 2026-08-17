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
