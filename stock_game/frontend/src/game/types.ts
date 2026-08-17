// 全局共享类型定义

export type OrderSide = "buy" | "sell";
export type OrderKind = "market" | "limit";
export type AIstyle = "aggressive" | "steady" | "trend";

export interface StockDef {
  code: string;
  name: string;
  sector: string;
  base: number; // 基础价值
}

export interface PriceBar {
  day: number;
  close: number;
  high: number;
  low: number;
  volume: number; // 手
  changePct: number; // 当日涨跌幅（小数，0.032 = +3.2%）
}

export interface StockMarket {
  def: StockDef;
  history: PriceBar[];
}

export interface Holding {
  code: string;
  qty: number; // 总持仓（股）
  sellable: number; // 可卖数量（T+1）
  avgCost: number; // 摊薄成本
}

export interface NewsItem {
  id: string;
  day: number;
  title: string;
  summary: string;
  impactStock: string; // 股票代码 / 行业名 / ALL
  impactRange: string; // 如 "+5%~+8%"
  duration: number;
  sector?: string;
  source: "ai" | "builtin";
  remaining: number; // 剩余影响天数
}

export interface PendingOrder {
  id: string;
  side: OrderSide;
  code: string;
  qty: number;
  limitPrice: number;
  createdDay: number;
}

export interface AITrader {
  id: string;
  name: string;
  style: AIstyle;
  cash: number;
  holdings: Record<string, number>;
  avgCost: Record<string, number>;
  history: { day: number; assets: number }[];
}

export interface GameState {
  version: number;
  day: number; // 当前交易日（0 = 初始，尚未开始）
  phase: "playing" | "settled";
  cash: number;
  holdings: Holding[];
  orders: PendingOrder[];
  market: Record<string, StockMarket>;
  news: NewsItem[];
  ai: AITrader[];
  initialCash: number;
  messages: string[];
}
