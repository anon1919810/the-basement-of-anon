import { useEffect, useRef } from 'react';
import type { GameMap } from '../game/map';
import { cellIsBoundary, findCellAt, provOfCell } from '../game/map';
import type { GameState } from '../game/state';
import { NATIONS, UNDISCOVERED_RGB } from '../game/nations';

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

const OCEAN = '#0a1626';
const NATION_BORDER = '#0c1118';
const PROV_BORDER = 'rgba(255,255,255,0.55)';
const FOG_BORDER = 'rgba(150,165,190,0.8)';
const SELECT_COLOR = '#35c46b';
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;

function rgbStr(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export default function WorldMap({ map, game, selectedProvince, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 0.5, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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

    // 海洋底
    ctx.fillStyle = OCEAN;
    ctx.fillRect(0, 0, cw, ch);

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

    // 1) 填充（国家色 / 迷雾深灰）
    for (const prov of map.provinces) {
      const color = prov.isUndiscovered
        ? rgbStr(UNDISCOVERED_RGB)
        : NATIONS[prov.owner as keyof typeof NATIONS]?.color ?? '#888';
      ctx.fillStyle = color;
      for (const cid of prov.cellIds) {
        if (traceCell(cid)) ctx.fill();
      }
    }

    // 2) 省份白细边（边界格）
    ctx.lineWidth = 0.55;
    ctx.strokeStyle = PROV_BORDER;
    for (const prov of map.provinces) {
      if (prov.isUndiscovered) continue;
      for (const cid of prov.cellIds) {
        const cell = map.cellsById.get(cid);
        if (cell && cellIsBoundary(map, cell, prov.id) && traceCell(cid)) ctx.stroke();
      }
    }

    // 3) 国界加粗（邻国异主）
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = NATION_BORDER;
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

    // 4) 迷雾大陆：虚线描边
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

    // 5) 选中省份高亮
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

  // 状态变化重绘
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, game, selectedProvince]);

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

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, moved: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - drag.x;
    const dy = y - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = x;
    drag.y = y;
    const v = viewRef.current;
    v.offsetX -= dx / v.scale;
    v.offsetY -= dy / v.scale;
    draw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved > 6) return; // 拖拽不算点击
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const v = viewRef.current;
    const wx = sx / v.scale + v.offsetX;
    const wy = sy / v.scale + v.offsetY;
    const cell = findCellAt(map, wx, wy);
    const provId = cell ? provOfCell(map, cell.id) ?? null : null;
    onSelectRef.current(provId);
  };

  return (
    <div className="map-wrap">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (dragRef.current = null)}
      />
      <div className="map-hint">滚轮缩放 · 拖拽平移 · 点击省份选中</div>
    </div>
  );
}
