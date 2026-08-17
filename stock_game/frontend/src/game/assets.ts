// 资产扩展：指数（不可交易）+ 债券 + 商品（可交易，T+1，±6% 日波动）

import type { GameState, IndexDef, TradeableDef } from "./types";
import { newsImpactFor } from "./news";
import { clamp, lastClose, rand, round2 } from "./util";

// ---------- 指数定义 ----------

export const INDICES: IndexDef[] = [
  { code: "FCX", name: "覆巢指数", stocks: ["STK", "CLD", "FOOD", "ENE", "MED", "BANK", "IRON", "WAT"] },
  { code: "TEC", name: "科技指数", stocks: ["STK", "CLD"] },
  { code: "ENEI", name: "能源指数", stocks: ["ENE"] },
  { code: "FIN", name: "金融指数", stocks: ["BANK"] },
];

// ---------- 债券 / 商品定义 ----------

export const BONDS: TradeableDef[] = [
  {
    code: "GB10",
    name: "十年期国债",
    sector: "债券",
    base: 100,
    kind: "bond",
    float: 0,
    borrowLimit: 0,
    cyclical: false,
  },
  {
    code: "HTB",
    name: "汇通企业债",
    sector: "债券",
    base: 100,
    kind: "bond",
    float: 0,
    borrowLimit: 0,
    cyclical: false,
  },
];

export const COMMODITIES: TradeableDef[] = [
  {
    code: "GOLD",
    name: "黄金",
    sector: "商品",
    base: 100,
    kind: "commodity",
    float: 0,
    borrowLimit: 0,
    cyclical: false,
  },
  {
    code: "OIL",
    name: "原油",
    sector: "商品",
    base: 100,
    kind: "commodity",
    float: 0,
    borrowLimit: 0,
    cyclical: false,
  },
];

/** 全部可交易资产（股票 + 债券 + 商品） */
export const TRADEABLE: TradeableDef[] = [...BONDS, ...COMMODITIES];

export const ASSET_MAP: Record<string, TradeableDef> = Object.fromEntries(
  TRADEABLE.map((a) => [a.code, a]),
);

/** 某资产是否可做空（仅股票） */
export function canShort(def: TradeableDef): boolean {
  return def.kind === "stock";
}

// ---------- 指数计算 ----------

/** 市值加权指数（收盘价 × 流通量）/（基准 × 流通量）× 100 */
export function computeIndexValue(state: GameState, def: IndexDef): number {
  let num = 0;
  let den = 0;
  for (const code of def.stocks) {
    const m = state.market[code];
    if (!m) continue;
    num += lastClose(m) * m.def.float;
    den += m.def.base * m.def.float;
  }
  return den > 0 ? (num / den) * 100 : 100;
}

/** 每日推进指数行情（在股票价格生成后调用） */
export function computeIndices(state: GameState): void {
  for (const def of INDICES) {
    const im = state.indices[def.code];
    const prev = im.history[im.history.length - 1].close;
    const close = round2(computeIndexValue(state, def));
    im.history.push({ day: state.day, close, changePct: prev > 0 ? close / prev - 1 : 0 });
  }
}

// ---------- 债券 / 商品定价 ----------

/**
 * 国债目标价：无风险利率反向。
 * 中性利率(3%) → 100；利率 1% → 108；利率 6% → 88。
 */
export function bondTarget(state: GameState, code: string): number {
  const { rateValue, inflationValue } = state.macro;
  if (code === "GB10") {
    return 100 * (1 - (rateValue - 0.03) * 4);
  }
  // 汇通企业债：利率反向 + 信用利差（高通胀侵蚀信用，金融行业新闻扰动）
  const credit = 1 - Math.max(0, inflationValue - 0.03) * 0.4;
  return 100 * (1 - (rateValue - 0.03) * 3.5) * credit;
}

/** 债券/商品当日价格生成（在股票价格生成后调用） */
export function simulateAssetPrices(state: GameState): void {
  const params = state.params;
  for (const def of TRADEABLE) {
    const m = state.market[def.code];
    const prev = lastClose(m);
    let drift: number;

    if (def.kind === "bond") {
      const target = bondTarget(state, def.code);
      const gap = target / prev - 1;
      // 向目标收敛（每天收敛约 25% 缺口）+ 小噪声；危机期间股债双杀（债券流动性抛售）
      drift = gap * 0.25;
      if (state.macro.crisisRemaining > 0) drift += rand(-0.025, -0.005);
      else drift += rand(-0.003, 0.003);
      if (def.code === "HTB") {
        // 信用利差：金融行业新闻影响
        drift += newsImpactFor(state.news, def.code, "金融") * 0.5;
        drift += rand(-0.004, 0.004);
      }
    } else if (def.code === "GOLD") {
      // 避险：危机 +10~20%（分 3 天），高通胀 +5~10%（持续漂移），风险偏好回升回落
      drift = rand(-0.005, 0.005);
      if (state.macro.crisisRemaining > 0) drift += rand(0.03, 0.07);
      if (state.macro.inflation === "high") drift += rand(0.006, 0.01);
      else if (state.macro.inflation === "mid") drift += rand(-0.001, 0.002);
      else drift -= rand(0.001, 0.003);
    } else {
      // 原油：能源联动 + 油价冲击事件
      drift = rand(-0.012, 0.012);
      if (state.macro.oilBoostDays > 0) drift += rand(0.04, 0.08);
      drift += newsImpactFor(state.news, def.code, "能源") * 0.6;
    }

    const pct = clamp(drift, -params.assetLimitPct, params.assetLimitPct);
    const limitUp = prev * (1 + params.assetLimitPct);
    const limitDown = prev * (1 - params.assetLimitPct);
    const close = clamp(round2(prev * (1 + pct)), limitDown, limitUp);
    const actualPct = close / prev - 1;
    const open = round2(prev * (1 + rand(-0.002, 0.002)));
    const high = clamp(round2(Math.max(open, close) * (1 + rand(0, 0.003))), limitDown, limitUp);
    const low = clamp(round2(Math.min(open, close) * (1 - rand(0, 0.003))), limitDown, limitUp);
    m.history.push({
      day: state.day,
      close,
      high,
      low,
      volume: Math.round(rand(500, 4000)),
      changePct: actualPct,
      volBreakdown: { retail: 0, inst: 0, hot: 0 },
    });
  }
}
