/**
 * 省份资源（v0.6 重构）：按「新省份 id」确定性重算，替代 v0.5 按大陆块的 data/resources.json 查表。
 *
 * 背景：v0.6 省份重构（大省拆分/小省并入/海岛归并）后省份 id 与 v0.5 不再对应，
 * 且多岛省份跨越多个大陆块 —— 因此资源改为「按省 id」内嵌生成（前端运行时确定性计算，
 * 与 data/resources_v2.json 导出（scripts/export_resources.ts）同源同种子）。
 *
 * 资源规则（复用 tools/map_resources.py，确定性种子 1023）：
 *  - 山地（max_h >= 30 或 avg_h >= 28）→ 矿藏（煤/铁/铜/锡/金/硫磺/宝石 加权随机）
 *    + 40% 概率补煤 +（avg_h < 45 时 40% 概率林场）
 *  - 低地 → 农业：暖湿→棉田（avg_t>10 且 avg_p>30）否则沃土；寒→林场；
 *    avg_p>=25 且 avg_t>-8 时 50% 概率补林场
 *  - 沿海 → 渔场 + 30% 概率盐
 *  - 毛皮（fur）不在资源表 —— 由「寒带林」派生（有林场 + 寒带气候，provinceHasFur）
 */
import { loadMap } from './map';
import type { GameMap, Province } from './map';
import { Rng } from './rng';

export type ResourceId =
  | 'coal' // 煤矿
  | 'iron' // 铁矿
  | 'copper' // 铜矿
  | 'tin' // 锡矿
  | 'gold' // 金矿
  | 'salt' // 盐
  | 'sulfur' // 硫磺
  | 'gems' // 宝石
  | 'fish' // 渔场
  | 'farmland' // 沃土
  | 'timber' // 林场
  | 'cotton' // 棉田
  | 'stone'; // 石料（山地）

export const RESOURCE_LABEL: Record<ResourceId, string> = {
  coal: '煤矿',
  iron: '铁矿',
  copper: '铜矿',
  tin: '锡矿',
  gold: '金矿',
  salt: '盐',
  sulfur: '硫磺',
  gems: '宝石',
  fish: '渔场',
  farmland: '沃土',
  timber: '林场',
  cotton: '棉田',
  stone: '石料',
};

/** 确定性资源种子（与 v0.5 tools/map_resources.py 一致） */
export const RESOURCE_SEED = 1023;

/** 矿藏加权表（权重即重复次数，等价于 map_resources.py 的 rng.choice 列表） */
const MINE_POOL: ResourceId[] = [
  'coal', 'coal', 'iron', 'iron', 'copper', 'tin', 'gold', 'sulfur', 'gems',
];

/** 省份沿海判定（任一格邻接海洋；缓存省 id → bool） */
const coastalCache = new Map<number, boolean>();
export function provinceCoastal(prov: Province): boolean {
  const hit = coastalCache.get(prov.id);
  if (hit !== undefined) return hit;
  const map = loadMap();
  let coastal = false;
  for (const cid of prov.cellIds) {
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
  coastalCache.set(prov.id, coastal);
  return coastal;
}

/** 单省资源（确定性：与导出脚本同序同种子） */
export function computeProvinceResources(map: GameMap, prov: Province, rng: Rng): ResourceId[] {
  let hSum = 0;
  let tSum = 0;
  let pSum = 0;
  let maxH = -Infinity;
  const n = prov.cellIds.length;
  for (const cid of prov.cellIds) {
    const cell = map.cellsById.get(cid);
    if (!cell) continue;
    hSum += cell.h;
    tSum += cell.temp;
    pSum += cell.prec;
    if (cell.h > maxH) maxH = cell.h;
  }
  const avgH = hSum / n;
  const avgT = tSum / n;
  const avgP = pSum / n;
  const coastal = provinceCoastal(prov);
  const res: ResourceId[] = [];
  if (maxH >= 30 || avgH >= 28) {
    // 山地：矿藏（确定性加权随机）+ 石料（采石场原料）
    res.push(MINE_POOL[rng.int(0, MINE_POOL.length)]);
    if (rng.chance(0.4) && !res.includes('coal')) res.push('coal');
    if (avgH < 45 && rng.chance(0.4)) res.push('timber');
    res.push('stone');
  } else {
    // 低地：农业
    if (avgT > -5 && avgP >= 15) {
      res.push(avgT > 10 && avgP > 30 ? 'cotton' : 'farmland');
    } else if (avgT > -10) {
      res.push('farmland');
    } else {
      res.push('timber');
    }
    if (avgP >= 25 && avgT > -8 && rng.chance(0.5)) res.push('timber');
  }
  if (coastal) {
    res.push('fish');
    if (!res.includes('salt') && rng.chance(0.3)) res.push('salt');
  }
  if (res.length === 0) res.push('farmland');
  return res;
}

let resourcesByProvince: Map<number, ResourceId[]> | null = null;

/** 全图省资源表（按省 id；懒加载、确定性） */
export function resourcesByProvinceId(): Map<number, ResourceId[]> {
  if (resourcesByProvince) return resourcesByProvince;
  const map = loadMap();
  const rng = new Rng(RESOURCE_SEED);
  const out = new Map<number, ResourceId[]>();
  for (const prov of map.provinces) {
    out.set(prov.id, computeProvinceResources(map, prov, rng));
  }
  resourcesByProvince = out;
  return out;
}

/** 省份资源（按省 id 查表；无记录返回空数组） */
export function provinceResources(prov: Province): ResourceId[] {
  return resourcesByProvinceId().get(prov.id) ?? [];
}

/** 省份是否拥有某资源 */
export function provinceHasResource(prov: Province, res: ResourceId): boolean {
  return provinceResources(prov).includes(res);
}

/** 省资源中文标签列表（UI/悬停） */
export function provinceResourceLabels(prov: Province): string[] {
  return provinceResources(prov).map((r) => RESOURCE_LABEL[r]);
}

/** 全图资源统计（sim/调试用）：资源 → 省份数 */
export function resourceStats(provinces: Province[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of provinces) {
    for (const r of provinceResources(p)) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

/** 毛皮产出判定：有林场且寒带气候（arctic/coldTemp）→ 北境毛皮 */
export function provinceHasFur(prov: Province): boolean {
  return provinceHasResource(prov, 'timber') && (prov.climate === 'arctic' || prov.climate === 'coldTemp');
}
