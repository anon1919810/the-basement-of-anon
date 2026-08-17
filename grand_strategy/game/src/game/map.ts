/**
 * 地图导入器（v0.6 省份重构 + 循环地图）：
 * 层级：cell（格）→ county（县）→ province（省）→ 国家辖区
 *  - cell：原始网格（陆地 = 海拔 h >= 20）
 *  - county：陆地格按自然地理（海拔带 / 气候 temp+prec 相似度）确定性区域生长，目标 5-15 格
 *  - province（v0.6 均匀化）：
 *      ① 县按自然地理合并（山脉为界、气候相近，目标 ≤ ~60 格）
 *      ② 大省拆分：> PROVINCE_SPLIT_MAX(60) 格的省按内部县 BFS 切成目标 ~45 格的多省
 *      ③ 小省并入：< PROVINCE_MERGE_MIN(10) 格的省并入「同属国」最近邻省（环绕格距最小）
 *      ④ 海岛归并：相邻海岛（两岛陆地间最近格距 < ISLAND_MERGE_DIST(35px) 且同属国）归并为多岛省
 *  - 国家：8 国按 v0.5 原则地理规则占有省份（帝国北+西/洛林西岸/扎拉克中/伊尼亚斯东/
 *    诺曼尼亚南/奥兰治南沿海+海峡/盎格伦撒群岛+海峡/迷雾 x>=0.6W 不变）
 *
 * 循环地图（东西环绕）：所有省距/海峡距离按环绕计算
 *  - wrappedDx(dx) = min(|x1-x2|, W-|x1-x2|)；渲染由 WorldMap 左右各复制一份无缝拼接
 *
 * 确定性：全部算法仅依赖格 id 排序与固定比较次序 + 固定种子 RNG —— 同输入必同结果。
 */
import raw from '../../../data/kalte_gridcells.json';
import type { BBox, ClimateId, NationId, Point, ProvinceOwner, TerrainKind } from './types';
import { NATIONS } from './nations';

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

/** 县目标格数（5-15 格） */
export const COUNTY_TARGET = 9;
export const COUNTY_MIN = 5;
export const COUNTY_MAX = 15;
/** 基础省目标格数（v0.5：20-80 格；mergeProvinces 用） */
export const PROVINCE_MIN = 20;
export const PROVINCE_MAX = 55;
/** 山脉界线：两格相邻且海拔均 >= 65 → 视为山脉脊线，不跨省合并 */
export const RIDGE_H = 65;

// ---- v0.6 省份重构参数 ----
/** 省目标格数（拆分目标） */
export const PROVINCE_TARGET = 45;
/** 超过该格数拆分为多省 */
export const PROVINCE_SPLIT_MAX = 60;
/** 小于该格数并入最近邻省 */
export const PROVINCE_MERGE_MIN = 10;
/** 大陆块格数 ≤ 该值视为「海岛」（参与海岛归并） */
export const ISLAND_MAX_CELLS = 60;
/** 相邻海岛归并阈值：两岛陆地间最近格距（px，环绕） < 该值 */
export const ISLAND_MERGE_DIST = 35;
/** 海岛归并后省份格数上限（避免合并出超大省） */
export const ISLAND_MERGE_MAX_COMBINED = 90;
/** 结果省格数允许范围（sim 断言用；海峡要道等少量边缘例外） */
export const PROVINCE_SIZE_MIN = 8;
export const PROVINCE_SIZE_MAX = 90;

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

export interface County {
  id: number;
  cellIds: number[];
  center: Point;
  climate: ClimateId;
  avgTemp: number;
  avgPrec: number;
  /** 平均海拔带（floor(h/15)） */
  elevBand: number;
}

export interface Province {
  id: number;
  /** 所辖县（内嵌对象，含各自的格） */
  counties: County[];
  countyIds: number[];
  cellIds: number[];
  centroid: Point;
  /** 主导气候（格数最多者） */
  climate: ClimateId;
  climateCells: Record<ClimateId, number>;
  avgTemp: number;
  avgPrec: number;
  /** 海拔统计（min/max/avg） */
  elevStats: { min: number; max: number; avg: number };
  terrain: TerrainKind;
  /** 省份粮食产出倍率（格均值） */
  grainMod: number;
  /** 省份经济产出倍率（格均值） */
  productivity: number;
  isUndiscovered: boolean;
  owner: ProvinceOwner;
  /** 主大陆块 id（多岛省取格数最多的分量） */
  landmassId: number;
  /** v0.5 海峡省份：沿海且与另一大陆块最近格距 < STRAIT_DIST（交通要道） */
  isStrait: boolean;
}

