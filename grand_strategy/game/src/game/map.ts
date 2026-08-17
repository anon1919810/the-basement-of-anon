/**
 * 地图导入器（v0.7 山川形便省界重划 + 循环地图）：
 * 层级：cell（格）→ county（县）→ province（省）→ 国家辖区
 *  - cell：原始网格（陆地 = 海拔 h >= 20）
 *  - county（v0.7 自然地理聚类）：陆地格按「同海拔带(floor(h/15)) + 同气候带(temp/prec 五气候)」
 *    确定性区域生长，目标 5-15 格；山脊格（海拔局部极大值，h≥RIDGE_MIN_H 且严格高于所有陆地邻居）
 *    不参与县聚类 —— 山脊=天然省界，两侧永不跨脊合并（结构上自保证）
 *  - province（v0.7 紧凑度约束合并，杜绝长条怪形）：
 *      ① 县按「共享边界边数最大（= 周长增量最小）」贪心并省，目标 30-60 格（PROVINCE_MIN=15 停，
 *        允许 15-90 边缘）
 *      ② 大省拆分：> PROVINCE_SPLIT_MAX(60) 格按紧凑 BFS 切成目标 ~45 格的多省
 *      ③ 小省并入：< PROVINCE_MERGE_MIN(8) 格并入共享边最多的相邻省（无邻省的海岛走
 *        「同属国最近邻」距离并入）
 *      ④ 山脊格归属：各山脊格并入「共享边最多」的相邻省（多山脊成簇时按同大陆块最近省）
 *      ⑤ 海岛归并：相邻海岛（两岛陆地间最近格距 < ISLAND_MERGE_DIST(35px) 且同属国）归并为多岛省
 *  - 国家：8 国按 v0.6 原则地理规则占有省份（帝国北+西/洛林西岸/扎拉克中/伊尼亚斯东/
 *    诺曼尼亚南/奥兰治南沿海+海峡/盎格伦撒群岛+海峡/迷雾 x>=0.6W 不变）
 *
 * 循环地图（东西环绕）：所有省距/海峡距按环绕计算（wrappedDx）；渲染由 WorldMap 左右复制无缝拼接
 *
 * 确定性：全部算法仅依赖格 id 排序与固定比较次序 —— 同输入必同结果。
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
/** 基础省目标格数（v0.7：目标 30-60，允许 15-90 边缘） */
export const PROVINCE_MIN = 15;
export const PROVINCE_MAX = 60;
/** 山脉界线：山脊格最小海拔（海拔局部极大值且 ≥ 该值 → 天然省界，不跨脊合并） */
export const RIDGE_MIN_H = 50;

// ---- v0.6/v0.7 省份后处理参数 ----
/** 省目标格数（拆分目标） */
export const PROVINCE_TARGET = 45;
/** 超过该格数拆分为多省（v0.7 合并上限 ≤ PROVINCE_SIZE_MAX=90，故仅作纯安全兜底，正常不触发） */
export const PROVINCE_SPLIT_MAX = 90;
/** 小于该格数并入相邻省 */
export const PROVINCE_MERGE_MIN = 8;
/** 大陆块格数 ≤ 该值视为「海岛」（参与海岛归并） */
export const ISLAND_MAX_CELLS = 60;
/** 相邻海岛归并阈值：两岛陆地间最近格距（px，环绕） < 该值 */
export const ISLAND_MERGE_DIST = 35;
/** 海岛归并后省份格数上限（避免合并出超大省） */
export const ISLAND_MERGE_MAX_COMBINED = 90;
/** 结果省格数允许范围（sim 断言用；海峡要道等少量边缘例外） */
export const PROVINCE_SIZE_MIN = 8;
export const PROVINCE_SIZE_MAX = 90;

/** v0.6 紧凑度基线（紧凑度均值，sim 断言「v0.7 均值提升」用） */
export const PROVINCE_COMPACTNESS_BASELINE = 0.3519;
/** 长条省判定阈值：省包围盒长宽比 > 该值 视为长条 */
export const PROVINCE_ASPECT_LONG = 2.5;
/** 长条省占比上限（sim 断言 < 20%） */
export const PROVINCE_LONG_SHARE_MAX = 0.2;

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
  /** 所辖县（内嵌对象，含各自的格；山脊格并入时挂到种子县所在省，counties 不含纯山脊簇） */
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

// ---- v0.7 山脊与紧凑度聚类 ----

/** 海拔带（floor(h/15)：0-5） */
export function elevBandOf(h: number): number {
  return Math.floor(h / 15);
}

/**
 * 山脊格：海拔 ≥ RIDGE_MIN_H 且不矮于任何陆地邻居、且至少一个陆地邻居更矮
 * （峰顶 / 山脊线 / 台地边缘 = 海拔局部极大值域）。
 * 山脊格不参与县/省合并 —— 山脉=天然省界，两侧永不跨脊合并。
 */
