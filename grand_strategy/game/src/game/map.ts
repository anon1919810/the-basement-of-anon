/**
 * 地图导入器：解析 Azgaar GridCells JSON → 游戏地图。
 * 逻辑与 tools/render_admin.py 保持一致：
 *  - 顶点坐标在 p 字段；陆地 = 海拔 h >= 20
 *  - 省份 = 陆地 BFS 聚簇（同 render_admin）
 *  - 迷雾区 = 大陆质心 x >= 0.6*W（未探明新大陆）
 *  - 国家分配：最大/≥120 格大陆 → 帝国；左部(x<0.42W, y<0.7H)→洛林；
 *    中央右(x>0.45W, y<0.72H)→伊尼亚斯；其余默认洛林占位（可后续手绘）
 */
import raw from '../../../data/kalte_gridcells.json';
import type { BBox, ClimateId, NationId, Point, ProvinceOwner, TerrainKind } from './types';

// ---- 原始 JSON 的宽松类型（避免对 2.7MB JSON 做深度类型推导） ----
interface RawVert {
  i: number;
  p?: number[];
}
interface RawCell {
  i: number;
  v: number[];
  c: number[];
  h?: number;
  temp?: number;
  prec?: number;
}
interface RawMap {
  info?: { width?: number; height?: number; seed?: string };
  cells?: { cells?: RawCell[]; vertices?: RawVert[] };
}
const RAW = raw as RawMap;

// ---- 常量（与 render_admin.py 对齐） ----
export const LAND_H = 20; // 陆地海拔阈值
export const FOG_X_RATIO = 0.6; // 迷雾区：大陆质心 x >= 0.6 * W

export interface CellData {
  id: number;
  polygon: Point[];
  bbox: BBox;
  neighbors: number[];
  h: number;
  temp: number;
  prec: number;
  land: boolean;
  terrain: TerrainKind;
  climate: ClimateId;
  /** 粮食产出倍率（气候×地形） */
  grainMod: number;
  /** 经济产出倍率（气候×地形，用于税收） */
  productivity: number;
}

export interface Province {
  id: number;
  cellIds: number[];
  centroid: Point;
  /** 主导气候（格数最多者） */
  climate: ClimateId;
  climateCells: Record<ClimateId, number>;
  avgTemp: number;
  avgPrec: number;
  terrain: TerrainKind;
  /** 省份粮食产出倍率（格均值） */
  grainMod: number;
  /** 省份经济产出倍率（格均值） */
  productivity: number;
  isUndiscovered: boolean;
  owner: ProvinceOwner;
  /** 大陆块 id（同一连通大陆上的省份共享） */
  landmassId: number;
}

export interface GameMap {
  width: number;
  height: number;
  seed: string;
  cellsById: Map<number, CellData>;
  landCellIds: number[];
  provinces: Province[];
  provinceById: Map<number, Province>;
}

// ---- 气候区推导（temp ℃ / prec 0-100 指数） ----
export function climateOf(temp: number, prec: number): ClimateId {
  if (temp <= -12) return 'arctic'; // 严寒
  if (temp <= 2) return 'coldTemp'; // 寒温
  if (prec <= 8) return 'dry'; // 干旱
  if (prec >= 38) return 'humid'; // 湿润
  return 'temperate'; // 温带
}

export function terrainOf(h: number): TerrainKind {
  if (h >= 70) return 'mountain';
  if (h >= 45) return 'hill';
  return 'plain';
}

// 粮食倍率（气候 × 地形）
const GRAIN_CLIMATE: Record<ClimateId, number> = {
  arctic: 0.3,
  coldTemp: 0.65,
  temperate: 1.0,
  humid: 1.25,
  dry: 0.35,
};
const GRAIN_TERRAIN: Record<TerrainKind, number> = {
  plain: 1.0,
  hill: 0.75,
  mountain: 0.45,
};

// 经济倍率（1 + 气候加成 + 地形加成）
const ECON_CLIMATE: Record<ClimateId, number> = {
  arctic: -0.35,
  coldTemp: -0.15,
  temperate: 0,
  humid: 0.15,
  dry: -0.3,
};
const ECON_TERRAIN: Record<TerrainKind, number> = {
  plain: 0.05,
  hill: 0,
  mountain: -0.25,
};

export const CLIMATE_LABEL: Record<ClimateId, string> = {
  arctic: '严寒',
  coldTemp: '寒温',
  temperate: '温带',
  humid: '湿润',
  dry: '干旱',
};

export const TERRAIN_LABEL: Record<TerrainKind, string> = {
  plain: '平原',
  hill: '丘陵',
  mountain: '高山',
};