export interface GameMap {
  width: number;
  height: number;
  seed: string;
  cellsById: Map<number, CellData>;
  landCellIds: number[];
  counties: County[];
  countyById: Map<number, County>;
  provinces: Province[];
  provinceById: Map<number, Province>;
  /** v0.6 编辑器：各省「代码级默认归属」（地理规则，不含 localStorage 覆盖），供清空/重置 */
  defaultOwners: Map<number, ProvinceOwner>;
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

// ---- v0.6 循环地图（东西环绕）距离工具 ----

/** 把 x 环绕到 [0, width)（跨东西边界时取最近副本） */
export function wrapX(x: number, width: number): number {
  return ((x % width) + width) % width;
}

/** 环绕 dx：min(|x1-x2|, W-|x1-x2|) */
export function wrappedDx(x1: number, x2: number, width: number): number {
  const d = Math.abs(x1 - x2);
  return Math.min(d, width - d);
}

/** 环绕欧氏距离（y 不环绕） */
export function wrappedDistance(a: Point, b: Point, width: number): number {
  const dx = wrappedDx(a.x, b.x, width);
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function wrappedDistanceXY(x1: number, y1: number, x2: number, y2: number, width: number): number {
  const dx = wrappedDx(x1, x2, width);
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

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

/** 查找包含坐标 (x,y) 的陆地格（海洋返回 null）；x 先环绕到 [0,W) */
export function findCellAt(map: GameMap, x: number, y: number): CellData | null {
  const wx = wrapX(x, map.width);
  for (const id of map.landCellIds) {
    const cell = map.cellsById.get(id);
    if (!cell) continue;
    const b = cell.bbox;
    if (wx < b.minX || wx > b.maxX || y < b.minY || y > b.maxY) continue;
    if (pointInPolygon(wx, y, cell.polygon)) return cell;
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
/** 格 → 省 id（三级制合并结果） */
export function provOfCell(map: GameMap, cellId: number): number | undefined {
  if (!provOfCellCache) {
    provOfCellCache = new Map();
    for (const p of map.provinces) {
      for (const cid of p.cellIds) provOfCellCache.set(cid, p.id);
    }
  }
  return provOfCellCache.get(cellId);
}

let countyOfCellCache: Map<number, number> | null = null;
/** 格 → 县 id */
export function countyOfCell(map: GameMap, cellId: number): number | undefined {
  if (!countyOfCellCache) {
    countyOfCellCache = new Map();
    for (const c of map.counties) {
      for (const cid of c.cellIds) countyOfCellCache.set(cid, c.id);
    }
  }
  return countyOfCellCache.get(cellId);
}

/** 县 id → 是否边界格（邻接海洋或异县） */
export function cellIsCountyBoundary(map: GameMap, cell: CellData, countyId: number): boolean {
  for (const nb of cell.neighbors) {
    const nbCell = map.cellsById.get(nb);
    if (!nbCell || !nbCell.land) return true;
    const nbC = countyOfCell(map, nb);
    if (nbC === undefined || nbC !== countyId) return true;
  }
  return false;
}

let cachedMap: GameMap | null = null;

/** 加载地图（进程内单例） */
export function loadMap(): GameMap {
  if (cachedMap) return cachedMap;
  cachedMap = buildMap(RAW);
  return cachedMap;
}

// ---- 区域生长辅助 ----

interface GrowCounty {
  cellIds: number[];
  hSum: number;
  tempSum: number;
  precSum: number;
}

function cellSim(cell: CellData, avgH: number, avgT: number, avgP: number): number {
  const dElev = Math.abs(Math.floor(cell.h / 15) - Math.floor(avgH / 15)) / 6;
  const dTemp = Math.abs(cell.temp - avgT) / 50;
  const dPrec = Math.abs(cell.prec - avgP) / 100;
  return 1 - (0.5 * dElev + 0.3 * dTemp + 0.2 * dPrec);
}

/** 单个大陆块内：格 → 县 确定性区域生长（同 v0.5）。 */
function growCounties(
  landCells: number[],
  cellsById: Map<number, CellData>,
): GrowCounty[] {
  const n = landCells.length;
  if (n === 0) return [];
  const sorted = [...landCells].sort((a, b) => a - b);
  const target = Math.max(1, Math.round(n / COUNTY_TARGET));
  const stride = Math.max(1, Math.floor(n / target));

  const seeds: number[] = [];
  for (let i = 0; i < n; i += stride) {
    let best = -1;
    let bestScore = -1;
    for (let j = i; j < Math.min(i + stride, n); j++) {
      const cid = sorted[j];
      const cell = cellsById.get(cid);
      if (!cell) continue;
      let landNbs = 0;
      for (const nb of cell.neighbors) {
        const nbC = cellsById.get(nb);
        if (nbC && nbC.land) landNbs++;
      }
      if (landNbs > bestScore || (landNbs === bestScore && (best === -1 || cid < best))) {
        bestScore = landNbs;
        best = cid;
      }
    }
    if (best >= 0) seeds.push(best);
  }

  const counties: GrowCounty[] = seeds.map((sid) => {
    const c = cellsById.get(sid) as CellData;
    return { cellIds: [sid], hSum: c.h, tempSum: c.temp, precSum: c.prec };
  });
  const assigned = new Map<number, number>();
  seeds.forEach((sid, ci) => assigned.set(sid, ci));

  const frontier: Set<number>[] = counties.map(() => new Set<number>());
  seeds.forEach((sid, ci) => {
    const cell = cellsById.get(sid) as CellData;
    for (const nb of cell.neighbors) {
      const nbC = cellsById.get(nb);
      if (nbC && nbC.land && !assigned.has(nb)) frontier[ci].add(nb);
    }
  });

  const assign = (ci: number, cid: number): void => {
    const county = counties[ci];
    const cell = cellsById.get(cid) as CellData;
    county.cellIds.push(cid);
    county.hSum += cell.h;
    county.tempSum += cell.temp;
    county.precSum += cell.prec;
    assigned.set(cid, ci);
    frontier[ci].delete(cid);
    for (const nb of cell.neighbors) {
      const nbC = cellsById.get(nb);
      if (nbC && nbC.land && !assigned.has(nb)) frontier[ci].add(nb);
    }
  };

  while (assigned.size < n) {
    let bestCi = -1;
    let bestCell = -1;
    let bestSim = -Infinity;
    for (let ci = 0; ci < counties.length; ci++) {
      const county = counties[ci];
      if (county.cellIds.length >= COUNTY_MAX) continue;
      const avgH = county.hSum / county.cellIds.length;
      const avgT = county.tempSum / county.cellIds.length;
      const avgP = county.precSum / county.cellIds.length;
      for (const cid of frontier[ci]) {
        if (assigned.has(cid)) continue;
        const cell = cellsById.get(cid);
        if (!cell) continue;
        const sim = cellSim(cell, avgH, avgT, avgP);
        const tie =
          sim > bestSim ||
          (sim === bestSim && (bestCi === -1 || ci < bestCi || (ci === bestCi && cid < bestCell)));
        if (tie) {
          bestSim = sim;
          bestCi = ci;
          bestCell = cid;
        }
      }
    }
    if (bestCi !== -1) {
      assign(bestCi, bestCell);
      continue;
    }
    let anyCi = -1;
    let anyCell = -1;
    let anySim = -Infinity;
    for (let ci = 0; ci < counties.length; ci++) {
      const county = counties[ci];
      const avgH = county.hSum / county.cellIds.length;
      const avgT = county.tempSum / county.cellIds.length;
      const avgP = county.precSum / county.cellIds.length;
      for (const cid of frontier[ci]) {
        if (assigned.has(cid)) continue;
        const cell = cellsById.get(cid);
        if (!cell) continue;
        const sim = cellSim(cell, avgH, avgT, avgP);
        const tie =
          sim > anySim ||
          (sim === anySim && (anyCi === -1 || ci < anyCi || (ci === anyCi && cid < anyCell)));
        if (tie) {
          anySim = sim;
          anyCi = ci;
          anyCell = cid;
        }
      }
    }
    if (anyCi === -1) break;
    assign(anyCi, anyCell);
  }

  return counties;
}

/** 两县是否格邻接（共享格邻边） */
function countiesAdjacent(
  a: GrowCounty,
  b: GrowCounty,
  cellsById: Map<number, CellData>,
): boolean {
  const bSet = new Set(b.cellIds);
  for (const cid of a.cellIds) {
    const cell = cellsById.get(cid);
    if (!cell) continue;
    for (const nb of cell.neighbors) {
      if (bSet.has(nb)) return true;
    }
  }
  return false;
}

/** 合并 <5 格的县到相似度最高的邻县（确定性：按县 id 升序处理） */
function mergeTinyCounties(
  counties: GrowCounty[],
  cellsById: Map<number, CellData>,
): GrowCounty[] {
  const list = counties.slice();
  let changed = true;
  while (changed) {
    changed = false;
    let ti = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].cellIds.length < COUNTY_MIN && (ti === -1 || list[i].cellIds.length < list[ti].cellIds.length)) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tiny = list[ti];
    let bj = -1;
    let bestSim = -Infinity;
    for (let j = 0; j < list.length; j++) {
      if (j === ti || !countiesAdjacent(tiny, list[j], cellsById)) continue;
      const tAvgH = tiny.hSum / tiny.cellIds.length;
      const tAvgT = tiny.tempSum / tiny.cellIds.length;
      const tAvgP = tiny.precSum / tiny.cellIds.length;
      const jAvgH = list[j].hSum / list[j].cellIds.length;
      const jAvgT = list[j].tempSum / list[j].cellIds.length;
      const jAvgP = list[j].precSum / list[j].cellIds.length;
      const sim =
        1 -
        (0.5 * Math.abs(Math.floor(tAvgH / 15) - Math.floor(jAvgH / 15)) / 6 +
          0.3 * Math.abs(tAvgT - jAvgT) / 50 +
          0.2 * Math.abs(tAvgP - jAvgP) / 100);
      if (sim > bestSim || (sim === bestSim && (bj === -1 || j < bj))) {
        bestSim = sim;
        bj = j;
      }
    }
    if (bj === -1) break;
    list[bj].cellIds.push(...tiny.cellIds);
    list[bj].hSum += tiny.hSum;
    list[bj].tempSum += tiny.tempSum;
    list[bj].precSum += tiny.precSum;
    list.splice(ti, 1);
    changed = true;
  }
  return list;
}

/** 县对是否隔山脉（边界存在两格均 >= RIDGE_H 的相邻对） */
function hasRidgeBetween(
  a: GrowCounty,
  b: GrowCounty,
  cellsById: Map<number, CellData>,
): boolean {
  const bMap = new Map<number, CellData>();
  for (const cid of b.cellIds) {
    const c = cellsById.get(cid);
    if (c) bMap.set(cid, c);
  }
  for (const cid of a.cellIds) {
    const cell = cellsById.get(cid);
    if (!cell) continue;
    for (const nb of cell.neighbors) {
      const nbC = bMap.get(nb);
      if (nbC && cell.h >= RIDGE_H && nbC.h >= RIDGE_H) return true;
    }
  }
  return false;
}

/** 单个大陆块内：县 → 省 合并（山脉为界、气候相近、目标 20-80 格） */
function mergeProvinces(
  landCounties: GrowCounty[],
  cellsById: Map<number, CellData>,
): number[][] {
  if (landCounties.length === 0) return [];
  const total = landCounties.reduce((s, c) => s + c.cellIds.length, 0);
  if (total <= PROVINCE_MIN) return [landCounties.map((_, i) => i)];

  const adj: Set<number>[] = landCounties.map(() => new Set<number>());
  for (let i = 0; i < landCounties.length; i++) {
    for (let j = i + 1; j < landCounties.length; j++) {
      if (!countiesAdjacent(landCounties[i], landCounties[j], cellsById)) continue;
      if (hasRidgeBetween(landCounties[i], landCounties[j], cellsById)) continue;
      adj[i].add(j);
      adj[j].add(i);
    }
  }

  const sizeOf = (idx: number): number => landCounties[idx].cellIds.length;
  const unassigned = new Set<number>(landCounties.map((_, i) => i));
  const provinces: number[][] = [];

  while (unassigned.size > 0) {
    let seed = -1;
    for (const i of unassigned) {
      if (seed === -1 || sizeOf(i) > sizeOf(seed)) seed = i;
    }
    const prov: number[] = [seed];
    unassigned.delete(seed);
    let size = sizeOf(seed);
    while (size < PROVINCE_MAX) {
      let cand = -1;
      let bestScore = -Infinity;
      for (const i of unassigned) {
        let linked = false;
        for (const pi of prov) {
          if (adj[pi].has(i)) {
            linked = true;
            break;
          }
        }
        if (!linked) continue;
        const pAvgT = prov.reduce((s, pi) => s + landCounties[pi].tempSum / landCounties[pi].cellIds.length, 0) / prov.length;
        const pAvgP = prov.reduce((s, pi) => s + landCounties[pi].precSum / landCounties[pi].cellIds.length, 0) / prov.length;
        const pAvgH = prov.reduce((s, pi) => s + landCounties[pi].hSum / landCounties[pi].cellIds.length, 0) / prov.length;
        const cAvgT = landCounties[i].tempSum / landCounties[i].cellIds.length;
        const cAvgP = landCounties[i].precSum / landCounties[i].cellIds.length;
        const cAvgH = landCounties[i].hSum / landCounties[i].cellIds.length;
        const sim =
          1 -
          (0.45 * Math.abs(Math.floor(pAvgH / 15) - Math.floor(cAvgH / 15)) / 6 +
            0.3 * Math.abs(pAvgT - cAvgT) / 50 +
            0.25 * Math.abs(pAvgP - cAvgP) / 100);
        const sizeFit = 1 - Math.min(1, Math.abs(sizeOf(i) - 10) / 20);
        const score = sim + 0.15 * sizeFit;
        if (score > bestScore || (score === bestScore && (cand === -1 || i < cand))) {
          bestScore = score;
          cand = i;
        }
      }
      if (cand === -1) break;
      prov.push(cand);
      unassigned.delete(cand);
      size += sizeOf(cand);
    }
    provinces.push(prov);
  }
  return provinces;
}

/** 格列表质心（多边形顶点均值） */
function centroidOf(cids: number[], cellsById: Map<number, CellData>): Point {
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
}

// ---- v0.6 省份重构（均匀化 + 海岛归并） ----

/**
 * 构建期省组：一组全局县索引 + 大陆块分量统计。
 * 多岛省（海岛归并结果）的 landmassId = 格数最多的分量。
 */
interface ProvGroup {
  countyIdx: number[];
  lmCells: Map<number, number>;
}

function groupCellCount(g: ProvGroup, allCounties: GrowCounty[]): number {
  let n = 0;
  for (const ci of g.countyIdx) n += allCounties[ci].cellIds.length;
  return n;
}

function groupCells(g: ProvGroup, allCounties: GrowCounty[]): number[] {
  const out: number[] = [];
  for (const ci of g.countyIdx) out.push(...allCounties[ci].cellIds);
  return out;
}

function groupPrimaryLandmass(g: ProvGroup): number {
  let best = -1;
  let bestN = -1;
  for (const [lm, n] of g.lmCells) {
    if (n > bestN || (n === bestN && (best === -1 || lm < best))) {
      bestN = n;
      best = lm;
    }
  }
  return best;
}

/** 省组 → 归属（地理规则；用于「同属国」归并分组与最终归属） */
function groupOwner(g: ProvGroup, allCounties: GrowCounty[], cellsById: Map<number, CellData>, width: number, height: number): ProvinceOwner {
  const cent = centroidOf(groupCells(g, allCounties), cellsById);
  return assignProvinceOwnerV2(groupPrimaryLandmass(g), cent, width, height);
}

/**
 * 大省拆分：> PROVINCE_SPLIT_MAX 格的省切成目标 ~PROVINCE_TARGET 的多省。
 * 确定性：种子 = 剩余县中格数最多者（tie-break 索引小）；BFS 前沿按县格数降序扩展（大县先填）。
 * 策略：先按 k-1 片 BFS 生长（每片 ≥ ~45 格），最后一片 = 全部剩余县（可为多岛/断片，
 * 与海岛归并的多岛省概念一致）；末尾 < PROVINCE_MERGE_MIN 的片并入相邻片，避免
 * 「小省并入」步骤把刚拆开的两片又并回去。
 */
function splitLargeGroup(
  g: ProvGroup,
  allCounties: GrowCounty[],
  adj: Set<number>[],
  cellOfLandmass: Map<number, number>,
): ProvGroup[] {
  const sizeOf = (ci: number): number => allCounties[ci].cellIds.length;
  const lmOfCounty = (ci: number): number => cellOfLandmass.get(allCounties[ci].cellIds[0]) ?? -1;

  const total = g.countyIdx.reduce((s, ci) => s + sizeOf(ci), 0);
  const pieceCount = Math.max(2, Math.ceil(total / PROVINCE_TARGET));
  const remaining = new Set<number>(g.countyIdx);
  const pieces: number[][] = [];

  // 1) 前 pieceCount-1 片：BFS 生长至 ≥ PROVINCE_TARGET（前沿按格数降序）
  for (let p = 0; p < pieceCount - 1 && remaining.size > 0; p++) {
    let seed = -1;
    for (const i of remaining) {
      if (seed === -1 || sizeOf(i) > sizeOf(seed)) seed = i;
    }
    const piece: number[] = [];
    const inPiece = new Set<number>([seed]);
    remaining.delete(seed);
    piece.push(seed);
    let size = sizeOf(seed);
    const frontier: number[] = [];
    const pushFrontier = (ci: number): void => {
      if (!remaining.has(ci) || inPiece.has(ci)) return;
      inPiece.add(ci);
      frontier.push(ci);
      frontier.sort((a, b) => sizeOf(b) - sizeOf(a) || a - b);
    };
    for (const nb of adj[seed]) pushFrontier(nb);
    while (frontier.length > 0 && size < PROVINCE_TARGET) {
      const cur = frontier.shift() as number;
      remaining.delete(cur);
      piece.push(cur);
      size += sizeOf(cur);
      for (const nb of adj[cur]) pushFrontier(nb);
    }
    pieces.push(piece);
  }
  // 2) 最后一片 = 全部剩余县（可能断片/多岛，概念同海岛归并省）
  if (remaining.size > 0) pieces.push([...remaining]);

  // 3) 借县补足：< PROVINCE_MERGE_MIN 的片从相邻片「借」最小县，直到 ≥ 下限
  //    （避免把刚拆开的片又并入回去 → 61 格省变回一整块）
  let guard = 0;
  while (guard++ < 64) {
    let ti = -1;
    for (let i = 0; i < pieces.length; i++) {
      const n = pieces[i].reduce((s, ci) => s + sizeOf(ci), 0);
      if (n < PROVINCE_MERGE_MIN && (ti === -1 || n < pieces[ti].reduce((s, ci) => s + sizeOf(ci), 0))) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tinySet = new Set(pieces[ti]);
    // 候选借出县：优先「与 tiny 片邻接」的县中格数最小者；无邻接县时取任意片中最小县（tie 全局县索引小）
    let best = -1;
    let bestSize = Infinity;
    let bestAdj = -1;
    let bestAdjSize = Infinity;
    for (let j = 0; j < pieces.length; j++) {
      if (j === ti) continue;
      for (const ci of pieces[j]) {
        const s = sizeOf(ci);
        let linked = false;
        for (const nb of adj[ci]) {
          if (tinySet.has(nb)) {
            linked = true;
            break;
          }
        }
        if (linked && s < bestAdjSize) {
          bestAdjSize = s;
          bestAdj = ci;
        }
        if (s < bestSize) {
          bestSize = s;
          best = ci;
        }
      }
    }
    const borrow = bestAdj !== -1 ? bestAdj : best;
    if (borrow !== -1) {
      // 把 borrow 从原片移到 tiny 片
      for (let j = 0; j < pieces.length; j++) {
        if (j === ti) continue;
        const idx = pieces[j].indexOf(borrow);
        if (idx >= 0) {
          pieces[j].splice(idx, 1);
          break;
        }
      }
      pieces[ti].push(borrow);
      continue;
    }
    // 4) 兜底吸收：无县可借（理论不触发）→ 并入合并后最小的相邻片
    let bj = -1;
    let bestMerged = Infinity;
    for (let j = 0; j < pieces.length; j++) {
      if (j === ti) continue;
      let linked = false;
      for (const ci of pieces[j]) {
        for (const nb of adj[ci]) {
          if (tinySet.has(nb)) {
            linked = true;
            break;
          }
        }
        if (linked) break;
      }
      if (!linked) continue;
      const mergedSize = pieces[j].reduce((s, ci) => s + sizeOf(ci), 0) + pieces[ti].reduce((s, ci) => s + sizeOf(ci), 0);
      if (mergedSize < bestMerged || (mergedSize === bestMerged && (bj === -1 || j < bj))) {
        bestMerged = mergedSize;
        bj = j;
      }
    }
    if (bj === -1) bj = ti === 0 ? 1 : 0;
    pieces[bj].push(...pieces[ti]);
    pieces.splice(ti, 1);
  }

  return pieces.map((piece) => {
    const lmCells = new Map<number, number>();
    for (const ci of piece) lmCells.set(lmOfCounty(ci), (lmCells.get(lmOfCounty(ci)) ?? 0) + sizeOf(ci));
    return { countyIdx: piece, lmCells };
  });
}

// ---- 环绕格距计算（v0.6：所有省距/海峡距/归并判定均环绕） ----

interface DistCache {
  cellCent: Map<number, Point>;
  cellBBox: Map<number, BBox>;
  width: number;
}

function buildDistCache(mapOrCells: Map<number, CellData>, landCellIds: number[], width: number): DistCache {
  const cellCent = new Map<number, Point>();
  const cellBBox = new Map<number, BBox>();
  for (const cid of landCellIds) {
    const cell = mapOrCells.get(cid);
    if (!cell) continue;
    let cx = 0, cy = 0;
    for (const p of cell.polygon) {
      cx += p.x;
      cy += p.y;
    }
    cellCent.set(cid, { x: cx / cell.polygon.length, y: cy / cell.polygon.length });
    cellBBox.set(cid, cell.bbox);
  }
  return { cellCent, cellBBox, width };
}

/** 两组格的最小环绕格距（bbox 剪枝；limit 用于提前退出） */
function minCellDistBetween(
  dc: DistCache,
  cellsA: number[],
  cellsB: number[],
  limit = Infinity,
): number {
  let min = limit;
  for (const a of cellsA) {
    const ca = dc.cellCent.get(a);
    const ba = dc.cellBBox.get(a);
    if (!ca || !ba) continue;
    for (const b of cellsB) {
      const cb = dc.cellCent.get(b);
      const bb = dc.cellBBox.get(b);
      if (!cb || !bb) continue;
      // 环绕 bbox 剪枝：原始与环绕两个横向间隙都超限才跳过
      const rawGapX = Math.max(ba.minX - bb.maxX, bb.minX - ba.maxX);
      const wrapGapX = Math.max(
        ba.minX - (bb.maxX - dc.width),
        (bb.minX - dc.width) - ba.maxX,
        (ba.minX - dc.width) - bb.maxX,
        bb.minX - (ba.maxX - dc.width),
      );
      const gapY = Math.max(ba.minY - bb.maxY, bb.minY - ba.maxY);
      if (rawGapX > min && wrapGapX > min) continue;
      if (gapY > min) continue;
      const d = wrappedDistanceXY(ca.x, ca.y, cb.x, cb.y, dc.width);
      if (d < min) {
        min = d;
        if (min <= 0.001) return min; // 相邻格
      }
    }
  }
  return min;
}

/**
 * 小省并入：< PROVINCE_MERGE_MIN 格的省并入「同属国」最近邻省（环绕格距最小）。
 * 同属国限制保证：群岛国（盎格伦撒等）不会因并入异国大陆而灭国；迷雾区不跨界。
 * 确定性：按省 id 升序反复处理最小者。
 */
function mergeTinyGroups(
  groups: ProvGroup[],
  allCounties: GrowCounty[],
  dc: DistCache,
  cellsById: Map<number, CellData>,
  width: number,
  height: number,
): ProvGroup[] {
  const list = groups.slice();
  const cellsOf = (g: ProvGroup): number[] => groupCells(g, allCounties);
  const sizeOf = (g: ProvGroup): number => groupCellCount(g, allCounties);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    let ti = -1;
    for (let i = 0; i < list.length; i++) {
      if (sizeOf(list[i]) < PROVINCE_MERGE_MIN && (ti === -1 || sizeOf(list[i]) < sizeOf(list[ti]))) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tiny = list[ti];
    const tinyOwner = groupOwner(tiny, allCounties, cellsById, width, height);
    const tinyCells = cellsOf(tiny);
    let bj = -1;
    let bestD = Infinity;
    for (let j = 0; j < list.length; j++) {
      if (j === ti) continue;
      const other = list[j];
      if (groupOwner(other, allCounties, cellsById, width, height) !== tinyOwner) continue; // 同属国才并入
      const d = minCellDistBetween(dc, tinyCells, cellsOf(other), bestD);
      if (d < bestD || (d === bestD && (bj === -1 || j < bj))) {
        bestD = d;
        bj = j;
      }
    }
    if (bj === -1) break; // 无同属国邻省（如盎格伦撒仅剩 8 格）→ 保留为边缘例外
    // 并入
    const target = list[bj];
    target.countyIdx.push(...tiny.countyIdx);
    for (const [lm, n] of tiny.lmCells) target.lmCells.set(lm, (target.lmCells.get(lm) ?? 0) + n);
    list.splice(ti, 1);
    changed = true;
  }
  return list;
}

/**
 * 海岛归并：相邻海岛（两岛陆地间最近格距 < ISLAND_MERGE_DIST 且同属国且不同大陆块）
 * 归并为一个多岛省份。组合格数 ≤ ISLAND_MERGE_MAX_COMBINED（保证均匀化上限）。
 * 确定性：按 (距离, i, j) 升序成对合并，多轮直至无候选。
 */
function mergeIslandGroups(
  groups: ProvGroup[],
  allCounties: GrowCounty[],
  dc: DistCache,
  cellOfLandmass: Map<number, number>,
  cellsById: Map<number, CellData>,
  width: number,
  height: number,
): ProvGroup[] {
  let list = groups.slice();
  // 纯岛判定需要大陆块总格数：landmass cell counts
  const lmTotal = new Map<number, number>();
  for (const lm of cellOfLandmass.values()) lmTotal.set(lm, (lmTotal.get(lm) ?? 0) + 1);
  const islandLm = new Set<number>();
  for (const [lm, n] of lmTotal) if (n <= ISLAND_MAX_CELLS) islandLm.add(lm);

  const pureIsland = (g: ProvGroup): boolean => {
    if (g.lmCells.size === 0) return false;
    for (const lm of g.lmCells.keys()) if (!islandLm.has(lm)) return false;
    return true;
  };

  let guard = 0;
  while (guard++ < 16) {
    // 候选对：纯岛、不同大陆块（无共同分量）、同属国、距离 < 阈值、合并 ≤ 上限
    const candidates: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      if (!pureIsland(list[i])) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (!pureIsland(list[j])) continue;
        if (groupOwner(list[i], allCounties, cellsById, width, height) !== groupOwner(list[j], allCounties, cellsById, width, height)) continue;
        // 不同大陆块：无共同分量
        let shared = false;
        for (const lm of list[i].lmCells.keys()) {
          if (list[j].lmCells.has(lm)) {
            shared = true;
            break;
          }
        }
        if (shared) continue;
        const combined = groupCellCount(list[i], allCounties) + groupCellCount(list[j], allCounties);
        if (combined > ISLAND_MERGE_MAX_COMBINED) continue;
        const d = minCellDistBetween(dc, groupCells(list[i], allCounties), groupCells(list[j], allCounties), ISLAND_MERGE_DIST);
        if (d < ISLAND_MERGE_DIST) candidates.push({ i, j, d });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
    const merged = new Set<number>();
    let any = false;
    for (const c of candidates) {
      if (merged.has(c.i) || merged.has(c.j)) continue;
      // 合并 j 入 i
      const a = list[c.i];
      const b = list[c.j];
      a.countyIdx.push(...b.countyIdx);
      for (const [lm, n] of b.lmCells) a.lmCells.set(lm, (a.lmCells.get(lm) ?? 0) + n);
      merged.add(c.j);
      any = true;
    }
    if (!any) break;
    list = list.filter((_, idx) => !merged.has(idx));
  }
  return list;
}

// ---- v0.5 国界重绘（v0.6 区域化：旧 PROVINCE_OWNER_OVERRIDES 因省份 id 重构失效） ----
/**
 * v0.6 归属覆盖表（兼容编辑器导出格式 {provinceId: nationId}）。
 * v0.5 的手调条目（#0 中央低地→南扎拉克、#38/#45 凯森海峡哨岛→奥兰治/盎格伦撒）
 * 已区域化进 assignProvinceOwnerV2（按大陆块 + 质心区域，不依赖省份 id），
 * 因此本表默认空；编辑器（localStorage kalt-border-edits）与导出 JSON 仍按此格式覆盖。
 */
export const PROVINCE_OWNER_OVERRIDES: Record<number, ProvinceOwner> = {};

/** 海峡判定阈值（格质心间最近距离 px；小于阈值视为窄海/交通要道）。
 * 实测：凯森海峡哨岛对（块18↔块20）≈24、盎格伦撒群岛对（块14↔块15）≈38、
 * 奥兰治西南群岛对（块32↔块35）≈31 —— 阈值 40 恰好只标记这些要道，不误伤大陆本体。 */
export const STRAIT_DIST = 40;

/**
 * v0.6 八国划分（按大陆块 id + 省质心区域 + 覆盖表；确定性；沿用 v0.5 原则）：
 *  - 右侧新大陆 x >= 0.6W 保持未探明（不动）
 *  - LM0 北大陆：中央低地（x∈[0.30W,0.44W] 且 y∈[0.42H,0.56H]，v0.5 #0 区域化）→ 南扎拉克；
 *    南端（y>=0.55H）→ 诺曼尼亚；其余 → 帝国（北+西）
 *  - LM1/2/3/4/6/7 北境群岛 → 帝国
 *  - LM13/16/17 西大陆 → 洛林（西岸）；LM18 凯森海峡西岸哨岛 → 奥兰治；LM20 东岸哨岛 → 盎格伦撒
 *  - LM19 南大陆中央：西端（x<=0.43W）或南端（y>=0.63H）→ 诺曼尼亚；北（y<0.47H）→ 北扎拉克；其余 → 南扎拉克
 *  - LM21/30/31 东岸工业带（铁+煤）→ 伊尼亚斯
 *  - LM9/12/14/15 中北群岛 → 盎格伦撒（群岛）
 *  - LM24/26/27/29/32/33/34/35 西南群岛 → 奥兰治（南部沿海低地）
 */
function assignProvinceOwnerV2(lmId: number, c: Point, width: number, height: number): ProvinceOwner {
  if (c.x >= width * FOG_X_RATIO) return 'undiscovered';
  switch (lmId) {
    case 0:
      // 北大陆：中央低地 → 南扎拉克（v0.5 #0 区域化）；南端 → 诺曼尼亚；其余 → 帝国
      if (c.x >= width * 0.3 && c.x <= width * 0.44 && c.y >= height * 0.42 && c.y <= height * 0.56) {
        return 'zalakS';
      }
      return c.y >= height * 0.55 ? 'normandy' : 'empire';
    case 1:
    case 2:
    case 3:
    case 4:
    case 6:
    case 7:
      return 'empire'; // 北境群岛
    case 5:
    case 8:
    case 10:
    case 11:
    case 22:
    case 23:
    case 25:
    case 28:
    case 36:
    case 37:
    case 38:
      return 'undiscovered'; // 右侧迷雾新大陆
    case 9:
    case 12:
    case 14:
    case 15:
      return 'angland'; // 中北群岛（盎格伦撒）
    case 13:
    case 16:
    case 17:
      return 'lorraine'; // 西大陆（洛林西岸）
    case 18:
      return 'orange'; // 凯森海峡西岸哨岛（v0.5 #38 区域化）
    case 20:
      return 'angland'; // 凯森海峡东岸哨岛（v0.5 #45 区域化）
    case 19:
      // 南大陆中央：诺曼尼亚=南端/西岸；北扎拉克=北；南扎拉克=中
      if (c.x <= width * 0.43) return 'normandy';
      if (c.y >= height * 0.63) return 'normandy';
      return c.y < height * 0.47 ? 'zalakN' : 'zalakS';
    case 21:
    case 30:
    case 31:
      return 'ianys'; // 东岸工业带
    case 24:
    case 26:
    case 27:
    case 29:
    case 32:
    case 33:
    case 34:
    case 35:
      return 'orange'; // 西南群岛（南部沿海低地）
  }
  return 'lorraine';
}

/** 计算各省「海峡省份」标记（沿海且与异大陆块最近环绕格距 < STRAIT_DIST）。
 * 只统计「已探明大陆块」之间的窄海（右侧迷雾新大陆不参与判定）。 */
export function computeStraitFlags(map: GameMap): void {
  const fogLandmasses = new Set<number>();
  for (const p of map.provinces) {
    if (p.isUndiscovered) fogLandmasses.add(p.landmassId);
  }
  const dc = buildDistCache(map.cellsById, map.landCellIds, map.width);
  const lmOfCell = new Map<number, number>();
  for (const p of map.provinces) {
    for (const cid of p.cellIds) lmOfCell.set(cid, p.landmassId);
  }
  for (const prov of map.provinces) {
    prov.isStrait = false;
    if (prov.isUndiscovered) continue;
    let min = Infinity;
    for (const cid of prov.cellIds) {
      const c = dc.cellCent.get(cid);
      const cb = dc.cellBBox.get(cid);
      if (!c || !cb) continue;
      for (const other of map.landCellIds) {
        const otherLm = lmOfCell.get(other);
        if (otherLm === undefined || otherLm === prov.landmassId) continue;
        if (fogLandmasses.has(otherLm)) continue;
        const oc = dc.cellCent.get(other);
        const ob = dc.cellBBox.get(other);
        if (!oc || !ob) continue;
        if (ob.minX > cb.maxX + STRAIT_DIST || ob.maxX < cb.minX - STRAIT_DIST) {
          // 原始横向间隙超限 → 尝试环绕副本
          const wMin = wrappedDx(c.x, oc.x, map.width);
          const rawGap = Math.max(cb.minX - ob.maxX, ob.minX - cb.maxX);
          if (rawGap > STRAIT_DIST && wMin > STRAIT_DIST) continue;
        }
        if (ob.minY > cb.maxY + STRAIT_DIST || ob.maxY < cb.minY - STRAIT_DIST) continue;
        const d = wrappedDistanceXY(c.x, c.y, oc.x, oc.y, map.width);
        if (d < min) min = d;
        if (min <= 0.001) break;
      }
      if (min <= 0.001) break;
    }
    prov.isStrait = min <= STRAIT_DIST;
  }
}

// ---- 编辑器 API（v0.6 独立编辑模式） ----

const VALID_NATIONS = new Set<string>(Object.keys(NATIONS));

/** 应用归属覆盖表（编辑模式 / localStorage 加载 / 导出配置加载）：{provinceId: nationId} */
export function applyBorderOverrides(map: GameMap, overrides: Record<number, ProvinceOwner>): void {
  for (const key of Object.keys(overrides)) {
    const pid = Number(key);
    const prov = map.provinceById.get(pid);
    if (!prov) continue;
    const owner = overrides[pid];
    if (owner !== 'undiscovered' && !VALID_NATIONS.has(owner)) continue;
    prov.owner = owner;
    prov.isUndiscovered = owner === 'undiscovered';
  }
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

  // 大陆块 = 陆地格 BFS 连通分量（格列表）
  const cellOfLandmass = new Map<number, number>();
  const landmasses: number[][] = [];
  for (const s of landCellIds) {
    if (cellOfLandmass.has(s)) continue;
    const lmId = landmasses.length;
    const queue: number[] = [s];
    cellOfLandmass.set(s, lmId);
    const list: number[] = [];
    landmasses.push(list);
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      list.push(cur);
      const cell = cellsById.get(cur);
      if (!cell) continue;
      for (const nb of cell.neighbors) {
        const nbCell = cellsById.get(nb);
        if (nbCell && nbCell.land && !cellOfLandmass.has(nb)) {
          cellOfLandmass.set(nb, lmId);
          queue.push(nb);
        }
      }
    }
  }

  // ---- 三级制：大陆块内 格→县→省（基础合并） ----
  const allCounties: GrowCounty[] = []; // 全局累计
  const baseProvinceCountyIdx: number[][] = []; // 每省 = 全局县索引数组
  const baseProvinceLandmass: number[] = []; // 每省所在大陆块

  landmasses.forEach((lmCells, lmId) => {
    const grown = growCounties(lmCells, cellsById);
    const merged = mergeTinyCounties(grown, cellsById);
    const provIdx = mergeProvinces(merged, cellsById);
    const base = allCounties.length;
    merged.forEach((c) => {
      allCounties.push(c);
    });
    provIdx.forEach((countyIdxList) => {
      baseProvinceCountyIdx.push(countyIdxList.map((ci) => base + ci));
      baseProvinceLandmass.push(lmId);
    });
  });

  // ---- v0.6 省组：均匀化重构（拆分 → 小省并入 → 海岛归并） ----
  const mkGroup = (countyIdx: number[], lmId: number): ProvGroup => {
    const lmCells = new Map<number, number>();
    for (const ci of countyIdx) {
      lmCells.set(lmId, (lmCells.get(lmId) ?? 0) + allCounties[ci].cellIds.length);
    }
    return { countyIdx, lmCells };
  };

  let groups: ProvGroup[] = baseProvinceCountyIdx.map((idxList, i) => mkGroup(idxList, baseProvinceLandmass[i]));

  // 0) 县邻接表（全局索引；用于大省拆分 BFS）
  const countyAdj: Set<number>[] = allCounties.map(() => new Set<number>());
  for (let i = 0; i < allCounties.length; i++) {
    for (let j = i + 1; j < allCounties.length; j++) {
      if (countiesAdjacent(allCounties[i], allCounties[j], cellsById)) {
        countyAdj[i].add(j);
        countyAdj[j].add(i);
      }
    }
  }

  // 1) 大省拆分（两轮：基础合并后 + 小省并入后，后者覆盖 60+9 的超限组合）
  const splitAll = (gs: ProvGroup[]): ProvGroup[] => {
    const out: ProvGroup[] = [];
    for (const g of gs) {
      if (groupCellCount(g, allCounties) > PROVINCE_SPLIT_MAX) {
        const pieces = splitLargeGroup(g, allCounties, countyAdj, cellOfLandmass);
        out.push(...pieces);
      } else {
        out.push(g);
      }
    }
    return out;
  };
  groups = splitAll(groups);

  // 2) 小省并入（同属国最近邻）
  const dc = buildDistCache(cellsById, landCellIds, width);
  groups = mergeTinyGroups(groups, allCounties, dc, cellsById, width, height);
  // 2b) 小省并入可能把 60 格省顶到 61-69 → 再拆一轮
  groups = splitAll(groups);

  // 3) 海岛归并（同属国、不同大陆块、<35px）
  groups = mergeIslandGroups(groups, allCounties, dc, cellOfLandmass, cellsById, width, height);

  // 4) 重新计算每个组的 landmass 分量（多岛省）
  const finalGroups = groups.map((g) => {
    const lmCells = new Map<number, number>();
    for (const ci of g.countyIdx) {
      const cid = allCounties[ci].cellIds[0];
      const lm = cellOfLandmass.get(cid) ?? -1;
      lmCells.set(lm, (lmCells.get(lm) ?? 0) + allCounties[ci].cellIds.length);
    }
    return { countyIdx: g.countyIdx, lmCells };
  });

  // 县对象（含中心/气候统计）
  const counties: County[] = allCounties.map((gc, ci) => {
    let cx = 0, cy = 0;
    const climateCells: Record<ClimateId, number> = { arctic: 0, coldTemp: 0, temperate: 0, humid: 0, dry: 0 };
    let tSum = 0, pSum = 0;
    for (const cid of gc.cellIds) {
      const cell = cellsById.get(cid) as CellData;
      climateCells[cell.climate]++;
      tSum += cell.temp;
      pSum += cell.prec;
      let ccx = 0, ccy = 0;
      for (const p of cell.polygon) {
        ccx += p.x;
        ccy += p.y;
      }
      cx += ccx / cell.polygon.length;
      cy += ccy / cell.polygon.length;
    }
    const climate = (Object.keys(climateCells) as ClimateId[]).reduce((a, b) =>
      climateCells[b] > climateCells[a] ? b : a,
    );
    return {
      id: ci,
      cellIds: gc.cellIds,
      center: { x: cx / gc.cellIds.length, y: cy / gc.cellIds.length },
      climate,
      avgTemp: tSum / gc.cellIds.length,
      avgPrec: pSum / gc.cellIds.length,
      elevBand: Math.floor((gc.hSum / gc.cellIds.length) / 15),
    };
  });
  const countyById = new Map<number, County>();
  for (const c of counties) countyById.set(c.id, c);

  // 省对象（含内嵌县、气候、海拔统计；归属 = 地理规则 + 覆盖表）
  const provinces: Province[] = finalGroups.map((g, pid) => {
    const lmId = groupPrimaryLandmass(g);
    const provCounties: County[] = g.countyIdx.map((ci) => counties[ci]);
    const cellIds: number[] = [];
    for (const c of provCounties) cellIds.push(...c.cellIds);

    const climateCells: Record<ClimateId, number> = {
      arctic: 0,
      coldTemp: 0,
      temperate: 0,
      humid: 0,
      dry: 0,
    };
    let tSum = 0, pSum = 0, gSum = 0, eSum = 0, hMin = Infinity, hMax = -Infinity, hSum = 0;
    const terrCount: Record<TerrainKind, number> = { plain: 0, hill: 0, mountain: 0 };
    for (const cid of cellIds) {
      const cell = cellsById.get(cid) as CellData;
      climateCells[cell.climate]++;
      tSum += cell.temp;
      pSum += cell.prec;
      gSum += cell.grainMod;
      eSum += cell.productivity;
      terrCount[cell.terrain]++;
      if (cell.h < hMin) hMin = cell.h;
      if (cell.h > hMax) hMax = cell.h;
      hSum += cell.h;
    }
    const climate = (Object.keys(climateCells) as ClimateId[]).reduce((a, b) =>
      climateCells[b] > climateCells[a] ? b : a,
    );
    const terrain = (Object.keys(terrCount) as TerrainKind[]).reduce((a, b) =>
      terrCount[b] > terrCount[a] ? b : a,
    );
    const cent = centroidOf(cellIds, cellsById);
    const baseOwner = assignProvinceOwnerV2(lmId, cent, width, height);
    const owner = PROVINCE_OWNER_OVERRIDES[pid] ?? baseOwner;
    return {
      id: pid,
      counties: provCounties,
      countyIds: g.countyIdx.slice(),
      cellIds,
      centroid: cent,
      climate,
      climateCells,
      avgTemp: tSum / cellIds.length,
      avgPrec: pSum / cellIds.length,
      elevStats: { min: hMin, max: hMax, avg: hSum / cellIds.length },
      terrain,
      grainMod: gSum / cellIds.length,
      productivity: eSum / cellIds.length,
      isUndiscovered: owner === 'undiscovered',
      owner,
      landmassId: lmId,
      isStrait: false, // 由 computeStraitFlags 填充
    };
  });

  const provinceById = new Map<number, Province>();
  for (const p of provinces) provinceById.set(p.id, p);

  provOfCellCache = null; // 缓存失效
  countyOfCellCache = null;

  const map: GameMap = {
    width,
    height,
    seed,
    cellsById,
    landCellIds,
    counties,
    countyById,
    provinces,
    provinceById,
    defaultOwners: new Map(provinces.map((p) => [p.id, p.owner])),
  };
  computeStraitFlags(map); // v0.5：海峡省份判定（v0.6 环绕距离）
  return map;
}

/** 省份-归属表（审查输出）：id / 质心 / 格数 / 沿海 / 海峡 / 属国 */
export function provinceOwnerTable(map: GameMap): Array<{
  id: number;
  x: number;
  y: number;
  cells: number;
  coastal: boolean;
  strait: boolean;
  owner: ProvinceOwner;
}> {
  const out: Array<{
    id: number;
    x: number;
    y: number;
    cells: number;
    coastal: boolean;
    strait: boolean;
    owner: ProvinceOwner;
  }> = [];
  for (const p of map.provinces) {
    let coastal = false;
    for (const cid of p.cellIds) {
      const cell = map.cellsById.get(cid);
      if (!cell) continue;
      for (const nb of cell.neighbors) {
        const nbCell = map.cellsById.get(nb);
        if (nbCell && !nbCell.land) {
          coastal = true;
          break;
        }
      }
      if (coastal) break;
    }
    out.push({
      id: p.id,
      x: Math.round(p.centroid.x),
      y: Math.round(p.centroid.y),
      cells: p.cellIds.length,
      coastal,
      strait: p.isStrait,
      owner: p.owner,
    });
  }
  return out;
}

/** 调试统计（sim 用；v0.6 增加省份规模分布/环绕校验样本） */
export function mapStats(map: GameMap): Record<string, unknown> {
  const nationCells: Record<NationId | 'undiscovered', number> = {
    empire: 0,
    lorraine: 0,
    ianys: 0,
    orange: 0,
    zalakN: 0,
    zalakS: 0,
    angland: 0,
    normandy: 0,
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
  const countySizes = map.counties.map((c) => c.cellIds.length);
  const provSizes = map.provinces.map((p) => p.cellIds.length);
  const dist = { under8: 0, eightTo29: 0, thirtyTo60: 0, sixtyOneTo90: 0, over90: 0 };
  for (const s of provSizes) {
    if (s < 8) dist.under8++;
    else if (s < 30) dist.eightTo29++;
    else if (s <= 60) dist.thirtyTo60++;
    else if (s <= 90) dist.sixtyOneTo90++;
    else dist.over90++;
  }
  // 环绕距离抽样（最西 ↔ 最东质心；跨东西边界的两点）
  let wrapSample: number | null = null;
  if (map.provinces.length >= 2) {
    let west = map.provinces[0];
    let east = map.provinces[0];
    for (const p of map.provinces) {
      if (p.centroid.x < west.centroid.x) west = p;
      if (p.centroid.x > east.centroid.x) east = p;
    }
    wrapSample = wrappedDistance(west.centroid, east.centroid, map.width);
  }
  return {
    cells: map.cellsById.size,
    landCells: map.landCellIds.length,
    counties: map.counties.length,
    countyMin: Math.min(...countySizes),
    countyMax: Math.max(...countySizes),
    countyAvg: countySizes.reduce((a, b) => a + b, 0) / Math.max(1, countySizes.length),
    provinces: map.provinces.length,
    provMin: Math.min(...provSizes),
    provMax: Math.max(...provSizes),
    provAvg: provSizes.reduce((a, b) => a + b, 0) / Math.max(1, provSizes.length),
    provSizeDist: dist,
    undiscoveredProvinces: map.provinces.filter((p) => p.isUndiscovered).length,
    nationCells,
    climateCount,
    wrapSample,
  };
}
