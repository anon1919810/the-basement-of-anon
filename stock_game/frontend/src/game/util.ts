// 数值工具函数

export const round2 = (v: number): number => Math.round(v * 100) / 100;

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export interface BarLike {
  day: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  changePct: number;
}

export interface MarketLike {
  history: BarLike[];
}

/** 最近一根 K 线 */
export function lastBar(m: MarketLike): BarLike {
  return m.history[m.history.length - 1];
}

/** 数组末元素（指数等无 K 线结构的历史用） */
export function lastOf<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

/** 最新收盘价 */
export function lastClose(m: MarketLike): number {
  return lastBar(m).close;
}

/** 金额格式化 */
export function fmtMoney(v: number): string {
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 涨跌幅格式化（输入小数，如 0.032 -> "+3.20%"） */
export function fmtPct(v: number): string {
  const pct = v * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** 成交量（手）格式化 */
export function fmtVol(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(2)}万`;
  return `${v}`;
}