function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 查找包含坐标 (x,y) 的陆地格（海洋返回 null） */
export function findCellAt(map: GameMap, x: number, y: number): CellData | null {
  for (const id of map.landCellIds) {
    const cell = map.cellsById.get(id);
    if (!cell) continue;
    const b = cell.bbox;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
    if (pointInPolygon(x, y, cell.polygon)) return cell;
  }
  return null;
}

/** 省份 id → 是否边界格（邻接海洋或异省份） */
export function cellIsBoundary(map: GameMap, cell: CellData, provId: number): boolean {
  for (const nb of cell.neighbors) {
    const nbCell = map.cellsById.get(nb);
    if (!nbCell || !nbCell.land) return true; // 海洋或未知格
    const nbProv = provOfCell(map, nb);
    if (nbProv === undefined || nbProv !== provId) return true;
  }
  return false;
}

let provOfCellCache: Map<number, number> | null = null;
/** 格 → 省份 id（BFS 聚簇结果） */
export function provOfCell(map: GameMap, cellId: number): number | undefined {
  if (!provOfCellCache) {
    provOfCellCache = new Map();
    for (const p of map.provinces) {
      for (const cid of p.cellIds) provOfCellCache.set(cid, p.id);
    }
  }
  return provOfCellCache.get(cellId);
}

let cachedMap: GameMap | null = null;

/** 加载地图（进程内单例） */
export function loadMap(): GameMap {
  if (cachedMap) return cachedMap;
  cachedMap = buildMap(RAW);
  return cachedMap;
}