export function isRidgeCell(cell: CellData, cellsById: Map<number, CellData>): boolean {
  if (cell.h < RIDGE_MIN_H) return false;
  let hasLower = false;
  for (const nb of cell.neighbors) {
    const nbC = cellsById.get(nb);
    if (!nbC || !nbC.land) continue;
    if (nbC.h > cell.h) return false; // 有更高邻居 → 非局部极大
    if (nbC.h < cell.h) hasLower = true;
  }
  return hasLower;
}

/** 构建期县（v0.7：无山脊格；同海拔带+同气候带紧凑聚类） */
interface GrowCounty {
  cellIds: number[];
  hSum: number;
  tempSum: number;
  precSum: number;
  /** 种子格海拔带（聚类锚点：候选格必须同带同气候） */
  seedElevBand: number;
  seedClimate: ClimateId;
}

/** 单元格到区域共享边数（= 该格与区域内格直接相邻的对数；周长增量 = -2×共享边数） */
function cellSharedEdges(cellId: number, region: Set<number>, cellsById: Map<number, CellData>): number {
  const cell = cellsById.get(cellId);
  if (!cell) return 0;
  let n = 0;
  for (const nb of cell.neighbors) if (region.has(nb)) n++;
  return n;
}

/** 两区域共享边数（跨区域陆邻对数；合并时周长增量 = -2×该值） */
function regionSharedEdges(
  a: Set<number>,
  b: Set<number>,
  cellsById: Map<number, CellData>,
): number {
  // 遍历较小集合
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const cid of small) {
    const cell = cellsById.get(cid);
    if (!cell) continue;
    for (const nb of cell.neighbors) if (big.has(nb)) n++;
  }
  return n;
}

/**
 * 单大陆块内：非山脊格 → 县 确定性区域生长（v0.7 同海拔带+同气候带 + 共享边优先）。
 * 山脊格（ridgeSet）不参与县聚类 —— 主生长/兜底/孤儿全部跳过，杜绝山脊格同时进县与山脊表。
 */
