import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameMap, Province } from '../game/map';
import { cellIsBoundary, cellIsCountyBoundary, findCellAt, provOfCell } from '../game/map';
import { CLIMATE_LABEL, TERRAIN_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import { NATIONS, UNDISCOVERED_RGB } from '../game/nations';
import { provinceLuxuryPotential } from '../game/pops';
import { provinceResourceLabels } from '../game/resources';
import { BASE_PRICE, GOODS_LIST } from '../game/market';
import type { ClimateId, ProvinceOwner, TerrainKind } from '../game/types';

type MapView = 'political' | 'terrain' | 'population' | 'output';

interface View {
  scale: number;
  offsetX: number; // 世界坐标左上角
  offsetY: number;
}

interface Props {
  map: GameMap;
  game: GameState;
  selectedProvince: number | null;
  onSelect: (provinceId: number | null) => void;
  /** v0.6 独立编辑模式 */
  editMode?: boolean;
  editNation?: ProvinceOwner;
  onPaintProvince?: (provId: number) => void;
  /** 编辑操作触发重绘的戳（每次编辑/撤销/重做/清空自增） */
  editStamp?: number;
}

const NATION_BORDER = '#0c1118';
const PROV_BORDER = 'rgba(255,255,255,0.5)';
const COUNTY_BORDER = 'rgba(255,255,255,0.16)';
const FOG_BORDER = 'rgba(150,165,190,0.8)';
const SELECT_COLOR = '#35c46b';
const COAST_LINE = 'rgba(240,246,255,0.55)';
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

/** v0.5 地形底图（public 静态资源；与地图同尺寸 1920x1080，含经纬网格） */
const RELIEF_SRC = '/kalte_relief.png';
/** 国家覆盖不透明度（v0.5：半透明叠加于底图） */
const NATION_ALPHA = 0.55;
/** 迷雾新大陆覆盖（保持深灰） */
const FOG_FILL = 'rgba(34,44,60,0.92)';
/** 经纬网格显示缩放范围（仅缩小视图时显示，避免放大后杂乱） */
const GRID_MIN_SCALE = 0.25;
const GRID_MAX_SCALE = 1.5;

// ---- 海洋水深渐变（h 0-19：深→浅） ----
const OCEAN_DEEP = [6, 12, 26];
const OCEAN_SHALLOW = [38, 92, 148];
function oceanColor(h: number): string {
  const t = clamp01(h / 19);
  const r = Math.round(OCEAN_DEEP[0] + (OCEAN_SHALLOW[0] - OCEAN_DEEP[0]) * t);
  const g = Math.round(OCEAN_DEEP[1] + (OCEAN_SHALLOW[1] - OCEAN_DEEP[1]) * t);
  const b = Math.round(OCEAN_DEEP[2] + (OCEAN_SHALLOW[2] - OCEAN_DEEP[2]) * t);
  return `rgb(${r},${g},${b})`;
}

// ---- 陆地：地形底色 × 气候修正（程序化兜底） ----
const TERRAIN_BASE: Record<TerrainKind, [number, number, number]> = {
  plain: [148, 168, 108],
  hill: [158, 146, 96],
  mountain: [140, 132, 122],
};
const CLIMATE_TINT: Record<ClimateId, [number, number, number]> = {
  arctic: [210, 218, 226],
  coldTemp: [158, 178, 158],
  temperate: [150, 176, 116],
  humid: [108, 158, 106],
  dry: [196, 176, 106],
};
function landColor(terrain: TerrainKind, climate: ClimateId): string {
  const base = TERRAIN_BASE[terrain];
  const tint = CLIMATE_TINT[climate];
  const r = Math.round((base[0] + tint[0]) / 2);
  const g = Math.round((base[1] + tint[1]) / 2);
  const b = Math.round((base[2] + tint[2]) / 2);
  return `rgb(${r},${g},${b})`;
}

// ---- 视图色阶 ----
const POP_LOW: [number, number, number] = [47, 125, 69]; // 绿
const POP_MID: [number, number, number] = [226, 196, 92]; // 黄
const POP_HIGH: [number, number, number] = [181, 71, 47]; // 红
const OUT_LOW: [number, number, number] = [70, 110, 200]; // 蓝
const OUT_MID: [number, number, number] = [166, 168, 190];
const OUT_HIGH: [number, number, number] = [230, 140, 40]; // 橙

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/** 三段色阶 */
function rampColor(stops: [[number, number, number], [number, number, number], [number, number, number]], t: number): string {
  if (t <= 0.5) return lerpColor(stops[0], stops[1], t * 2);
  return lerpColor(stops[1], stops[2], (t - 0.5) * 2);
}

function rgbStr(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** 国家半透明覆盖（视觉柔和，保留地形/气候信息） */
function nationWash(owner: string, alpha: number): string {
  const rgb = NATIONS[owner as keyof typeof NATIONS]?.rgb ?? UNDISCOVERED_RGB;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 归属中文名（含迷雾锁） */
function ownerName(owner: ProvinceOwner): string {
  if (owner === 'undiscovered') return '迷雾锁';
  return NATIONS[owner]?.name ?? owner;
}

const VIEW_LABEL: Record<MapView, string> = {
  political: '政治',
  terrain: '地形',
  population: '人口',
  output: '产值',
};

export default function WorldMap({
  map,
  game,
  selectedProvince,
  onSelect,
  editMode = false,
  editNation = 'empire',
  onPaintProvince,
  editStamp = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 0.5, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onPaintRef = useRef(onPaintProvince);
  onPaintRef.current = onPaintProvince;
  const [view, setView] = useState<MapView>('political');
  const [hoverProvince, setHoverProvince] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  // v0.5 地形底图（异步加载；加载完成触发重绘）
  const [relief, setRelief] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setRelief(img);
    img.src = RELIEF_SRC;
  }, []);

  // ---- v0.6 平滑缩放：目标缩放 + rAF 逐帧插值（锚定光标世界点） ----
  const zoomAnimRef = useRef<number | null>(null);
  const zoomTargetRef = useRef<{ scale: number; ax: number; ay: number; sx: number; sy: number } | null>(null);
  const stopZoomAnim = () => {
    if (zoomAnimRef.current !== null) {
      cancelAnimationFrame(zoomAnimRef.current);
      zoomAnimRef.current = null;
    }
    zoomTargetRef.current = null;
  };
  const startZoomAnim = (scaleTo: number, ax: number, ay: number, sx: number, sy: number) => {
    zoomTargetRef.current = { scale: scaleTo, ax, ay, sx, sy };
    if (zoomAnimRef.current !== null) return; // 已在动画中
    const step = () => {
      const t = zoomTargetRef.current;
      if (!t) {
        zoomAnimRef.current = null;
        return;
      }
      const v = viewRef.current;
      const diff = t.scale - v.scale;
      if (Math.abs(diff) < 0.0006) {
        v.scale = t.scale;
        v.offsetX = t.sx / v.scale - t.ax;
        v.offsetY = t.sy / v.scale - t.ay;
        zoomTargetRef.current = null;
        zoomAnimRef.current = null;
        drawRef.current();
        return;
      }
      v.scale += diff * 0.28; // 缓动插值
      v.offsetX = t.sx / v.scale - t.ax;
      v.offsetY = t.sy / v.scale - t.ay;
      drawRef.current();
      zoomAnimRef.current = requestAnimationFrame(step);
    };
    zoomAnimRef.current = requestAnimationFrame(step);
  };

  // ---- 视图指标（人口密度 / 产值每格） ----
  const metrics = useMemo(() => {
    const popDensity: Record<number, number> = {};
    const outputValue: Record<number, number> = {};
    let popMin = Infinity;
    let popMax = -Infinity;
    let outMin = Infinity;
    let outMax = -Infinity;
    for (const p of map.provinces) {
      const ps = game.provinces[p.id];
      const cells = Math.max(1, p.cellIds.length);
      const pop = ps?.popTotal ?? 0;
      const dens = pop / cells;
      popDensity[p.id] = dens;
      let ov = 0;
      if (ps) {
        for (const g of GOODS_LIST) ov += (ps.output[g] ?? 0) * BASE_PRICE[g];
      }
      const ovc = ov / cells;
      outputValue[p.id] = ovc;
      if (!p.isUndiscovered) {
        if (dens < popMin) popMin = dens;
        if (dens > popMax) popMax = dens;
        if (ovc < outMin) outMin = ovc;
        if (ovc > outMax) outMax = ovc;
      }
    }
    if (!Number.isFinite(popMax) || popMax <= popMin) {
      popMin = 0;
      popMax = 1;
    }
    if (!Number.isFinite(outMax) || outMax <= outMin) {
      outMin = 0;
      outMax = 1;
    }
    return { popDensity, outputValue, popMin, popMax, outMin, outMax };
  }, [map, game]);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = viewRef.current;
    const W = map.width;
    const H = map.height;

    // 环绕副本范围（视口覆盖哪些 k*W 副本）
    const viewLeft = v.offsetX;
    const viewRight = v.offsetX + cw / v.scale;
    const kMin = Math.floor(viewLeft / W) - 1;
    const kMax = Math.ceil(viewRight / W) + 1;
    const tx = (x: number, k: number) => (x + k * W - v.offsetX) * v.scale;
    const ty = (y: number) => (y - v.offsetY) * v.scale;
    const traceCell = (cellId: number, k: number): boolean => {
      const cell = map.cellsById.get(cellId);
      if (!cell) return false;
      ctx.beginPath();
      const pts = cell.polygon;
      const first = pts[0];
      ctx.moveTo(tx(first.x, k), ty(first.y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].x, k), ty(pts[i].y));
      ctx.closePath();
      return true;
    };
    const cellKs = (cellId: number): number[] => {
      const cell = map.cellsById.get(cellId);
      if (!cell) return [];
      const out: number[] = [];
      for (let k = kMin; k <= kMax; k++) {
        const x0 = k * W + cell.bbox.minX;
        const x1 = k * W + cell.bbox.maxX;
        if (x1 >= viewLeft && x0 <= viewRight) out.push(k);
      }
      return out;
    };

    // 0) 底图：地形底图（未加载完成时程序化海洋+陆地兜底）；左右副本无缝拼接
    const reliefReady = relief !== null && relief.complete && relief.naturalWidth > 0;
    for (let k = kMin; k <= kMax; k++) {
      const sx = (k * W - v.offsetX) * v.scale;
      if (sx + W * v.scale < 0 || sx > cw) continue;
      if (reliefReady) {
        ctx.drawImage(relief, sx, -v.offsetY * v.scale, W * v.scale, H * v.scale);
      } else {
        ctx.fillStyle = oceanColor(0);
        ctx.fillRect(sx, 0, W * v.scale, H * v.scale);
        for (const cell of map.cellsById.values()) {
          if (cell.land) continue;
          ctx.fillStyle = oceanColor(cell.h);
          if (traceCell(cell.id, k)) ctx.fill();
        }
        for (const prov of map.provinces) {
          for (const cid of prov.cellIds) {
            const cell = map.cellsById.get(cid);
            if (!cell) continue;
            ctx.fillStyle = prov.isUndiscovered
              ? rgbStr(UNDISCOVERED_RGB)
              : landColor(cell.terrain, cell.climate);
            if (traceCell(cid, k)) ctx.fill();
          }
        }
      }
    }

    // 1) 视图覆盖层
    if (view === 'political') {
      // 政治：国家半透明覆盖（迷雾保持深灰）
      for (const prov of map.provinces) {
        const fill = prov.isUndiscovered ? FOG_FILL : nationWash(prov.owner, NATION_ALPHA);
        ctx.fillStyle = fill;
        for (const cid of prov.cellIds) for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.fill();
      }
    } else if (view === 'population' || view === 'output') {
      // 人口/产值：choropleth（绿→红 / 蓝→橙）；迷雾保持深灰
      for (const prov of map.provinces) {
        if (prov.isUndiscovered) {
          ctx.fillStyle = FOG_FILL;
        } else if (view === 'population') {
          const d = metrics.popDensity[prov.id] ?? 0;
          const t = clamp01((d - metrics.popMin) / Math.max(1e-9, metrics.popMax - metrics.popMin));
          ctx.fillStyle = rampColor([POP_LOW, POP_MID, POP_HIGH], t);
        } else {
          const d = metrics.outputValue[prov.id] ?? 0;
          const t = clamp01((d - metrics.outMin) / Math.max(1e-9, metrics.outMax - metrics.outMin));
          ctx.fillStyle = rampColor([OUT_LOW, OUT_MID, OUT_HIGH], t);
        }
        for (const cid of prov.cellIds) for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.fill();
      }
    }
    // 地形：底图为主，不加覆盖（迷雾在下方已保持深灰，另加虚线描边）

    // 2) 海岸线提亮（陆地格邻接海洋）
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = COAST_LINE;
    for (const prov of map.provinces) {
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (!cell) continue;
        let coast = false;
        for (const nb of cell.neighbors) {
          const nbCell = map.cellsById.get(nb);
          if (nbCell && !nbCell.land) {
            coast = true;
            break;
          }
        }
        if (coast) for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
      }
    }

    // 3) 县界（更细；地形视图也显示）
    ctx.lineWidth = 0.35;
    ctx.strokeStyle = COUNTY_BORDER;
    for (const county of map.counties) {
      if (map.provinceById.get(provOfCell(map, county.cellIds[0]) ?? -1)?.isUndiscovered) continue;
      for (const cid of county.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsCountyBoundary(map, cell, county.id)) {
          for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
        }
      }
    }

    // 4) 省界（细线）
    ctx.lineWidth = 0.55;
    ctx.strokeStyle = PROV_BORDER;
    for (const prov of map.provinces) {
      if (prov.isUndiscovered) continue;
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsBoundary(map, cell, prov.id)) {
          for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
        }
      }
    }

    // 5) 国界深色加粗（多层柔化；政治/人口/产值视图显示，地形视图省略保持纯净）
    if (view !== 'terrain') {
      const nationLayers = [
        { width: 3.4, alpha: 0.16 },
        { width: 2.3, alpha: 0.3 },
        { width: 1.2, alpha: 0.55 },
      ];
      for (const layer of nationLayers) {
        ctx.lineWidth = layer.width;
        ctx.strokeStyle = hexToRgba(NATION_BORDER, layer.alpha);
        for (const prov of map.provinces) {
          if (prov.isUndiscovered) continue;
          for (const cid of prov.cellIds) {
            const cell = map.cellsById.get(cid);
            if (!cell) continue;
            let border = false;
            for (const nb of cell.neighbors) {
              const nbProv = provOfCell(map, nb);
              if (nbProv === undefined) continue;
              const nbP = map.provinceById.get(nbProv);
              if (nbP && !nbP.isUndiscovered && nbP.owner !== prov.owner) {
                border = true;
                break;
              }
            }
            if (border) for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
          }
        }
      }
    }

    // 6) 迷雾大陆：虚线描边（所有视图）
    ctx.lineWidth = 1.1;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = FOG_BORDER;
    for (const prov of map.provinces) {
      if (!prov.isUndiscovered) continue;
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsBoundary(map, cell, prov.id)) {
          for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    // 7) 选中省份高亮
    if (selectedProvince !== null) {
      const prov = map.provinceById.get(selectedProvince);
      if (prov) {
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = SELECT_COLOR;
        for (const cid of prov.cellIds) {
          const cell = map.cellsById.get(cid);
          if (cell && cellIsBoundary(map, cell, prov.id)) {
            for (const k of cellKs(cid)) if (traceCell(cid, k)) ctx.stroke();
          }
        }
      }
    }

    // 8) 经纬网格 + 标注（每 10% 一条，浅色细线；左右副本同步环绕）
    if (v.scale >= GRID_MIN_SCALE && v.scale <= GRID_MAX_SCALE) {
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = 'rgba(226,236,248,0.32)';
      ctx.fillStyle = 'rgba(226,236,248,0.7)';
      ctx.font = '10px var(--sans), system-ui, sans-serif';
      for (let i = 1; i < 10; i++) {
        for (let k = kMin; k <= kMax; k++) {
          const sx = tx((i / 10) * W, k);
          if (sx < 0 || sx > cw) continue;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
          ctx.stroke();
          if (k === 0) ctx.fillText(`${i * 10}°E`, sx + 2, 10);
        }
      }
      for (let i = 1; i < 10; i++) {
        const sy = ty((i / 10) * H);
        if (sy < 0 || sy > ch) continue;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(cw, sy);
        ctx.stroke();
        ctx.fillText(`${(10 - i) * 10}°N`, 3, sy - 3);
      }
    }
  };

  // 异步重绘统一走 drawRef（rAF 缩放循环 / ResizeObserver 始终取最新闭包，避免陈旧视图状态）
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // 初始视图（适配容器）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw > 0 && ch > 0) {
      const scale = Math.min(cw / map.width, ch / map.height) * 0.96;
      viewRef.current = {
        scale,
        offsetX: (map.width - cw / scale) / 2,
        offsetY: (map.height - ch / scale) / 2,
      };
    }
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // 容器尺寸变化
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // 状态变化重绘（视图/编辑/游戏数据变化触发；缩放动画走 rAF 直接重绘）
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedProvince, relief, view, editStamp, game, metrics]);

  // 滚轮缩放（原生监听以支持 preventDefault；锚定光标 + 平滑插值）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      // 锚定光标下的世界点（环绕 x 已由 findCellAt 处理，这里保持原始坐标用于偏移计算）
      const ax = sx / v.scale + v.offsetX;
      const ay = sy / v.scale + v.offsetY;
      startZoomAnim(scale, ax, ay, sx, sy);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      stopZoomAnim();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const worldAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const v = viewRef.current;
    return { wx: sx / v.scale + v.offsetX, wy: sy / v.scale + v.offsetY, sx, sy };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    stopZoomAnim(); // 拖拽立即打断缩放动画
    const { sx, sy } = worldAt(e);
    dragRef.current = { x: sx, y: sy, moved: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { wx, wy, sx, sy } = worldAt(e);
    const drag = dragRef.current;
    if (drag) {
      const dx = sx - drag.x;
      const dy = sy - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = sx;
      drag.y = sy;
      const v = viewRef.current;
      v.offsetX -= dx / v.scale;
      v.offsetY -= dy / v.scale;
      draw();
    }
    // hover 摘要（环绕：findCellAt 内部把 x 环绕到 [0,W)）
    const cell = findCellAt(map, wx, wy);
    const provId = cell ? provOfCell(map, cell.id) ?? null : null;
    setHoverProvince(provId);
    setHoverPos({ x: sx, y: sy });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved > 6) return; // 拖拽不算点击
    const { wx, wy } = worldAt(e);
    const cell = findCellAt(map, wx, wy);
    const provId = cell ? provOfCell(map, cell.id) ?? null : null;
    if (editMode && provId !== null && onPaintRef.current) {
      onPaintRef.current(provId); // 编辑模式：点击省份改属（迷雾省由 App 侧拦截）
    }
    onSelectRef.current(provId);
  };

  const hoverProv = hoverProvince !== null ? map.provinceById.get(hoverProvince) ?? null : null;

  return (
    <div className="map-wrap">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          dragRef.current = null;
          setHoverProvince(null);
          setHoverPos(null);
        }}
      />
      {hoverProv && hoverPos && (
        <HoverCard prov={hoverProv} game={game} pos={hoverPos} view={view} metrics={metrics} editMode={editMode} editNation={editNation} />
      )}
      {/* v0.6 视图选择器 */}
      <div className="view-selector">
        {(Object.keys(VIEW_LABEL) as MapView[]).map((mv) => (
          <button
            key={mv}
            className={`view-btn ${view === mv ? 'active' : ''}`}
            onClick={() => setView(mv)}
          >
            {VIEW_LABEL[mv]}
          </button>
        ))}
      </div>
      {/* v0.6 图例（人口/产值视图） */}
      {(view === 'population' || view === 'output') && (
        <LegendBar view={view} metrics={metrics} />
      )}
      <div className="map-hint">
        {editMode ? (
          <>
            编辑模式 · 点击省份改属「{ownerName(editNation)}」· 迷雾区不可编辑
            <span className="map-hint-sep">｜</span>
            Ctrl+Z 撤销 · Ctrl+Y 重做
          </>
        ) : (
          <>
            滚轮缩放（锚定光标）· 拖拽平移（东西环绕）· 点击省份选中 · 悬停摘要
            <span className="map-hint-sep">｜</span>
            视图：政治 / 地形 / 人口 / 产值
          </>
        )}
      </div>
    </div>
  );
}

