/**
 * 地图导入器（v0.1 行政区三级制）：解析 Azgaar GridCells JSON → 游戏地图。
 *
 * 层级：cell（格）→ county（县）→ province（省）→ 国家辖区
 *  - cell：原始网格（陆地 = 海拔 h >= 20）
 *  - county：陆地格按自然地理（海拔带 / 气候 temp+prec 相似度）确定性区域生长，目标 5-15 格
 *  - province：县按自然地理合并（海拔突变=山脉为界、气候区相近、目标 20-80 格）
 *  - 国家：3 国（洛林/伊尼亚斯/帝国）按 v0.0.0 配色规则占有省份；大陆质心 x>=0.6W → 迷雾新大陆
 *
 * 确定性：全部算法仅依赖格 id 排序与固定比较次序，无 Math.random —— 同输入必同结果。
 * 逻辑与 tools/render_admin.py 保持一致：顶点坐标在 p 字段；陆地 = h >= 20。
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

/** 县目标格数（执行清单：5-15 格） */
export const COUNTY_TARGET = 9;
export const COUNTY_MIN = 5;
export const COUNTY_MAX = 15;
/** 省目标格数（执行清单：20-80 格） */
export const PROVINCE_MIN = 20;
export const PROVINCE_MAX = 55;
/** 山脉界线：两格相邻且海拔均 >= 65 → 视为山脉脊线，不跨省合并 */
export const RIDGE_H = 65;

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
  /** 大陆块 id（同一连通大陆上的省份共享） */
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

/**
 * 单个大陆块内：格 → 县 确定性区域生长。
 * 种子：按 id 排序取步长窗口内「陆地邻格最多」的格；生长：每轮全局取与县质心特征最相似的未分配邻格。
 */
