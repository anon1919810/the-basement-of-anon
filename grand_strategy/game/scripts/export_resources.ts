/**
 * v0.6 资源导出：按「新省份 id」把前端内嵌生成的资源表落盘为 data/resources_v2.json
 * （参考/审计产物；游戏前端直接内嵌生成，不依赖该文件）。
 * 与 src/game/resources.ts 同源同种子（RESOURCE_SEED=1023），结果逐字节一致。
 * 运行：npx.cmd tsx scripts/export_resources.ts
 */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { loadMap } from '../src/game/map';
import { computeProvinceResources, provinceCoastal } from '../src/game/resources';

const map = loadMap();
const out: Record<string, { cells: number; elev: number; temp: number; prec: number; coastal: boolean; resources: string[] }> = {};
for (const p of map.provinces) {
  const cellN = p.cellIds.length;
  let hSum = 0;
  let tSum = 0;
  let pSum = 0;
  for (const cid of p.cellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell) continue;
    hSum += cell.h;
    tSum += cell.temp;
    pSum += cell.prec;
  }
  out[String(p.id)] = {
    cells: cellN,
    elev: Math.round((hSum / cellN) * 10) / 10,
    temp: Math.round((tSum / cellN) * 10) / 10,
    prec: Math.round((pSum / cellN) * 10) / 10,
    coastal: provinceCoastal(p),
    resources: computeProvinceResources(map, p),
  };
}
const path = fileURLToPath(new URL('../../data/resources_v2.json', import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(`已导出 ${path}（${Object.keys(out).length} 省 / 县资源组合确定性）`);