/** 图例条（人口绿→红 / 产值蓝→橙） */
function LegendBar({ view, metrics }: { view: 'population' | 'output'; metrics: { popMin: number; popMax: number; outMin: number; outMax: number } }) {
  const min = view === 'population' ? metrics.popMin : metrics.outMin;
  const max = view === 'population' ? metrics.popMax : metrics.outMax;
  const stops = view === 'population' ? [POP_LOW, POP_MID, POP_HIGH] : [OUT_LOW, OUT_MID, OUT_HIGH];
  const grad = `linear-gradient(90deg, ${stops.map((s) => rgbStr(s)).join(',')})`;
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('zh-CN') : v.toFixed(2));
  return (
    <div className="legend-bar">
      <span className="legend-label">{view === 'population' ? '人口密度' : '产值/格'}</span>
      <span className="legend-min">{fmt(min)}</span>
      <div className="legend-gradient" style={{ background: grad }} />
      <span className="legend-max">{fmt(max)}</span>
      <span className="legend-unit">{view === 'population' ? '万/格' : '万₭/格/月'}</span>
    </div>
  );
}

/** hover 摘要卡：按视图显示对应数值 */
function HoverCard({
  prov,
  game,
  pos,
  view,
  metrics,
  editMode,
  editNation,
}: {
  prov: Province;
  game: GameState;
  pos: { x: number; y: number };
  view: MapView;
  metrics: { popDensity: Record<number, number>; outputValue: Record<number, number> };
  editMode: boolean;
  editNation: ProvinceOwner;
}) {
  const ownerText = prov.isUndiscovered ? '未探明新大陆' : (NATIONS[prov.owner as keyof typeof NATIONS]?.name ?? '未知');
  const ps = game.provinces[prov.id];
  const pop = ps?.popTotal ?? 0;
  const cap = ps?.housingCap ?? 0;
  const eff = ps?.efficiency ?? 1;
  const happ = ps?.happiness ?? 50;
  const foodOut = ps?.output.food ?? 0;
  const dens = metrics.popDensity[prov.id] ?? 0;
  const ov = metrics.outputValue[prov.id] ?? 0;
  const style: CSSProperties = {
    left: Math.min(pos.x + 14, window.innerWidth - 240),
    top: Math.min(pos.y + 14, window.innerHeight - 230),
  };
  return (
    <div className="hover-card" style={style}>
      <div className="hover-title">
        行省 #{prov.id + 1} · {CLIMATE_LABEL[prov.climate]}
        {prov.isStrait && <span className="hover-strait">海峡要道</span>}
      </div>
      <dl>
        <dt>归属</dt>
        <dd>{ownerText}</dd>
        {view === 'political' && (
          <>
            <dt>辖区</dt>
            <dd>{prov.counties.length} 县 / {prov.cellIds.length} 格 / 均海拔 {prov.elevStats.avg.toFixed(0)}</dd>
            <dt>气候</dt>
            <dd>均温 {prov.avgTemp.toFixed(0)}℃ · 降水 {prov.avgPrec.toFixed(0)}</dd>
          </>
        )}
        {view === 'terrain' && (
          <>
            <dt>地形</dt>
            <dd>{TERRAIN_LABEL[prov.terrain]}</dd>
            <dt>气候</dt>
            <dd>{CLIMATE_LABEL[prov.climate]}（均温 {prov.avgTemp.toFixed(0)}℃）</dd>
            <dt>海拔</dt>
            <dd>{prov.elevStats.min}–{prov.elevStats.max}（均 {prov.elevStats.avg.toFixed(0)}）</dd>
          </>
        )}
        {view === 'population' && (
          <>
            <dt>人口密度</dt>
            <dd>{dens.toFixed(2)} 万/格</dd>
            <dt>人口</dt>
            <dd>{Math.round(pop).toLocaleString('zh-CN')} 万 / 容量 {Math.round(cap).toLocaleString('zh-CN')} 万</dd>
            <dt>幸福度</dt>
            <dd>{happ.toFixed(0)} · 效率 ×{eff.toFixed(2)}</dd>
          </>
        )}
        {view === 'output' && (
          <>
            <dt>产值/格</dt>
            <dd>{ov.toFixed(3)} 万₭/格/月</dd>
            <dt>粮产</dt>
            <dd>{foodOut.toFixed(2)} 万吨/月</dd>
            <dt>奢侈品</dt>
            <dd>潜力 ×{provinceLuxuryPotential(prov).toFixed(2)} · 产出 {(ps?.output.luxury ?? 0).toFixed(3)}/月</dd>
          </>
        )}
        {!prov.isUndiscovered && <dt>资源</dt>}
        {!prov.isUndiscovered && <dd>{provinceResourceLabels(prov).join(' · ') || '—'}</dd>}
      </dl>
      {editMode && (
        <div className="hover-note">
          {prov.isUndiscovered ? '🔒 迷雾区锁定，不可编辑' : `点击改属 → ${ownerName(editNation)}`}
        </div>
      )}
      {prov.isUndiscovered && !editMode && <div className="hover-note">未探明的新大陆，等待征服。</div>}
    </div>
  );
}
