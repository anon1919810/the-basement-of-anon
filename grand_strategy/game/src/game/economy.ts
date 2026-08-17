/**
 * 基础经济循环（v0.0.0 简化版）：
 *  税收：人口 × 人均收入 × 税率 × 省份修正 → 国库
 *  支出：军 / 行政 / 基建 三项滑杆（万₭/月）
 *  国库 = 收入 - 支出 累积
 *  粮食：省份农业产出 - 人口消耗（缺粮 → 稳定度下降）
 *  人口：随粮食缓慢增长 / 缺粮缓慢下降
 */
import type { GameMap } from './map';
import type { GameState } from './state';
import type { NationId, TaxLevel } from './types';

// ---- 税率档 ----
export const TAX_RATES: Record<TaxLevel, { label: string; rate: number; penalty: number }> = {
  light: { label: '轻税', rate: 0.2, penalty: 0 },
  medium: { label: '中税', rate: 0.3, penalty: 5 },
  heavy: { label: '重税', rate: 0.42, penalty: 15 },
  oppressive: { label: '苛税', rate: 0.55, penalty: 28 },
};

export const TAX_LEVELS: TaxLevel[] = ['light', 'medium', 'heavy', 'oppressive'];

/** 人均年收入（₭/人/年）≈ 1780 年代水平 */
export const PER_CAPITA_INCOME = 3.0;

/** 人均年粮食消耗（吨/人/年）→ 每万人 0.09 万吨/年 */
export const GRAIN_PER_WAN_PERSON = 0.09;

/** 每陆地格基础年产粮（万吨/年，× 省份 grainMod） */
export const CELL_GRAIN_BASE = 0.9;

/** 省份年产粮（万吨/年） */
export function provinceGrainPerYear(map: GameMap, provId: number): number {
  const prov = map.provinceById.get(provId);
  if (!prov) return 0;
  return prov.cellIds.length * CELL_GRAIN_BASE * prov.grainMod;
}

/** 国家年产粮（万吨/年）= 所辖省份之和 */
export function nationGrainPerYear(map: GameMap, nationId: NationId): number {
  let sum = 0;
  for (const prov of map.provinces) {
    if (prov.owner === nationId && !prov.isUndiscovered) sum += provinceGrainPerYear(map, prov.id);
  }
  return sum;
}

/** 国家年耗粮（万吨/年） */
export function nationGrainConsumption(game: GameState, nationId: NationId): number {
  return game.nations[nationId].popWan * GRAIN_PER_WAN_PERSON;
}

/** 省份人口（万人）：按格数占国家总格数比例分配 */
export function provincePopWan(map: GameMap, game: GameState, provId: number): number {
  const prov = map.provinceById.get(provId);
  if (!prov || prov.owner === 'undiscovered') return 0;
  const nation = game.nations[prov.owner];
  const share = prov.cellIds.length / Math.max(1, nation.cells);
  return nation.popWan * share;
}

/** 国家月税收（万₭/月） */
export function nationMonthlyIncome(map: GameMap, game: GameState, nationId: NationId): number {
  const nation = game.nations[nationId];
  const tax = TAX_RATES[nation.taxLevel];
  let incomeYear = 0;
  for (const prov of map.provinces) {
    if (prov.owner !== nationId || prov.isUndiscovered) continue;
    const pop = provincePopWan(map, game, prov.id);
    // 人口(万) × 人均(₭/人/年) × 税率 × 省份修正
    incomeYear += pop * PER_CAPITA_INCOME * tax.rate * prov.productivity;
  }
  return incomeYear / 12;
}

/** 国家月支出（万₭/月） */
export function nationMonthlySpending(game: GameState, nationId: NationId): number {
  const s = game.nations[nationId].spending;
  return s.military + s.admin + s.infra;
}

/** 国家月粮食结余（万吨/月） */
export function nationMonthlyGrain(map: GameMap, game: GameState, nationId: NationId): number {
  return nationGrainPerYear(map, nationId) / 12 - nationGrainConsumption(game, nationId) / 12;
}
