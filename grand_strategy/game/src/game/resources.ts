/**
 * 省份资源（v0.3）：读取 data/resources.json（tools/map_resources.py 生成，确定性种子 1023）。
 *
 * 重要：resources.json 的键是「陆地连通分量（大陆块）」序号 —— map_resources.py 用 BFS 对陆地格聚类，
 * 与 map.ts 的 landmass 编号规则一致（同为按格 id 序 BFS）。游戏内一个大陆块可含多个行省，
 * 因此按 prov.landmassId 查资源，同一大陆块内的省份共享资源集。
 *
 * 资源规则（设计文档）：山地→矿藏（煤/铁/铜/…）、沿海→渔获+盐、低地温湿→沃土/棉田、
 * 寒冷低地→林场。毛皮（fur）不在 resources.json —— 由「寒带林」派生（有林场 + 寒带气候）。
 */
import raw from '../../../data/resources.json';
import type { Province } from './map';

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
  | 'cotton'; // 棉田

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
};

interface RawProvResource {
  cells: number;
  elev: number;
  temp: number;
  prec: number;
  coastal: boolean;
  resources: string[];
}
const RAW = raw as Record<string, RawProvResource>;

const resourcesByLandmass = new Map<number, ResourceId[]>();
for (const key of Object.keys(RAW)) {
  resourcesByLandmass.set(Number(key), (RAW[key].resources ?? []) as ResourceId[]);
}

/** 省份资源（按大陆块 id 查表；无记录返回空数组） */
export function provinceResources(prov: Province): ResourceId[] {
  return resourcesByLandmass.get(prov.landmassId) ?? [];
}

/** 省份是否拥有某资源 */
export function provinceHasResource(prov: Province, res: ResourceId): boolean {
  return provinceResources(prov).includes(res);
}

/** 省份是否沿海（resources.json 的 coastal 字段；与 logistics.isCoastal 等价，读取内嵌数据） */
export function provinceCoastal(prov: Province): boolean {
  const d = RAW[String(prov.landmassId)];
  return d ? d.coastal : false;
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