function buildMap(raw: RawMap): GameMap {
  const width = raw.info?.width ?? 1920;
  const height = raw.info?.height ?? 1080;
  const seed = raw.info?.seed ?? 'unknown';
  const rawCells = raw.cells?.cells ?? [];
  const rawVerts = raw.cells?.vertices ?? [];

  const vertByIndex = new Map<number, Point>();
  for (const v of rawVerts) {
    const p = v.p;
    if (p && p.length >= 2) vertByIndex.set(v.i, { x: p[0], y: p[1] });
  }

  // 格数据
  const cellsById = new Map<number, CellData>();
  const landCellIds: number[] = [];
  for (const rc of rawCells) {
    const pts = (rc.v ?? []).map((vi) => vertByIndex.get(vi)).filter((p): p is Point => !!p);
    if (pts.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const h = rc.h ?? 0;
    const temp = rc.temp ?? 0;
    const prec = rc.prec ?? 0;
    const land = h >= LAND_H;
    const climate = climateOf(temp, prec);
    const terrain = terrainOf(h);
    const cell: CellData = {
      id: rc.i,
      polygon: pts,
      bbox: { minX, minY, maxX, maxY },
      neighbors: rc.c ?? [],
      h,
      temp,
      prec,
      land,
      terrain,
      climate,
      grainMod: GRAIN_CLIMATE[climate] * GRAIN_TERRAIN[terrain],
      productivity: 1 + ECON_CLIMATE[climate] + ECON_TERRAIN[terrain],
    };
    cellsById.set(rc.i, cell);
    if (land) landCellIds.push(rc.i);
  }

  // 省份 = 陆地 BFS 聚簇（与 render_admin 一致）
  const provOfCellId = new Map<number, number>();
  const provCellLists: number[][] = [];
  for (const s of landCellIds) {
    if (provOfCellId.has(s)) continue;
    const pid = provCellLists.length;
    const queue: number[] = [s];
    provOfCellId.set(s, pid);
    provCellLists.push([]);
    const list = provCellLists[pid];
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      list.push(cur);
      const cell = cellsById.get(cur);
      if (!cell) continue;
      for (const nb of cell.neighbors) {
        const nbCell = cellsById.get(nb);
        if (nbCell && nbCell.land && !provOfCellId.has(nb)) {
          provOfCellId.set(nb, pid);
          queue.push(nb);
        }
      }
    }
  }

  // 大陆块：省份级 BFS 连通（省份经格邻接相连）
  const provAdj: Set<number>[] = provCellLists.map(() => new Set<number>());
  provCellLists.forEach((list, pid) => {
    for (const cid of list) {
      const cell = cellsById.get(cid);
      if (!cell) continue;
      for (const nb of cell.neighbors) {
        const p = provOfCellId.get(nb);
        if (p !== undefined && p !== pid) provAdj[pid].add(p);
      }
    }
  });

  const landmassOf = new Map<number, number>();
  const landmassProvLists: number[][] = [];
  provCellLists.forEach((_list, pid) => {
    if (landmassOf.has(pid)) return;
    const lmId = landmassProvLists.length;
    const queue: number[] = [pid];
    landmassOf.set(pid, lmId);
    landmassProvLists.push([]);
    const lp = landmassProvLists[lmId];
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      lp.push(cur);
      for (const nb of provAdj[cur]) {
        if (!landmassOf.has(nb)) {
          landmassOf.set(nb, lmId);
          queue.push(nb);
        }
      }
    }
  });

  const centroidOf = (cids: number[]): Point => {
    let sx = 0, sy = 0;
    for (const cid of cids) {
      const cell = cellsById.get(cid);
      if (!cell) continue;
      let cx = 0, cy = 0;
      for (const p of cell.polygon) {
        cx += p.x;
        cy += p.y;
      }
      sx += cx / cell.polygon.length;
      sy += cy / cell.polygon.length;
    }
    return { x: sx / cids.length, y: sy / cids.length };
  };

  // 大陆块质心与规模
  const lmCentroid = landmassProvLists.map((pl) =>
    centroidOf(pl.flatMap((pid) => provCellLists[pid])),
  );
  const lmSize = landmassProvLists.map((pl) => pl.reduce((s, pid) => s + provCellLists[pid].length, 0));
  const lmSorted = lmSize.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);

  // 国家分配（render_admin 规则的 3 国简化版）
  const ownerOfLandmass = new Map<number, ProvinceOwner>();
  for (const { i, s } of lmSorted) {
    const c = lmCentroid[i];
    if (c.x >= width * FOG_X_RATIO) {
      ownerOfLandmass.set(i, 'undiscovered');
    } else if (i === lmSorted[0].i || s >= 120) {
      ownerOfLandmass.set(i, 'empire'); // 中央/大块 → 帝国
    } else if (c.x < width * 0.42 && c.y < height * 0.7) {
      ownerOfLandmass.set(i, 'lorraine'); // 左 → 洛林
    } else if (c.x > width * 0.45 && c.y < height * 0.72) {
      ownerOfLandmass.set(i, 'ianys'); // 中央右 → 伊尼亚斯
    } else {
      ownerOfLandmass.set(i, 'lorraine'); // 其余 → 洛林占位（可后续手绘）
    }
  }

  // 省份对象
  const provinces: Province[] = provCellLists.map((list, pid) => {
    const lmId = landmassOf.get(pid) as number;
    const climateCells: Record<ClimateId, number> = {
      arctic: 0,
      coldTemp: 0,
      temperate: 0,
      humid: 0,
      dry: 0,
    };
    let tSum = 0, pSum = 0, gSum = 0, eSum = 0;
    const terrCount: Record<TerrainKind, number> = { plain: 0, hill: 0, mountain: 0 };
    for (const cid of list) {
      const cell = cellsById.get(cid) as CellData;
      climateCells[cell.climate]++;
      tSum += cell.temp;
      pSum += cell.prec;
      gSum += cell.grainMod;
      eSum += cell.productivity;
      terrCount[cell.terrain]++;
    }
    const climate = (Object.keys(climateCells) as ClimateId[]).reduce((a, b) =>
      climateCells[b] > climateCells[a] ? b : a,
    );
    const terrain = (Object.keys(terrCount) as TerrainKind[]).reduce((a, b) =>
      terrCount[b] > terrCount[a] ? b : a,
    );
    return {
      id: pid,
      cellIds: list,
      centroid: centroidOf(list),
      climate,
      climateCells,
      avgTemp: tSum / list.length,
      avgPrec: pSum / list.length,
      terrain,
      grainMod: gSum / list.length,
      productivity: eSum / list.length,
      isUndiscovered: ownerOfLandmass.get(lmId) === 'undiscovered',
      owner: ownerOfLandmass.get(lmId) ?? 'lorraine',
      landmassId: lmId,
    };
  });

  const provinceById = new Map<number, Province>();
  for (const p of provinces) provinceById.set(p.id, p);

  provOfCellCache = null; // 缓存失效

  return { width, height, seed, cellsById, landCellIds, provinces, provinceById };
}

/** 调试统计（sim 用） */
export function mapStats(map: GameMap): Record<string, unknown> {
  const nationCells: Record<NationId | 'undiscovered', number> = {
    lorraine: 0,
    ianys: 0,
    empire: 0,
    undiscovered: 0,
  };
  for (const p of map.provinces) {
    nationCells[p.owner] += p.cellIds.length;
  }
  const climateCount: Record<ClimateId, number> = { arctic: 0, coldTemp: 0, temperate: 0, humid: 0, dry: 0 };
  for (const cid of map.landCellIds) {
    const c = map.cellsById.get(cid) as CellData;
    climateCount[c.climate]++;
  }
  return {
    cells: map.cellsById.size,
    landCells: map.landCellIds.length,
    provinces: map.provinces.length,
    undiscoveredProvinces: map.provinces.filter((p) => p.isUndiscovered).length,
    nationCells,
    climateCount,
  };
}
