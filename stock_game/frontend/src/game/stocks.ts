// 股票定义与全局数值参数（v0.1.0：60 交易日）

import type { StockDef } from "./types";

function mk(code: string, name: string, sector: string, base: number, float: number, cyclical = false): StockDef {
  return {
    code,
    name,
    sector,
    base,
    kind: "stock",
    float,
    borrowLimit: Math.round(float * 0.2), // 可借上限 = 流通量 × 20%
    cyclical,
  };
}

export const STOCKS: StockDef[] = [
  mk("STK", "星辰科技", "科技", 100, 500_000_000),
  mk("CLD", "云端软件", "科技", 88, 400_000_000),
  mk("FOOD", "味珍食品", "消费", 42, 800_000_000, true),
  mk("ENE", "黑金能源", "能源", 35, 1_000_000_000, true),
  mk("MED", "康泰医药", "医药", 66, 600_000_000),
  mk("BANK", "汇通银行", "金融", 28, 1_500_000_000),
  mk("IRON", "钢铁巨擘", "原材料", 18, 1_200_000_000, true),
  mk("WAT", "清源水务", "公用事业", 55, 700_000_000),
];

export const SECTORS: string[] = [...new Set(STOCKS.map((s) => s.sector))];

export const STOCK_MAP: Record<string, StockDef> = Object.fromEntries(
  STOCKS.map((s) => [s.code, s]),
);

export const TOTAL_DAYS = 60; // 总交易日
export const INITIAL_CASH = 10000; // 初始资金

// 以下常量保留兼容（v0.0.0 遗留导出；新逻辑统一读 state.params）
export const FEE_RATE = 0.001;
export const MIN_FEE = 1;
export const LIMIT_PCT = 0.1;
