// 可调参数（调参面板默认值 = 设计文档第 7 节数值初稿）

import type { TunableParams } from "./types";

export const DEFAULT_PARAMS: TunableParams = {
  feeRate: 0.001, // 双向手续费 0.1%
  minFee: 1, // 最低手续费 1
  limitPct: 0.1, // 股票涨跌停 ±10%
  assetLimitPct: 0.06, // 债券/商品单日 ±6%
  shortMarginRate: 0.5, // 做空保证金率 50%
  forceCloseLine: 0.8, // 强平线：浮亏达保证金 80%
  borrowFeeRate: 0.0002, // 借券费率 0.02%/日
  macroMinDays: 5, // 宏观事件频率 5-8 天
  macroMaxDays: 8,
  retailShare: 0.4, // 散户 40%
  instShare: 0.45, // 机构 45%
  hotShare: 0.15, // 游资 15%
  crisisProb: 0.2, // 危机概率约 20%（每局 0-1 次）
};

export const PARAM_LABELS: { key: keyof TunableParams; label: string; unit: string; step: number }[] = [
  { key: "feeRate", label: "手续费率", unit: "%", step: 0.01 },
  { key: "minFee", label: "最低手续费", unit: "", step: 0.5 },
  { key: "limitPct", label: "股票涨跌停", unit: "%", step: 0.5 },
  { key: "assetLimitPct", label: "债券/商品日波动上限", unit: "%", step: 0.5 },
  { key: "shortMarginRate", label: "做空保证金率", unit: "%", step: 1 },
  { key: "forceCloseLine", label: "强平线（保证金浮亏）", unit: "%", step: 1 },
  { key: "borrowFeeRate", label: "借券费率（/日）", unit: "%", step: 0.005 },
  { key: "macroMinDays", label: "宏观事件最小间隔", unit: "天", step: 1 },
  { key: "macroMaxDays", label: "宏观事件最大间隔", unit: "天", step: 1 },
  { key: "crisisProb", label: "危机概率", unit: "%", step: 1 },
  { key: "retailShare", label: "散户成交占比", unit: "%", step: 1 },
  { key: "instShare", label: "机构成交占比", unit: "%", step: 1 },
  { key: "hotShare", label: "游资成交占比", unit: "%", step: 1 },
];

/** 显示值（百分比参数以小数存储，展示乘 100） */
export function paramDisplay(key: keyof TunableParams, v: number): number {
  if (key === "minFee") return v;
  return v * 100;
}

/** 从显示值还原存储值 */
export function paramFromDisplay(key: keyof TunableParams, v: number): number {
  if (key === "minFee") return Math.round(v);
  return v / 100;
}