function growCountiesV7(
  nonRidgeCells: number[],
  cellsById: Map<number, CellData>,
  ridgeSet: Set<number>,
): GrowCounty[] {
  const n = nonRidgeCells.length;
  if (n === 0) return [];
  const sorted = [...nonRidgeCells].sort((a, b) => a - b);
  const target = Math.max(1, Math.round(n / COUNTY_TARGET));
  const stride = Math.max(1, Math.floor(n / target));

  // 种子：跨幅取「陆地邻最多」格（tie 取 id 小）
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
    return {
      cellIds: [sid],
      hSum: c.h,
      tempSum: c.temp,
      precSum: c.prec,
      seedElevBand: elevBandOf(c.h),
      seedClimate: c.climate,
    };
  });
  const assigned = new Map<number, number>();
  seeds.forEach((sid, ci) => assigned.set(sid, ci));
  const regionSet: Set<number>[] = counties.map((c) => new Set(c.cellIds));
  // 前沿：未分配且与区域相邻的格
  const frontierAll = new Set<number>();
  seeds.forEach((sid) => {
    const cell = cellsById.get(sid) as CellData;
    for (const nb of cell.neighbors) {
      const nbC = cellsById.get(nb);
      if (nbC && nbC.land && !assigned.has(nb)) frontierAll.add(nb);
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
    regionSet[ci].add(cid);
    for (const nb of cell.neighbors) {
      const nbC = cellsById.get(nb);
      if (nbC && nbC.land && !assigned.has(nb)) frontierAll.add(nb);
    }
  };

  // 主生长：每次选「共享边最多」的 (区域, 格) 对；候选须同海拔带+同气候带
  while (assigned.size < n) {
    let bestCi = -1;
    let bestCell = -1;
    let bestEdges = -1;
    for (let ci = 0; ci < counties.length; ci++) {
      const county = counties[ci];
      if (county.cellIds.length >= COUNTY_MAX) continue;
      const rs = regionSet[ci];
      for (const cid of frontierAll) {
        if (assigned.has(cid)) continue;
        if (ridgeSet.has(cid)) continue; // 山脊格不参与县聚类
        const cell = cellsById.get(cid);
        if (!cell) continue;
        if (elevBandOf(cell.h) !== county.seedElevBand) continue;
        if (cell.climate !== county.seedClimate) continue;
        const edges = cellSharedEdges(cid, rs, cellsById);
        if (edges <= 0) continue; // 必须与区域直接相邻（保持县连通）
        const tie =
          edges > bestEdges ||
          (edges === bestEdges && (bestCi === -1 || ci < bestCi || (ci === bestCi && cid < bestCell)));
        if (tie) {
          bestEdges = edges;
          bestCi = ci;
          bestCell = cid;
        }
      }
    }
    if (bestCi !== -1) {
      assign(bestCi, bestCell);
      continue;
    }
    break; // 无同带同气候候选 → 进入兜底
  }

  // 兜底：剩余格并入「共享边最多」的相邻区域（tie 区域 id 小）；无相邻 → 自成一县
  while (assigned.size < n) {
    let bestCi = -1;
    let bestCell = -1;
    let bestEdges = -1;
    for (const cid of frontierAll) {
      if (assigned.has(cid)) continue;
      if (ridgeSet.has(cid)) continue; // 山脊格不参与县聚类
      let bi = -1;
      let be = -1;
      for (let ci = 0; ci < counties.length; ci++) {
        if (counties[ci].cellIds.length >= COUNTY_MAX) continue;
        const e = cellSharedEdges(cid, regionSet[ci], cellsById);
        if (e <= 0) continue; // 必须与区域直接相邻（保持县连通）
        if (e > be || (e === be && (bi === -1 || ci < bi))) {
          be = e;
          bi = ci;
        }
      }
      if (bi === -1) continue;
      const tie =
        be > bestEdges ||
        (be === bestEdges && (bestCi === -1 || bi < bestCi || (bi === bestCi && cid < bestCell)));
      if (tie) {
        bestEdges = be;
        bestCi = bi;
        bestCell = cid;
      }
    }
    if (bestCi !== -1) {
      assign(bestCi, bestCell);
      continue;
    }
    // 完全孤立的格（无任何陆地邻已分配）：自成一县
    let orphan = -1;
    for (const cid of sorted) {
      if (!assigned.has(cid)) {
        orphan = cid;
        break;
      }
    }
    if (orphan === -1) break;
    const c = cellsById.get(orphan) as CellData;
    counties.push({
      cellIds: [orphan],
      hSum: c.h,
      tempSum: c.temp,
      precSum: c.prec,
      seedElevBand: elevBandOf(c.h),
      seedClimate: c.climate,
    });
    assigned.set(orphan, counties.length - 1);
    regionSet.push(new Set([orphan]));
  }

  // 合并 < COUNTY_MIN 的县到「共享边最多」的相邻县（优先同带同气候，其次任意）
  const list = counties.slice();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 128) {
    changed = false;
    let ti = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].cellIds.length < COUNTY_MIN && (ti === -1 || list[i].cellIds.length < list[ti].cellIds.length)) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tiny = list[ti];
    const tinySet = new Set(tiny.cellIds);
    let bj = -1;
    let bestEdges = -1;
    let bestEdgesAny = -1;
    let bjAny = -1;
    for (let j = 0; j < list.length; j++) {
      if (j === ti) continue;
      const e = regionSharedEdges(tinySet, new Set(list[j].cellIds), cellsById);
      if (e <= 0) continue;
      const sameGeo =
        list[j].seedElevBand === tiny.seedElevBand && list[j].seedClimate === tiny.seedClimate;
      if (sameGeo && (e > bestEdges || (e === bestEdges && (bj === -1 || j < bj)))) {
        bestEdges = e;
        bj = j;
      }
      if (e > bestEdgesAny || (e === bestEdgesAny && (bjAny === -1 || j < bjAny))) {
        bestEdgesAny = e;
        bjAny = j;
      }
    }
    const target = bj !== -1 ? bj : bjAny;
    if (target === -1) break;
    list[target].cellIds.push(...tiny.cellIds);
    list[target].hSum += tiny.hSum;
    list[target].tempSum += tiny.tempSum;
    list[target].precSum += tiny.precSum;
    list.splice(ti, 1);
    changed = true;
  }
  return list;
}

/**
 * v0.7 紧凑并省：县 → 省（共享边界边数最大 = 周长增量最小，杜绝长条怪形）。
 * 目标 30-60 格：反复把「最小省」并入「共享边最多」的邻省（合并后 ≤ PROVINCE_MAX 优先，
 * 其次 ≤ PROVINCE_SIZE_MAX），直到所有省 ≥ PROVINCE_TARGET(45) 或无可合并。
 * 每次合并都保持连通（两连通区共享边>0 → 合并仍连通）→ 单大陆块省必然连通。
 * 山脊格不参与县聚类 → 跨脊合并结构上不可能。
 */
