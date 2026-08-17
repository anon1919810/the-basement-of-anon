import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameMap, Province } from '../game/map';
import { cellIsBoundary, cellIsCountyBoundary, findCellAt, provOfCell } from '../game/map';
import { CLIMATE_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import { NATIONS, UNDISCOVERED_RGB } from '../game/nations';
import { provinceLuxuryPotential } from '../game/pops';
import { provinceResourceLabels } from '../game/resources';
import type { ClimateId, TerrainKind } from '../game/types';

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
}

const NATION_BORDER = '#0c1118';
const PROV_BORDER = 'rgba(255,255,255,0.5)';
const COUNTY_BORDER = 'rgba(255,255,255,0.16)';
const FOG_BORDER = 'rgba(150,165,190,0.8)';
const SELECT_COLOR = '#35c46b';
const COAST_LINE = 'rgba(240,246,255,0.55)';
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;

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

// ---- 陆地：地形底色 × 气候修正 ----
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function rgbStr(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** 国家半透明覆盖（视觉柔和，保留地形/气候信息） */
function nationWash(owner: string, alpha: number): string {
  const rgb = NATIONS[owner as keyof typeof NATIONS]?.rgb ?? UNDISCOVERED_RGB;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

export default function WorldMap({ map, game, selectedProvince, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 0.5, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [hoverProvince, setHoverProvince] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

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

    const tx = (x: number) => (x - v.offsetX) * v.scale;
    const ty = (y: number) => (y - v.offsetY) * v.scale;

    const traceCell = (cellId: number): boolean => {
      const cell = map.cellsById.get(cellId);
      if (!cell) return false;
      ctx.beginPath();
      const pts = cell.polygon;
      const first = pts[0];
      ctx.moveTo(tx(first.x), ty(first.y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].x), ty(pts[i].y));
      ctx.closePath();
      return true;
    };

    // 0) 海洋底（最深色，兜底）
    ctx.fillStyle = oceanColor(0);
    ctx.fillRect(0, 0, cw, ch);

    // 1) 海洋格按水深深浅蓝渐变
    for (const cell of map.cellsById.values()) {
      if (cell.land) continue;
      ctx.fillStyle = oceanColor(cell.h);
      if (traceCell(cell.id)) ctx.fill();
    }

    // 2) 陆地：地形色晕 + 气候着色（每个格独立色，含迷雾深灰）
    for (const prov of map.provinces) {
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (!cell) continue;
        ctx.fillStyle = prov.isUndiscovered
          ? rgbStr(UNDISCOVERED_RGB)
          : landColor(cell.terrain, cell.climate);
        if (traceCell(cid)) ctx.fill();
      }
    }

    // 3) 国家半透明覆盖（柔化：先淡后浓两层）
    for (const prov of map.provinces) {
      if (prov.isUndiscovered) continue;
      ctx.fillStyle = nationWash(prov.owner, 0.26);
      for (const cid of prov.cellIds) if (traceCell(cid)) ctx.fill();
    }

    // 4) 海岸线提亮（陆地格邻接海洋）
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
        if (coast && traceCell(cid)) ctx.stroke();
      }
    }

    // 5) 县界（更细）
    ctx.lineWidth = 0.35;
    ctx.strokeStyle = COUNTY_BORDER;
    for (const county of map.counties) {
      if (map.provinceById.get(provOfCell(map, county.cellIds[0]) ?? -1)?.isUndiscovered) continue;
      for (const cid of county.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsCountyBoundary(map, cell, county.id) && traceCell(cid)) ctx.stroke();
      }
    }

    // 6) 省界（细线）
    ctx.lineWidth = 0.55;
    ctx.strokeStyle = PROV_BORDER;
    for (const prov of map.provinces) {
      if (prov.isUndiscovered) continue;
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsBoundary(map, cell, prov.id) && traceCell(cid)) ctx.stroke();
      }
    }

    // 7) 国界柔化：粗淡描边 + 半透明多层（视觉柔和）
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
          if (border && traceCell(cid)) ctx.stroke();
        }
      }
    }

    // 8) 迷雾大陆：虚线描边
    ctx.lineWidth = 1.1;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = FOG_BORDER;
    for (const prov of map.provinces) {
      if (!prov.isUndiscovered) continue;
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsBoundary(map, cell, prov.id) && traceCell(cid)) ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // 9) 选中省份高亮
    if (selectedProvince !== null) {
      const prov = map.provinceById.get(selectedProvince);
      if (prov) {
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = SELECT_COLOR;
        for (const cid of prov.cellIds) {
          const cell = map.cellsById.get(cid);
          if (cell && cellIsBoundary(map, cell, prov.id) && traceCell(cid)) ctx.stroke();
        }
      }
    }
  };

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
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // 状态变化重绘（canvas 只依赖静态地图与选中省；game 经济数据走 hover 卡）
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedProvince]);

  // 滚轮缩放（原生监听以支持 preventDefault）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      // 保持光标下的世界点不动
      const wx = sx / v.scale + v.offsetX;
      const wy = sy / v.scale + v.offsetY;
      v.scale = scale;
      v.offsetX = sx / scale - wx;
      v.offsetY = sy / scale - wy;
      draw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
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
    // hover 摘要（拖拽时也跟随，但用世界坐标判定）
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
      {hoverProv && hoverPos && <HoverCard prov={hoverProv} game={game} pos={hoverPos} />}
      <div className="map-hint">滚轮缩放 · 拖拽平移 · 点击省份选中 · 悬停查看摘要</div>
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** hover 摘要卡：县/气候/经济 */
function HoverCard({ prov, game, pos }: { prov: Province; game: GameState; pos: { x: number; y: number } }) {
  const ownerName = prov.isUndiscovered ? '未探明新大陆' : (NATIONS[prov.owner as keyof typeof NATIONS]?.name ?? '未知');
  const ps = game.provinces[prov.id];
  const pop = ps?.popTotal ?? 0;
  const cap = ps?.housingCap ?? 0;
  const eff = ps?.efficiency ?? 1;
  const happ = ps?.happiness ?? 50;
  const foodOut = ps?.output.food ?? 0;
  const style: CSSProperties = {
    left: Math.min(pos.x + 14, window.innerWidth - 230),
    top: Math.min(pos.y + 14, window.innerHeight - 180),
  };
  return (
    <div className="hover-card" style={style}>
      <div className="hover-title">
        行省 #{prov.id + 1} · {CLIMATE_LABEL[prov.climate]}
      </div>
      <dl>
        <dt>归属</dt>
        <dd>{ownerName}</dd>
        <dt>辖区</dt>
        <dd>{prov.counties.length} 县 / {prov.cellIds.length} 格 / 均海拔 {prov.elevStats.avg.toFixed(0)}</dd>
        <dt>气候</dt>
        <dd>均温 {prov.avgTemp.toFixed(0)}℃ · 降水 {prov.avgPrec.toFixed(0)}</dd>
        {!prov.isUndiscovered && (
          <dt>资源</dt>
        )}
        {!prov.isUndiscovered && (
          <dd>{provinceResourceLabels(prov).join(' · ') || '—'}</dd>
        )}
        {!prov.isUndiscovered && ps && (
          <>
            <dt>人口</dt>
            <dd>{Math.round(pop).toLocaleString('zh-CN')} 万 / 容量 {Math.round(cap).toLocaleString('zh-CN')} 万</dd>
            <dt>幸福度</dt>
            <dd>{happ.toFixed(0)} · 效率 ×{eff.toFixed(2)}</dd>
            <dt>粮产</dt>
            <dd>{foodOut.toFixed(2)} 万吨/月</dd>
            <dt>奢侈品</dt>
            <dd>潜力 ×{provinceLuxuryPotential(prov).toFixed(2)} · 产出 {(ps.output.luxury ?? 0).toFixed(3)}/月</dd>
          </>
        )}
      </dl>
      {prov.isUndiscovered && <div className="hover-note">未探明的新大陆，等待征服。</div>}
    </div>
  );
}