function growCounties(
  landCells: number[],
  cellsById: Map<number, CellData>,
): GrowCounty[] {
  const n = landCells.length;
  if (n === 0) return [];
  const sorted = [...landCells].sort((a, b) => a - b);
  const target = Math.max(1, Math.round(n / COUNTY_TARGET));
  const stride = Math.max(1, Math.floor(n / target));

  // 种子选择：每窗口取邻陆最多的格（tie-break 格 id 小者优先）
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

  // 每县的前沿（未分配陆地邻格）
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
    // 主生长：县未满 15 格时按相似度扩张
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
    // 兜底：所有县已满（或无穷大），剩余格并入相似度最高的县（忽略上限）
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
    if (anyCi === -1) break; // 无前沿可扩（异常，理论上不会发生）
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
    // 找最小的 < COUNTY_MIN 的县（tie-break id 小）
    let ti = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].cellIds.length < COUNTY_MIN && (ti === -1 || list[i].cellIds.length < list[ti].cellIds.length)) {
        ti = i;
      }
    }
    if (ti === -1) break;
    const tiny = list[ti];
    // 找与其相似度最高的邻县
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
    if (bj === -1) break; // 孤立县，保留
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
  // 返回省列表，每项 = 县索引数组
  if (landCounties.length === 0) return [];
  const total = landCounties.reduce((s, c) => s + c.cellIds.length, 0);
  // 极小大陆：整体一省
  if (total <= PROVINCE_MIN) return [landCounties.map((_, i) => i)];

  // 县邻接（含山脉界）
  const adj: Set<number>[] = landCounties.map(() => new Set<number>());
  for (let i = 0; i < landCounties.length; i++) {
    for (let j = i + 1; j < landCounties.length; j++) {
      if (!countiesAdjacent(landCounties[i], landCounties[j], cellsById)) continue;
      if (hasRidgeBetween(landCounties[i], landCounties[j], cellsById)) continue; // 山脉不合并
      adj[i].add(j);
      adj[j].add(i);
    }
  }

  const sizeOf = (idx: number): number => landCounties[idx].cellIds.length;
  const unassigned = new Set<number>(landCounties.map((_, i) => i));
  const provinces: number[][] = [];

  while (unassigned.size > 0) {
    // 种子：未分配县中格数最多者（tie-break 索引小）
    let seed = -1;
    for (const i of unassigned) {
      if (seed === -1 || sizeOf(i) > sizeOf(seed)) seed = i;
    }
    const prov: number[] = [seed];
    unassigned.delete(seed);
    let size = sizeOf(seed);
    // 生长：选「气候带相近、平均海拔相近、邻接且无山脉」的县，目标 ≤ PROVINCE_MAX
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
        // 分数：气候/海拔相似（越大越好）；同时倾向接近 40 格目标的县尺寸
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

// ---- v0.5 国界重绘（人工梳理原则） ----
// 人工归属覆盖表（可手调）：省份 id → 属国，**优先于**下方地理规则。
// 下一轮微调只改这张表即可，无需动地理规则。
//   · 0   （北大陆中央低地，y≈0.49H）→ 南扎拉克（"扎拉克=中央"）
//   · 38  （凯森海峡西岸哨岛，块18）→ 奥兰治（控制海峡一侧）
//   · 45  （凯森海峡东岸哨岛，块20）→ 盎格伦撒（控制海峡一侧）
export const PROVINCE_OWNER_OVERRIDES: Record<number, ProvinceOwner> = {
  0: 'zalakS',
  38: 'orange',
  45: 'angland',
};

/** 海峡判定阈值（格质心间最近距离 px；小于阈值视为窄海/交通要道）。
 * 实测：凯森海峡哨岛对（块18↔块20）≈24、盎格伦撒群岛对（块14↔块15）≈38、
 * 奥兰治西南群岛对（块32↔块35）≈31 —— 阈值 40 恰好只标记这些要道，不误伤大陆本体。 */
export const STRAIT_DIST = 40;

/**
 * v0.5 八国划分（按大陆块 id + 省质心 + 手调覆盖表；确定性；与实测地图对齐）：
 *  - 右侧新大陆 x >= 0.6W 保持未探明（不动）
 *  - LM0 北大陆：**帝国 = 北部+西部**（y < 0.55H，不含中央 #0）；南端（y>=0.55H）→ 诺曼尼亚；
 *    中央 #0 由覆盖表划给南扎拉克 —— 帝国不再独占整块大陆
 *  - LM1/2/3/4/6/7 北境群岛 → 帝国
 *  - LM13/16/17 西大陆 → 洛林（西岸）；LM18/20 凯森海峡哨岛由覆盖表划给 奥兰治/盎格伦撒
 *  - LM19 南大陆中央：西端（x<=0.43W）或南端（y>=0.63H）→ 诺曼尼亚；北（y<0.47H）→ 北扎拉克；
 *    其余 → 南扎拉克（扎拉克=中央）
 *  - LM21/30/31 东岸工业带（铁+煤）→ 伊尼亚斯
 *  - LM9/12/14/15 中北群岛 → 盎格伦撒（群岛）
 *  - LM24/26/27/29/32/33/34/35 西南群岛 → 奥兰治（南部沿海低地）
 *
 * v0.4 旧规则（保留作对照）：
 *  - LM0：南端（y>=0.65H）→ 诺曼尼亚，其余 → 帝国
 *  - LM13/16/17/18/20 西岸 → 洛林；LM19 西端/南端 → 诺曼尼亚，北 → 北扎拉克，其余 → 南扎拉克
 *  - LM21/30/31 东岸 → 伊尼亚斯；LM9/12/14/15 群岛 → 盎格伦撒；LM24/26/27/29/32/33/34/35 → 奥兰治
 */
function assignProvinceOwner(lmId: number, c: Point, width: number, height: number): ProvinceOwner {
  if (c.x >= width * FOG_X_RATIO) return 'undiscovered';
  switch (lmId) {
    case 0:
      // 北大陆：诺曼尼亚=南端（y>=0.55H）；帝国=北部+西部（#0 中央由覆盖表划给南扎拉克）
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
      return 'lorraine'; // 西大陆（洛林西岸）；LM18/20 海峡哨岛 → 覆盖表
    case 18:
    case 20:
      return 'lorraine'; // 凯森海峡哨岛基准归属（覆盖表改写为 奥兰治/盎格伦撒）
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

/** 计算各省「海峡省份」标记（沿海且与异大陆块最近格距 < STRAIT_DIST）。
 * 只统计「已探明大陆块」之间的窄海（右侧迷雾新大陆不参与判定）。
 * 实测要道：凯森海峡哨岛对（块18↔块20 ≈24px，奥兰治#38 / 盎格伦撒#45）、
 * 盎格伦撒群岛对（块14↔块15 ≈27px，#32/#33）、奥兰治西南群岛对（块32↔块35 ≈31px，#63/#66）。 */
export function computeStraitFlags(map: GameMap): void {
  // 迷雾大陆块（不参与窄海判定）
  const fogLandmasses = new Set<number>();
  for (const p of map.provinces) {
    if (p.isUndiscovered) fogLandmasses.add(p.landmassId);
  }
  // 格质心
  const cellCent = new Map<number, Point>();
  const cellBBox = new Map<number, BBox>();
  for (const cid of map.landCellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell) continue;
    let cx = 0, cy = 0;
    for (const p of cell.polygon) {
      cx += p.x;
      cy += p.y;
    }
    cellCent.set(cid, { x: cx / cell.polygon.length, y: cy / cell.polygon.length });
    cellBBox.set(cid, cell.bbox);
  }
  const lmOfCell = new Map<number, number>();
  for (const p of map.provinces) {
    for (const cid of p.cellIds) lmOfCell.set(cid, p.landmassId);
  }
  for (const prov of map.provinces) {
    prov.isStrait = false;
    if (prov.isUndiscovered) continue;
    let min = Infinity;
    for (const cid of prov.cellIds) {
      const c = cellCent.get(cid);
      const cb = cellBBox.get(cid);
      if (!c || !cb) continue;
      for (const other of map.landCellIds) {
        const otherLm = lmOfCell.get(other);
        if (otherLm === undefined || otherLm === prov.landmassId) continue;
        if (fogLandmasses.has(otherLm)) continue; // 迷雾不参与
        const oc = cellCent.get(other);
        const ob = cellBBox.get(other);
        if (!oc || !ob) continue;
        // bbox 剪枝（快速排除远格）
        if (ob.minX > cb.maxX + STRAIT_DIST || ob.maxX < cb.minX - STRAIT_DIST) continue;
        if (ob.minY > cb.maxY + STRAIT_DIST || ob.maxY < cb.minY - STRAIT_DIST) continue;
        const dx = c.x - oc.x;
        const dy = c.y - oc.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < min) min = d;
      }
    }
    prov.isStrait = min <= STRAIT_DIST;
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

  // ---- 三级制：大陆块内 格→县→省 ----
  const allCounties: GrowCounty[] = []; // 全局累计
  const provinceCountyIdx: number[][] = []; // 每省 = 全局县索引数组
  const provinceLandmass: number[] = []; // 每省所在大陆块

  landmasses.forEach((lmCells, lmId) => {
    const grown = growCounties(lmCells, cellsById);
    const merged = mergeTinyCounties(grown, cellsById);
    const provIdx = mergeProvinces(merged, cellsById);
    const base = allCounties.length;
    merged.forEach((c) => {
      allCounties.push(c);
    });
    provIdx.forEach((countyIdxList) => {
      provinceCountyIdx.push(countyIdxList.map((ci) => base + ci));
      provinceLandmass.push(lmId);
    });
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

  // 省对象（含内嵌县、气候、海拔统计）
  const provinces: Province[] = provinceCountyIdx.map((countyIdxList, pid) => {
    const lmId = provinceLandmass[pid];
    const provCounties: County[] = countyIdxList.map((ci) => counties[ci]);
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
    // v0.5：手调覆盖表优先于地理规则（支持 config 显式覆盖，便于下一轮微调）
    const baseOwner = assignProvinceOwner(lmId, cent, width, height);
    const owner = PROVINCE_OWNER_OVERRIDES[pid] ?? baseOwner;
    return {
      id: pid,
      counties: provCounties,
      countyIds: countyIdxList,
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

  const map: GameMap = { width, height, seed, cellsById, landCellIds, counties, countyById, provinces, provinceById };
  computeStraitFlags(map); // v0.5：海峡省份判定
  return map;
}

/** 省份-归属表（v0.5 审查输出）：id / 质心 / 格数 / 沿海 / 海峡 / 属国 */
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

/** 调试统计（sim 用） */
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
    undiscoveredProvinces: map.provinces.filter((p) => p.isUndiscovered).length,
    nationCells,
    climateCount,
  };
}