function mergeProvincesV7(
  landCounties: GrowCounty[],
  cellsById: Map<number, CellData>,
): number[][] {
  if (landCounties.length === 0) return [];
  // 区域 = 县索引集合；cells 集合缓存（初始每县一区，全部连通）
  const regions: Set<number>[] = landCounties.map((_, i) => new Set([i]));
  const regionCells: Set<number>[] = landCounties.map((c) => new Set(c.cellIds));
  const sizeOf = (r: number): number => regionCells[r].size;

  let guard = 0;
  while (guard++ < 8192) {
    // 最小省（< PROVINCE_TARGET；跳过已被并入清空的区）
    let ti = -1;
    let tiSize = Infinity;
    for (let r = 0; r < regions.length; r++) {
      if (regions[r].size === 0) continue;
      const s = sizeOf(r);
      if (s < PROVINCE_TARGET && s < tiSize) {
        tiSize = s;
        ti = r;
      }
    }
    if (ti === -1) break;
    // 候选邻省：先找「合并后 ≤ PROVINCE_MAX(60)」中共享边最多者；无则放宽到 ≤ PROVINCE_SIZE_MAX(90)
    let best = -1;
    let bestEdges = -1;
    let best60 = -1;
    let best60Edges = -1;
    for (let r = 0; r < regions.length; r++) {
      if (r === ti || regions[r].size === 0) continue;
      const e = regionSharedEdges(regionCells[ti], regionCells[r], cellsById);
      if (e <= 0) continue;
      const combined = tiSize + sizeOf(r);
      if (combined > PROVINCE_SIZE_MAX) continue;
      if (e > bestEdges || (e === bestEdges && r < best)) {
        bestEdges = e;
        best = r;
      }
      if (combined <= PROVINCE_MAX && (e > best60Edges || (e === best60Edges && r < best60))) {
        best60Edges = e;
        best60 = r;
      }
    }
    if (best === -1) break; // 无候选（孤岛县/邻域全超限）→ 保留为边缘例外
    const pick = best60 !== -1 ? best60 : best;
    // 并入：pick 吸收 ti
    for (const ci of regions[ti]) regions[pick].add(ci);
    for (const cid of regionCells[ti]) regionCells[pick].add(cid);
    regions[ti].clear();
    regionCells[ti].clear();
  }

  // 输出非空区域（省 = 县索引数组），按区域 id 升序
  const out: number[][] = [];
  for (let r = 0; r < regions.length; r++) {
    if (regions[r].size === 0) continue;
    out.push([...regions[r]].sort((a, b) => a - b));
  }
  return out;
}

/** 县对是否格邻接（共享格邻边） */
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

// ---- v0.6/v0.7 省组与后处理（拆分/小省并入/海岛归并/山脊归属） ----

/**
 * 构建期省组：一组全局县索引 + 大陆块分量统计 + 山脊格列表。
 * 多岛省（海岛归并结果）的 landmassId = 格数最多的分量。
 */
interface ProvGroup {
  countyIdx: number[];
  lmCells: Map<number, number>;
  /** 并入该省的山脊格（id 升序；不属任何县） */
  ridgeCells: number[];
}

function groupCellCount(g: ProvGroup, allCounties: GrowCounty[]): number {
  let n = 0;
  for (const ci of g.countyIdx) n += allCounties[ci].cellIds.length;
  return n + g.ridgeCells.length;
}

