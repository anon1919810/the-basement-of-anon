// 股票定义与全局数值参数

import type { StockDef } from "./types";

export const STOCKS: StockDef[] = [
  { code: "STK", name: "星辰科技", sector: "科技", base: 100 },
  { code: "CLD", name: "云端软件", sector: "科技", base: 88 },
  { code: "FOOD", name: "味珍食品", sector: "消费", base: 42 },
  { code: "ENE", name: "黑金能源", sector: "能源", base: 35 },
  { code: "MED", name: "康泰医药", sector: "医药", base: 66 },
  { code: "BANK", name: "汇通银行", sector: "金融", base: 28 },
  { code: "IRON", name: "钢铁巨擘", sector: "原材料", base: 18 },
  { code: "WAT", name: "清源水务", sector: "公用事业", base: 55 },
];

export const SECTORS: string[] = [...new Set(STOCKS.map((s) => s.sector))];

export const STOCK_MAP: Record<string, StockDef> = Object.fromEntries(
  STOCKS.map((s) => [s.code, s]),
);

export const TOTAL_DAYS = 30; // 总交易日
export const INITIAL_CASH = 10000; // 初始资金
export const FEE_RATE = 0.001; // 双向手续费 0.1%
export const MIN_FEE = 1; // 最低手续费
export const LIMIT_PCT = 0.1; // ±10% 涨跌停
