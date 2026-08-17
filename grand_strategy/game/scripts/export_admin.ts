/**
 * v0.5 新行政图数据导出：省份多边形 + 属国 + 省界/国界标记 → game/scripts/admin_v05.json，
 * 由 tools/render_admin_v05.py 渲染 PNG。单一数据源 = map.ts 的归属逻辑（loadMap）。
 * 运行：npx.cmd tsx scripts/export_admin.ts
 */
import { writeFileSync } from 'node:fs';
import { loadMap, provOfCell } from '../src/game/map';

const map = loadMap();
const cellOwner = new Map<number, string>();
for (const p of map.provinces) {
  for (const cid of p.cellIds) cellOwner.set(cid, p.owner);
}

const provinces = map.provinces.map((p) => ({
  id: p.id,
  owner: p.owner,
  strait: p.isStrait,
  centroid: [Math.round(p.centroid.x), Math.round(p.centroid.y)],
  cells: p.cellIds.map((cid) => {
    const cell = map.cellsById.get(cid);
    const poly = cell ? cell.polygon.map((pt) => [Math.round(pt.x), Math.round(pt.y)]) : [];
    let provinceBorder = false;
    let nationalBorder = false;
    if (cell) {
      for (const nb of cell.neighbors) {
        const nbProv = provOfCell(map, nb);
        const nbOwner = cellOwner.get(nb);
        if (nbProv !== undefined && nbProv !== p.id) provinceBorder = true;
        if (nbOwner !== undefined && nbOwner !== p.owner) nationalBorder = true;
      }
    }
    return { poly, provinceBorder, nationalBorder };
  }),
}));

const out = {
  width: map.width,
  height: map.height,
  provinces,
};
const path = 'scripts/admin_v05.json';
writeFileSync(path, JSON.stringify(out));
console.log(`已导出 ${path}（${provinces.length} 省 / ${map.landCellIds.length} 陆地格）`);