function groupCells(g: ProvGroup, allCounties: GrowCounty[]): number[] {
  const out: number[] = [];
  for (const ci of g.countyIdx) out.push(...allCounties[ci].cellIds);
  out.push(...g.ridgeCells);
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

/** 省组 → 归属（地理规则；用于「同属国」归并分组） */
function groupOwner(g: ProvGroup, allCounties: GrowCounty[], cellsById: Map<number, CellData>, width: number, height: number): ProvinceOwner {
  const cent = centroidOf(groupCells(g, allCounties), cellsById);
  return assignProvinceOwnerV2(groupPrimaryLandmass(g), cent, width, height);
}

/** 归属判定顺序（多数票 tie-break 用；与 NationId 无关的稳定序） */
const OWNER_ORDER: ProvinceOwner[] = [
  'empire', 'lorraine', 'ianys', 'orange', 'zalakN', 'zalakS', 'angland', 'normandy', 'undiscovered',
];

/**
 * v0.7 归属重派：按「格多数票」给省定属（每个陆地格按地理区域规则 assignProvinceOwnerV2，
 * 多数者胜；tie 按 OWNER_ORDER 稳定序）。比质心判定更稳 —— 大省不会被质心偏移带错国。
 */
function ownerByMajority(
  g: ProvGroup,
  allCounties: GrowCounty[],
  cellOfLandmass: Map<number, number>,
  cellsById: Map<number, CellData>,
  width: number,
  height: number,
): ProvinceOwner {
  const counts = new Map<ProvinceOwner, number>();
  const tally = (cid: number): void => {
    const cell = cellsById.get(cid);
    if (!cell) return;
    const lm = cellOfLandmass.get(cid) ?? -1;
    const o = assignProvinceOwnerV2(lm, { x: (cell.bbox.minX + cell.bbox.maxX) / 2, y: (cell.bbox.minY + cell.bbox.maxY) / 2 }, width, height);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  };
  for (const ci of g.countyIdx) for (const cid of allCounties[ci].cellIds) tally(cid);
  for (const rc of g.ridgeCells) tally(rc);
  let best: ProvinceOwner = 'undiscovered';
  let bestN = -1;
  for (const o of OWNER_ORDER) {
    const n = counts.get(o) ?? 0;
    if (n > bestN) {
      bestN = n;
      best = o;
    }
  }
  return best;
}

/** 山脊格归属：并入「共享边最多」的相邻省；无相邻（纯山脊簇）按同大陆块最近省；仍无 → 独立成省 */
function assignRidgeCells(
  groups: ProvGroup[],
  allCounties: GrowCounty[],
  ridgeCells: number[],
  cellOfLandmass: Map<number, number>,
  cellsById: Map<number, CellData>,
): ProvGroup[] {
  if (ridgeCells.length === 0) return groups;
  const out = groups.map((g) => ({ ...g, ridgeCells: [] as number[] }));
  // 每组格集合（不含山脊）用于共享边计算
  const cellSets: Set<number>[] = out.map((g) => {
    const s = new Set<number>();
    for (const ci of g.countyIdx) for (const cid of allCounties[ci].cellIds) s.add(cid);
    return s;
  });
  const unassigned = new Set<number>(ridgeCells);

  // 1) 有相邻省者：共享边最多（tie 省 id 小；避免把省顶过 PROVINCE_SIZE_MAX）
  for (const rc of ridgeCells) {
    if (!unassigned.has(rc)) continue;
    const cell = cellsById.get(rc);
    if (!cell) continue;
    let best = -1;
    let bestEdges = -1;
    for (let g = 0; g < out.length; g++) {
      if (cellSets[g].size + 1 > PROVINCE_SIZE_MAX) continue; // 顶格省不再接收山脊
      const e = cellSharedEdges(rc, cellSets[g], cellsById);
      if (e > bestEdges || (e === bestEdges && (best === -1 || g < best))) {
        bestEdges = e;
        best = g;
      }
    }
    if (best !== -1 && bestEdges > 0) {
      out[best].ridgeCells.push(rc);
      cellSets[best].add(rc);
      unassigned.delete(rc);
    }
  }
  // 2) 剩余（纯山脊簇/无邻）：按「同大陆块最近省质心」并入（环绕距离；避免顶过 PROVINCE_SIZE_MAX）
  if (unassigned.size > 0) {
    const width = 1920;
    for (const rc of [...unassigned].sort((a, b) => a - b)) {
      const cell = cellsById.get(rc);
      if (!cell) continue;
      const lm = cellOfLandmass.get(rc) ?? -1;
      let best = -1;
      let bestD = Infinity;
      for (let g = 0; g < out.length; g++) {
        if (cellSets[g].size + 1 > PROVINCE_SIZE_MAX) continue;
        const gLm = groupPrimaryLandmass(out[g]);
        if (gLm !== lm && gLm !== -1) continue;
        const cent = centroidOf(groupCells(out[g], allCounties), cellsById);
        const d = wrappedDistanceXY(cell.polygon[0].x, cell.polygon[0].y, cent.x, cent.y, width);
        if (d < bestD || (d === bestD && (best === -1 || g < best))) {
          bestD = d;
          best = g;
        }
      }
      if (best !== -1) {
        out[best].ridgeCells.push(rc);
        cellSets[best].add(rc);
        unassigned.delete(rc);
      } else {
        // 3) 理论兜底：独立成省（纯山脊岛）
        const lmCells = new Map<number, number>();
        lmCells.set(lm, 1);
        out.push({ countyIdx: [], lmCells, ridgeCells: [rc] });
        cellSets.push(new Set([rc]));
        unassigned.delete(rc);
      }
    }
  }
  return out;
}

/**
 * 大省拆分：> PROVINCE_SPLIT_MAX 格的省切成目标 ~PROVINCE_TARGET 的多省。
 * v0.7 紧凑版：片生长沿「共享边最多」的县扩展（周长增量最小）。
 * 确定性：种子 = 剩余县中格数最多者（tie 索引小）；末尾 < PROVINCE_MERGE_MIN 的片并入相邻片。
 */
function splitLargeGroupV7(
  g: ProvGroup,
  allCounties: GrowCounty[],
  adj: Set<number>[],
  cellOfLandmass: Map<number, number>,
  cellsById: Map<number, CellData>,
): ProvGroup[] {
  const sizeOf = (ci: number): number => allCounties[ci].cellIds.length;
  const lmOfCounty = (ci: number): number => cellOfLandmass.get(allCounties[ci].cellIds[0]) ?? -1;

  const total = g.countyIdx.reduce((s, ci) => s + sizeOf(ci), 0);
  const pieceCount = Math.max(2, Math.ceil(total / PROVINCE_TARGET));
  const remaining = new Set<number>(g.countyIdx);
  const pieces: number[][] = [];

  // 1) 前 pieceCount-1 片：种子=格数最多县，前沿按「共享边最多」扩展至 ≥ PROVINCE_TARGET
  for (let p = 0; p < pieceCount - 1 && remaining.size > 0; p++) {
    let seed = -1;
    for (const i of remaining) {
      if (seed === -1 || sizeOf(i) > sizeOf(seed)) seed = i;
    }
    const piece: number[] = [seed];
    remaining.delete(seed);
    let size = sizeOf(seed);
    while (size < PROVINCE_TARGET) {
      // 找「与片共享边最多」的剩余县
      let cand = -1;
      let candEdges = -1;
      const pieceCells = new Set<number>();
      for (const ci of piece) for (const cid of allCounties[ci].cellIds) pieceCells.add(cid);
      for (const i of remaining) {
        const e = regionSharedEdges(pieceCells, countyCellSet(allCounties, i), cellsById);
        if (e > candEdges || (e === candEdges && (cand === -1 || i < cand))) {
          candEdges = e;
          cand = i;
        }
      }
      if (cand === -1 || candEdges <= 0) break;
      remaining.delete(cand);
      piece.push(cand);
      size += sizeOf(cand);
    }
    pieces.push(piece);
  }
  // 2) 最后一片 = 全部剩余县（可为断片/多岛）
  if (remaining.size > 0) pieces.push([...remaining]);

  // 3) 借县补足：< PROVINCE_MERGE_MIN 的片从相邻片「借」共享边最多的最小县
  let guard = 0;
  while (guard++ < 64) {
    let ti = -1;
    for (let i = 0; i < pieces.length; i++) {
      const nn = pieces[i].reduce((s, ci) => s + sizeOf(ci), 0);
      if (nn < PROVINCE_MERGE_MIN && (ti === -1 || nn < pieces[ti].reduce((s, ci) => s + sizeOf(ci), 0))) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tinySet = new Set(pieces[ti]);
    // 候选借出县：优先与 tiny 片邻接（共享边>0）且格数最小者；无邻接时任意片最小县
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
    // 4) 兜底吸收：并入合并后最小的相邻片
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
    return { countyIdx: piece, lmCells, ridgeCells: [] };
  });
}

/** 辅助：县内格集合（共享边计算用） */
function countyCellSet(allCounties: GrowCounty[], ci: number): Set<number> {
  return new Set(allCounties[ci].cellIds);
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
 * 小省并入（v0.7）：< PROVINCE_MERGE_MIN 格的省并入「共享边最多」的相邻省；
 * 无相邻省（海岛/山脊隔断）则并入「同属国」最近邻省（环绕格距最小，保留 v0.6 行为）。
 * 确定性：按省 id 升序反复处理最小者。
 */
function mergeTinyGroupsV7(
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
    const tinyCells = new Set(cellsOf(tiny));
    const tinyOwner = groupOwner(tiny, allCounties, cellsById, width, height);
    // 1) 相邻省（共享边>0）：共享边最多优先（tie 省 id 小）；合并后 ≤ PROVINCE_SIZE_MAX
    let bj = -1;
    let bestEdges = -1;
    for (let j = 0; j < list.length; j++) {
      if (j === ti) continue;
      const e = regionSharedEdges(tinyCells, new Set(cellsOf(list[j])), cellsById);
      if (e <= 0) continue;
      if (groupCellCount(tiny, allCounties) + groupCellCount(list[j], allCounties) > PROVINCE_SIZE_MAX) continue;
      if (e > bestEdges || (e === bestEdges && (bj === -1 || j < bj))) {
        bestEdges = e;
        bj = j;
      }
    }
    // 2) 无相邻 → 同属国最近邻（环绕格距最小，v0.6 行为；海岛并入；合并后 ≤ PROVINCE_SIZE_MAX）
    if (bj === -1) {
      let bestD = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (j === ti) continue;
        const other = list[j];
        if (groupOwner(other, allCounties, cellsById, width, height) !== tinyOwner) continue;
        if (groupCellCount(tiny, allCounties) + groupCellCount(other, allCounties) > PROVINCE_SIZE_MAX) continue;
        const d = minCellDistBetween(dc, cellsOf(tiny), cellsOf(other), bestD);
        if (d < bestD || (d === bestD && (bj === -1 || j < bj))) {
          bestD = d;
          bj = j;
        }
      }
    }
    if (bj === -1) break; // 无候选 → 保留为边缘例外（如盎格伦撒极小岛省）
    // 并入
    const target = list[bj];
    target.countyIdx.push(...tiny.countyIdx);
    target.ridgeCells.push(...tiny.ridgeCells);
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
      // 合并 j 入 i（实时复查上限：i 可能已吸收多个岛而变大）
      const a = list[c.i];
      const b = list[c.j];
      if (groupCellCount(a, allCounties) + groupCellCount(b, allCounties) > ISLAND_MERGE_MAX_COMBINED) continue;
      a.countyIdx.push(...b.countyIdx);
      a.ridgeCells.push(...b.ridgeCells);
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
 * v0.5 的手调条目已区域化进 assignProvinceOwnerV2（按大陆块 + 质心区域，不依赖省份 id），
 * 因此本表默认空；编辑器（localStorage kalt-border-edits）与导出 JSON 仍按此格式覆盖。
 * v0.7 省份 id 再次重构 → 旧 localStorage 覆盖因 id 失效（App 侧提示清空重建）。
 */
export const PROVINCE_OWNER_OVERRIDES: Record<number, ProvinceOwner> = {};

/** 海峡判定阈值（格质心间最近距离 px；小于阈值视为窄海/交通要道）。
 * 实测：凯森海峡哨岛对 ≈24、盎格伦撒群岛对 ≈38、奥兰治西南群岛对 ≈31 —— 阈值 40 恰好只标记要道。 */
export const STRAIT_DIST = 40;

/**
 * v0.6/v0.7 八国划分（按大陆块 id + 省质心区域 + 覆盖表；确定性；沿用 v0.5 原则）：
 *  - 右侧新大陆 x >= 0.6W 保持未探明（不动）
 *  - LM0 北大陆：中央低地 → 南扎拉克；南端 → 诺曼尼亚；其余 → 帝国（北+西）
 *  - LM1/2/3/4/6/7 北境群岛 → 帝国
 *  - LM13/16/17 西大陆 → 洛林（西岸）；LM18 凯森海峡西岸哨岛 → 奥兰治；LM20 东岸哨岛 → 盎格伦撒
 *  - LM19 南大陆中央：西端/南端 → 诺曼尼亚；北 → 北扎拉克；其余 → 南扎拉克
 *  - LM21/30/31 东岸工业带 → 伊尼亚斯
 *  - LM9/12/14/15 中北群岛 → 盎格伦撒（群岛）
 *  - LM24/26/27/29/32/33/34/35 西南群岛 → 奥兰治（南部沿海低地）
 */
function assignProvinceOwnerV2(lmId: number, c: Point, width: number, height: number): ProvinceOwner {
  if (c.x >= width * FOG_X_RATIO) return 'undiscovered';
  switch (lmId) {
    case 0:
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
      return 'orange'; // 凯森海峡西岸哨岛
    case 20:
      return 'angland'; // 凯森海峡东岸哨岛
    case 19:
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

/** 计算各省「海峡省份」标记（沿海且与异大陆块最近环绕格距 < STRAIT_DIST）。 */
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

  // 山脊格：海拔局部极大值（> 所有陆地邻居，≥ RIDGE_MIN_H）—— 天然省界，不跨脊合并
  const ridgeCells: number[] = [];
  const ridgeSet = new Set<number>();
  for (const cid of landCellIds) {
    const cell = cellsById.get(cid);
    if (cell && isRidgeCell(cell, cellsById)) {
      ridgeCells.push(cid);
      ridgeSet.add(cid);
    }
  }
  ridgeCells.sort((a, b) => a - b);

  // ---- 三级制：大陆块内 非山脊格→县（同海拔带+同气候带）→ 省（紧凑合并） ----
  const allCounties: GrowCounty[] = []; // 全局累计
  const baseProvinceCountyIdx: number[][] = []; // 每省 = 全局县索引数组
  const baseProvinceLandmass: number[] = []; // 每省所在大陆块

  landmasses.forEach((lmCells, lmId) => {
    const nonRidge = lmCells.filter((cid) => !ridgeSet.has(cid));
    const grown = growCountiesV7(nonRidge, cellsById, ridgeSet);
    const provIdx = mergeProvincesV7(grown, cellsById);
    const base = allCounties.length;
    grown.forEach((c) => {
      allCounties.push(c);
    });
    provIdx.forEach((countyIdxList) => {
      baseProvinceCountyIdx.push(countyIdxList.map((ci) => base + ci));
      baseProvinceLandmass.push(lmId);
    });
  });

  // ---- v0.7 省组：紧凑重构（拆分 → 小省并入 → 山脊归属 → 海岛归并） ----
  const mkGroup = (countyIdx: number[], lmId: number): ProvGroup => {
    const lmCells = new Map<number, number>();
    for (const ci of countyIdx) {
      lmCells.set(lmId, (lmCells.get(lmId) ?? 0) + allCounties[ci].cellIds.length);
    }
    return { countyIdx, lmCells, ridgeCells: [] };
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

  // 1) 大省拆分（两轮：基础合并后 + 小省并入后，后者覆盖 60+ 的超限组合）
  const splitAll = (gs: ProvGroup[]): ProvGroup[] => {
    const out: ProvGroup[] = [];
    for (const g of gs) {
      if (groupCellCount(g, allCounties) > PROVINCE_SPLIT_MAX) {
        const pieces = splitLargeGroupV7(g, allCounties, countyAdj, cellOfLandmass, cellsById);
        out.push(...pieces);
      } else {
        out.push(g);
      }
    }
    return out;
  };
  groups = splitAll(groups);

  // 2) 小省并入（共享边最多；无邻省走同属国最近邻）
  const dc = buildDistCache(cellsById, landCellIds, width);
  groups = mergeTinyGroupsV7(groups, allCounties, dc, cellsById, width, height);
  // 2b) 小省并入可能把 60 格省顶到 61+ → 再拆一轮
  groups = splitAll(groups);

  // 3) 山脊格归属（并入共享边最多的相邻省；纯山脊簇按同大陆块最近省）
  groups = assignRidgeCells(groups, allCounties, ridgeCells, cellOfLandmass, cellsById);

  // 4) 海岛归并（同属国、不同大陆块、<35px）
  groups = mergeIslandGroups(groups, allCounties, dc, cellOfLandmass, cellsById, width, height);

  // 5) 小省并入（海岛归并后再收一轮：多岛省可能仍 < 8）
  groups = mergeTinyGroupsV7(groups, allCounties, dc, cellsById, width, height);

  // 6) 重新计算每个组的 landmass 分量（多岛省）
  const finalGroups = groups.map((g) => {
    const lmCells = new Map<number, number>();
    for (const ci of g.countyIdx) {
      const cid = allCounties[ci].cellIds[0];
      const lm = cellOfLandmass.get(cid) ?? -1;
      lmCells.set(lm, (lmCells.get(lm) ?? 0) + allCounties[ci].cellIds.length);
    }
    for (const rc of g.ridgeCells) {
      const lm = cellOfLandmass.get(rc) ?? -1;
      lmCells.set(lm, (lmCells.get(lm) ?? 0) + 1);
    }
    return { countyIdx: g.countyIdx, lmCells, ridgeCells: g.ridgeCells };
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
    cellIds.push(...g.ridgeCells);

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
    const baseOwner = ownerByMajority(g, allCounties, cellOfLandmass, cellsById, width, height);
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

/** 省包围盒长宽比（长轴/短轴；长条省判定用） */
export function provinceAspect(map: GameMap, prov: Province): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cid of prov.cellIds) {
    const c = map.cellsById.get(cid);
    if (!c) continue;
    if (c.bbox.minX < minX) minX = c.bbox.minX;
    if (c.bbox.minY < minY) minY = c.bbox.minY;
    if (c.bbox.maxX > maxX) maxX = c.bbox.maxX;
    if (c.bbox.maxY > maxY) maxY = c.bbox.maxY;
  }
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return Math.max(w, h) / Math.max(1e-9, Math.min(w, h));
}

/** 省离散紧凑度 = min(1, 4πn/P²)，n=格数，P=省边界边数（每条边界计一次） */
export function provinceCompactness(map: GameMap, prov: Province): number {
  const provSet = new Set(prov.cellIds);
  let p = 0;
  for (const cid of prov.cellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell) continue;
    for (const nb of cell.neighbors) {
      if (nb < cid) continue; // 规范方向：避免跨省边重复计数
      const nbCell = map.cellsById.get(nb);
      if (!nbCell || !nbCell.land || !provSet.has(nb)) p++;
    }
  }
  const n = Math.max(1, prov.cellIds.length);
  return Math.min(1, (4 * Math.PI * n) / (p * p));
}

/** v0.7 紧凑度统计（sim 断言用）：均值 / 长条省占比 / 最差紧凑度 */
export function compactnessStats(map: GameMap): {
  mean: number;
  longStripShare: number;
  longStripCount: number;
  min: number;
  max: number;
  worst: { id: number; cells: number; compactness: number; aspect: number }[];
} {
  const rows = map.provinces.map((p) => ({
    id: p.id,
    cells: p.cellIds.length,
    compactness: provinceCompactness(map, p),
    aspect: provinceAspect(map, p),
  }));
  const n = Math.max(1, rows.length);
  const mean = rows.reduce((s, r) => s + r.compactness, 0) / n;
  const long = rows.filter((r) => r.aspect > PROVINCE_ASPECT_LONG);
  const worst = [...rows].sort((a, b) => a.compactness - b.compactness).slice(0, 8);
  return {
    mean,
    longStripShare: long.length / n,
    longStripCount: long.length,
    min: Math.min(...rows.map((r) => r.compactness)),
    max: Math.max(...rows.map((r) => r.compactness)),
    worst,
  };
}

/** 山脊统计（sim 断言用）：山脊格总数 / 有跨省邻的山脊格占比（= 山脊两侧分属不同省） */
export function ridgeStats(map: GameMap): {
  ridgeCells: number;
  boundaryRidgeCells: number;
  boundaryShare: number;
  sample: { ridgeId: number; h: number; provs: number }[];
} {
  let ridgeCells = 0;
  let boundary = 0;
  const sample: { ridgeId: number; h: number; provs: number }[] = [];
  for (const cid of map.landCellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell || !isRidgeCell(cell, map.cellsById)) continue;
    ridgeCells++;
    const provOf = provOfCell(map, cid);
    const provs = new Set<number>();
    for (const nb of cell.neighbors) {
      const nbC = map.cellsById.get(nb);
      if (!nbC || !nbC.land) continue;
      const np = provOfCell(map, nb);
      if (np !== undefined) provs.add(np);
    }
    if (provs.size >= 2 || (provOf !== undefined && provs.size >= 1 && !provs.has(provOf))) boundary++;
    if (sample.length < 200) sample.push({ ridgeId: cid, h: cell.h, provs: provs.size });
  }
  return {
    ridgeCells,
    boundaryRidgeCells: boundary,
    boundaryShare: ridgeCells > 0 ? boundary / ridgeCells : 1,
    sample,
  };
}

/** 调试统计（sim 用；v0.7 增加紧凑度/山脊/规模分布） */
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
  const comp = compactnessStats(map);
  const ridge = ridgeStats(map);
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
    compactnessMean: comp.mean,
    longStripShare: comp.longStripShare,
    longStripCount: comp.longStripCount,
    ridgeCells: ridge.ridgeCells,
    ridgeBoundaryShare: ridge.boundaryShare,
  };
}
