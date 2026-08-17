// 新闻系统：模板兜底 + 影响区间解析 + 个股/行业影响判定

import { SECTORS } from "./stocks";
import type { NewsItem } from "./types";

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `news_${Date.now().toString(36)}_${idSeq}`;
}

/** 解析 "+5%~+8%" / "-4%~-2%" / "3%" 等为百分比数值区间 */
export function parseRange(range: string): { min: number; max: number } {
  const nums = (range.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length === 0) return { min: 3, max: 5 };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
}

/** 区间中值（百分比数值，如 "+5%~+8%" -> 6.5） */
export function medianOfRange(range: string): number {
  const { min, max } = parseRange(range);
  return (min + max) / 2;
}

export interface BuiltinNews {
  title: string;
  summary: string;
  impactStock: string;
  impactRange: string;
  duration: number;
  sector?: string;
}

export const BUILTIN_NEWS: BuiltinNews[] = [
  {
    title: "行业景气度回升，科技板块走强",
    summary: "下游需求回暖叠加政策支持，机构上调科技板块盈利预期，资金加速流入。",
    impactStock: "科技",
    impactRange: "+4%~+7%",
    duration: 2,
    sector: "科技",
  },
  {
    title: "消费复苏加速，食品饮料迎旺季",
    summary: "社零数据超预期，消费板块景气度上行，龙头公司订单饱满。",
    impactStock: "FOOD",
    impactRange: "+3%~+6%",
    duration: 2,
    sector: "消费",
  },
  {
    title: "国际油价波动，能源板块承压",
    summary: "供给端扰动缓解，原油价格短期回落，能源股短期承压。",
    impactStock: "ENE",
    impactRange: "-5%~-2%",
    duration: 2,
    sector: "能源",
  },
  {
    title: "新药获批，医药板块迎来利好",
    summary: "重磅新药临床数据亮眼，市场情绪高涨，医药估值有望修复。",
    impactStock: "MED",
    impactRange: "+6%~+9%",
    duration: 2,
    sector: "医药",
  },
  {
    title: "央行释放流动性，金融板块回暖",
    summary: "货币政策边际宽松，银行股估值修复行情启动。",
    impactStock: "BANK",
    impactRange: "+3%~+5%",
    duration: 3,
    sector: "金融",
  },
  {
    title: "钢铁限产落地，原材料供给收缩",
    summary: "行业减产预期强化，原材料价格获得支撑，周期板块活跃。",
    impactStock: "IRON",
    impactRange: "+4%~+8%",
    duration: 2,
    sector: "原材料",
  },
  {
    title: "区域供水提价，公用事业稳健",
    summary: "公用事业防御属性凸显，低波动资金持续流入。",
    impactStock: "WAT",
    impactRange: "+2%~+4%",
    duration: 3,
    sector: "公用事业",
  },
  {
    title: "海外科技股回调，风险偏好下降",
    summary: "海外市场波动加剧，成长板块短期承压，注意控制仓位。",
    impactStock: "科技",
    impactRange: "-4%~-1%",
    duration: 2,
    sector: "科技",
  },
  {
    title: "大宗商品反弹，周期股全线走强",
    summary: "美元走弱提振大宗商品，周期板块迎来反弹窗口。",
    impactStock: "ALL",
    impactRange: "+2%~+5%",
    duration: 2,
  },
  {
    title: "市场情绪谨慎，大盘缩量调整",
    summary: "成交萎缩、资金观望情绪浓，短线操作宜谨慎。",
    impactStock: "ALL",
    impactRange: "-2%~0%",
    duration: 1,
  },
];

/** 前端兜底新闻（后端不可用/纯离线时） */
export function generateFallbackNews(day: number, count?: number): NewsItem[] {
  const n = count ?? 2 + Math.floor(Math.random() * 2); // 2-3 条
  const pool = [...BUILTIN_NEWS].sort(() => Math.random() - 0.5);
  return pool.slice(0, Math.min(n, pool.length)).map((b) => ({
    id: nextId(),
    day,
    title: b.title,
    summary: b.summary,
    impactStock: b.impactStock,
    impactRange: b.impactRange,
    duration: b.duration,
    sector: b.sector,
    source: "builtin" as const,
    remaining: b.duration,
  }));
}

const SECTOR_SET = new Set(SECTORS);

/** 一条新闻是否影响某只股票 */
export function newsAffectsStock(n: NewsItem, code: string, sector: string): boolean {
  const target = n.impactStock;
  if (target === "ALL") return true;
  if (target === code) return true;
  if (SECTOR_SET.has(target)) return target === sector;
  if (n.sector && target === n.sector) return target === sector;
  return false;
}

/**
 * 某只股票当日新闻总影响（小数，0.065 = +6.5%）。
 * 个股新闻影响更大（×1.3），行业新闻 ×1.0，全市场 ×0.7。
 */
export function newsImpactFor(news: NewsItem[], code: string, sector: string): number {
  let total = 0;
  for (const n of news) {
    if (n.remaining <= 0) continue;
    if (!newsAffectsStock(n, code, sector)) continue;
    const median = medianOfRange(n.impactRange) / 100;
    if (n.impactStock === code) total += median * 1.3;
    else if (n.impactStock === "ALL") total += median * 0.7;
    else total += median;
  }
  return total;
}
