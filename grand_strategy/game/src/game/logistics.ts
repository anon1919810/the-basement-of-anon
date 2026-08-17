/**
 * 物流运输（v0.1 / v0.6 循环地图）：
 *  - 跨省调运运费 = 距离 × 地形系数（山地贵、沿海便宜），同省内免运费
 *  - 基建（道路/港口）降运费：运费 /= (1 + roads*0.03 + ports*0.02)
 *  - 运费经「可负担系数」压低 POP 幸福度 → 效率 → 产能（基建 → 良性循环）
 *  - v0.6：所有省距按「东西环绕」计算（dx = min(|x1-x2|, W-|x1-x2|)）
 */
import { wrappedDx } from './map';
import type { GameMap, County, Province } from './map';
import type { NationState } from './state';
import type { TerrainKind } from './types';

export const TERRAIN_FREIGHT: Record<TerrainKind, number> = {
  plain: 1.0,
  hill: 1.25,
  mountain: 1.8,
};

/** 沿海系数（邻接海洋 → 走海路便宜） */
export const COASTAL_FREIGHT = 0.85;
export const INLAND_FREIGHT = 1.15;

/** 各省距首都的环绕像素距离 / 100（抽象距离单位；东西环绕） */
export function provinceDistance(map: GameMap, a: Province, b: Province): number {
  const dx = wrappedDx(a.centroid.x, b.centroid.x, map.width);
  const dy = a.centroid.y - b.centroid.y;
  return Math.sqrt(dx * dx + dy * dy) / 100;
}

/** 省是否沿海（格邻接海洋） */
export function isCoastal(map: GameMap, prov: Province): boolean {
  for (const cid of prov.cellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell) continue;
    for (const nb of cell.neighbors) {
      const nbCell = map.cellsById.get(nb);
      if (nbCell && !nbCell.land) return true;
    }
  }
  return false;
}

/**
 * 省运费系数：跨省距离 × 地形 × 海陆，除以基建减免。
 * 返回 0 表示即首都本地（省内免运费）。
 */
export function provinceFreightFactor(
  map: GameMap,
  prov: Province,
  capital: Province | null,
  infra: NationState['infra'],
): number {
  if (!capital) return 1;
  const dist = provinceDistance(map, capital, prov);
  const coastal = isCoastal(map, prov);
  const geo = TERRAIN_FREIGHT[prov.terrain] * (coastal ? COASTAL_FREIGHT : INLAND_FREIGHT);
  const infraCut = 1 + infra.roads * 0.03 + infra.ports * 0.02;
  return ((0.6 + dist) * geo) / infraCut;
}

/**
 * 县省内运费系数（v0.2 区域市场）：县质心 → 省质心环绕距离 × 地形 × 海陆，除以基建减免。
 * 用于县↔省调运定价（本地市场自身无运费）。
 */
export function countyFreightFactor(
  map: GameMap,
  county: County,
  prov: Province,
  infra: NationState['infra'],
): number {
  const dx = wrappedDx(county.center.x, prov.centroid.x, map.width);
  const dy = county.center.y - prov.centroid.y;
  const dist = Math.sqrt(dx * dx + dy * dy) / 100;
  const coastal = isCoastal(map, prov);
  const geo = TERRAIN_FREIGHT[prov.terrain] * (coastal ? COASTAL_FREIGHT : INLAND_FREIGHT);
  const infraCut = 1 + infra.roads * 0.03 + infra.ports * 0.02;
  return ((0.3 + dist) * geo) / infraCut;
}
