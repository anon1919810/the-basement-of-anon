// 全局共享类型定义（v0.1.0 深度版）

export type AssetKind = "stock" | "bond" | "commodity" | "index";
export type OrderSide = "buy" | "sell" | "short" | "cover";
export type OrderKind = "market" | "limit";
export type AIstyle = "aggressive" | "steady" | "trend";

/** 可交易资产（股票/债券/商品）共用字段 */
export interface TradeableDef {
  code: string;
  name: string;
  sector: string;
  base: number; // 基准价（宏观中性时的基础价值）
  kind: AssetKind;
  float: number; // 流通量（股，股票专用）
  borrowLimit: number; // 可借上限 = float × 0.2
  cyclical: boolean; // 周期股（对通胀更敏感）
}

export interface StockDef extends TradeableDef {
  kind: "stock";
}

export interface PriceBar {
  day: number;
  open?: number; // 开盘价（可选，day 0 无）
  close: number;
  high: number;
  low: number;
  volume: number; // 手
  changePct: number; // 当日涨跌幅（小数，0.032 = +3.2%）
  volBreakdown?: { retail: number; inst: number; hot: number }; // 手（散户/机构/游资）
}

export interface StockMarket {
  def: TradeableDef;
  history: PriceBar[];
}

export interface Holding {
  code: string;
  qty: number; // 多头持仓（股）
  sellable: number; // 可卖数量（T+1）
  avgCost: number; // 摊薄成本
}

export interface ShortPosition {
  code: string;
  qty: number; // 空头股数
  avgPrice: number; // 卖空均价
  margin: number; // 冻结保证金
  openDay: number; // 开仓日（T+1 平仓）
}

export type NewsSource = "ai" | "builtin" | "macro";

export interface NewsItem {
  id: string;
  day: number;
  title: string;
  summary: string;
  impactStock: string; // 股票代码 / 行业名 / ALL / 资产代码
  impactRange: string; // 如 "+5%~+8%"
  duration: number;
  sector?: string;
  source: NewsSource;
  remaining: number; // 剩余影响天数
  kind?: "stock" | "macro";
}

export interface PendingOrder {
  id: string;
  side: OrderSide;
  code: string;
  qty: number;
  limitPrice: number;
  createdDay: number;
}

export type TradeAction =
  | "buy"
  | "sell"
  | "short"
  | "cover"
  | "force_cover"
  | "borrow_fee"
  | "dividend";

export interface TradeLogItem {
  id: string;
  day: number;
  code: string;
  name: string;
  action: TradeAction;
  qty: number;
  price: number;
  amount: number; // 金额（不含手续费）
  fee: number;
  note?: string;
}

export interface TradeStats {
  totalTrades: number; // 买卖/做空/平仓次数合计
  winTrades: number; // 盈利平仓次数
  totalFee: number; // 手续费 + 借券费合计
  buyCount: number;
  sellCount: number;
  shortCount: number;
  coverCount: number;
  realized: Record<string, number>; // 按标的已实现盈亏
}

export interface DragonSignal {
  day: number;
  code: string;
  name: string;
  text: string;
  kind: "inst" | "hot" | "retail";
}

export interface Institution {
  id: string;
  name: string;
  cash: number;
  holdings: Record<string, number>;
  avgCost: Record<string, number>;
  history: { day: number; assets: number }[];
}

export interface PoolTrader {
  cash: number;
  holdings: Record<string, number>;
  avgCost: Record<string, number>;
  history: { day: number; assets: number }[];
}

export type InflationLevel = "low" | "mid" | "high";
export type RateLevel = "loose" | "neutral" | "tight";

export interface MacroState {
  inflation: InflationLevel;
  rate: RateLevel;
  inflationValue: number; // 0.01 / 0.03 / 0.08
  rateValue: number; // 0.01 / 0.03 / 0.06
  nextEventDay: number;
  inflationHighStreak: number; // 高通胀持续期数（≥2 强制加息）
  crisisUsed: boolean; // 每局最多 1 次危机
  crisisRemaining: number; // 危机持续剩余天数（>0 表示危机中）
  oilBoostDays: number; // 油价冲击剩余天数
  events: { day: number; type: string; title: string }[];
}

export interface IndexDef {
  code: string;
  name: string;
  stocks: string[]; // 成分股代码
}

export interface IndexBar {
  day: number;
  close: number;
  changePct: number;
}

export interface IndexMarket {
  def: IndexDef;
  history: IndexBar[];
}

export interface TunableParams {
  feeRate: number; // 双向手续费率
  minFee: number; // 最低手续费
  limitPct: number; // 股票涨跌停
  assetLimitPct: number; // 债券/商品单日 ±6%
  shortMarginRate: number; // 做空保证金率
  forceCloseLine: number; // 强平线（保证金浮亏比例）
  borrowFeeRate: number; // 借券费率（/日）
  macroMinDays: number; // 宏观事件频率（最小间隔）
  macroMaxDays: number; // 宏观事件频率（最大间隔）
  retailShare: number; // 散户成交占比基准
  instShare: number; // 机构成交占比基准
  hotShare: number; // 游资成交占比基准
  crisisProb: number; // 每次宏观事件的危机概率
}

export interface ReportAttribution {
  code: string;
  name: string;
  pnl: number;
}

export interface ReportData {
  totalAssets: number;
  ret: number;
  indexRet: number; // 覆巢指数收益率
  alpha: number; // 跑赢指数幅度
  instAvgRet: number; // 机构平均收益率
  attribution: ReportAttribution[]; // 降序
  winRate: number; // 胜率（小数）
  tradeStats: TradeStats;
}

export interface GameState {
  version: number;
  day: number; // 当前交易日（0 = 初始）
  phase: "playing" | "settled";
  cash: number;
  holdings: Holding[]; // 多头
  shorts: ShortPosition[]; // 空头
  borrowed: Record<string, number>; // 玩家累计借入股数
  marginReserved: number; // 冻结保证金合计
  orders: PendingOrder[];
  market: Record<string, StockMarket>; // 可交易资产（股票+债券+商品）
  indices: Record<string, IndexMarket>; // 指数（不可交易）
  news: NewsItem[];
  macro: MacroState;
  params: TunableParams;
  pendingParams: TunableParams | null; // 调参暂存，下一交易日生效
  institutions: Institution[]; // 5-10 家机构
  retail: PoolTrader; // 散户资金池（聚合）
  hot: PoolTrader; // 游资资金池（聚合）
  hotCycles: Record<
    string,
    { phase: "idle" | "pump" | "dump"; day: number; untilDay: number }
  >;
  playerHistory: { day: number; assets: number }[];
  institutionAvgHistory: { day: number; assets: number }[];
  tradeLog: TradeLogItem[];
  tradeStats: TradeStats;
  signals: DragonSignal[];
  report: ReportData | null;
  initialCash: number;
  messages: string[];
}
