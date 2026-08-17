/**
 * 物流运输（v0.1）：
 *  - 跨省调运运费 = 距离 × 地形系数（山地贵、沿海便宜），同省内免运费
 *  - 基建（道路/港口）降运费：运费 /= (1 + roads*0.03 + ports*0.02)
 *  - 运费经「可负担系数」压低 POP 幸福度 → 效率 → 产能（基建 → 良性循环）
 */
import type { GameMap, Province } from './map';
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

/** 各省距首都的像素距离 / 100（抽象距离单位） */
export function provinceDistance(_map: GameMap, a: Province, b: Province): number {
  const dx = a.centroid.x - b.centroid.x;
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
