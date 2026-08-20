/**
 * 金融系统（v0.11，三层）：货币层 + 信贷层 + 银行层。
 *
 * ① 货币层：货币供给 M = 铸币（国库支出 → 铸币税） + 信贷创造；
 *    通胀压力 = f(M / 经济规模) → 温和修正商品价格（不破坏守恒，纯价格水平）。
 * ② 信贷层：国库国债（借入/付息/还本/违约）；私营杠杆（资本池可透支建厂，简单版）。
 * ③ 银行层：银行建筑 → 银行资本金；准备金率（体制决定）；存贷利差；金融危机风险。
 *
 * 守恒：所有金融现金流记入 ledger.finance（国库 Δ 断言 = income - spending + investReturn - investCost + investRefund + finance）。
 */
import type { GameState, NationState } from './state';
import type { GoodId } from './types';

// ---- ① 货币层 ----

/** 铸币成本：铸 1 万₭ 消耗 0.2 万₭ 行政资源（铸币税 = 0.8 万₭/万₭） */
export const MINT_COST_RATIO = 0.2;
/** 信贷创造乘数（发债 1 万₭ → 货币供给 +1 万₭ × 乘数；准备金率越低乘数越大） */
export function creditMultiplier(reserveRatio: number): number {
  return clamp(1 / Math.max(0.1, reserveRatio), 1, 5);
}
/** 通胀压力（0-1）：M/经济规模 偏离 1 的程度（温和系数；货币流速≈2） */
export function inflationPressureOf(moneySupply: number, nominalOutput: number): number {
  // nominalOutput = 年 GDP；货币流通速度 2 → 均衡 M = GDP/2
  const equilibrium = Math.max(1e-9, nominalOutput / 2);
  const ratio = equilibrium > 1e-9 ? moneySupply / equilibrium : 1;
  return clamp((ratio - 1) * 0.6, -0.15, 0.25); // 温和：±15%~25% 上限
}

// ---- ② 信贷层 ----

/** 基础利率（年化 %）：初始 4% + 通胀压力×2 + 政权修正 */
export function baseRateOf(n: NationState): number {
  const inf = inflationPressureOf(n.moneySupply, n.monthly.income * 12 + n.treasury);
  let rate = 4 + inf * 2;
  if (/专制|独裁/.test(n.gov)) rate -= 1; // 强权压低利率
  if (/共和|城邦|议会/.test(n.gov)) rate += 1; // 民主制度溢价
  return rate;
}
/** 信用利差：国库赤字/低稳定度 → 溢价 */
export function creditSpreadOf(n: NationState): number {
  let s = 0;
  if (n.treasury < 0) s += 3;
  if (n.stability < 40) s += 2;
  if (n.debtTotal > 0 && n.debtTotal > n.tax.rates.poll * 0 + 1) s += Math.min(5, n.debtTotal / Math.max(1, n.monthly.income) * 1.2);
  return s;
}
/** 实际利率 = 基础 + 利差 */
export function actualRateOf(n: NationState): number {
  return clamp(baseRateOf(n) + creditSpreadOf(n), 1, 30);
}
/** 信贷上限：估算税收年收入 × 政权系数（专制 2×，共和 4×）；新局 ledger 未结算时用人口×人均税率估算 */
export function creditLimitOf(n: NationState): number {
  const rates = n.tax.rates;
  const rateSum = rates.land + rates.poll + rates.consumption + rates.tariff + rates.other;
  // 估算年税收：人均 4 万₭/年 × 人口(万) × 综合税率系数（粗估，含商品税）
  const estimatedAnnual = n.popWan * 4 * (0.15 + rateSum * 0.9);
  const annualTax = Math.max(n.monthly.income * 12, estimatedAnnual);
  let mult = 3;
  if (/专制|独裁/.test(n.gov)) mult = 2;
  if (/共和|城邦|议会/.test(n.gov)) mult = 4;
  return Math.max(0, annualTax * mult);
}

// ---- ③ 银行层 ----

/** 银行建筑单座基准资本（万₭） */
export const BANK_BASE_CAPITAL = 200;
/** 各体制准备金率 */
export const RESERVE_RATIO: Record<string, number> = {
  traditionalism: 0.2, laissezFaire: 0.1, draconian: 0.25,
};
/** 存款利率（付给资本池） */
export const DEPOSIT_RATE = 0.02;
/** 金融危机阈值：资本池透支超过该比例触发 */
export const CRISIS_TRIGGER = -300;

/** 银行总资本 = Σ 银行建筑 × 基准（银行家 POP 收入走投资池分流） */
export function bankCapitalOf(n: NationState): number {
  let banks = 0;
  for (const p of n.projects) if (p.status === 'active' && p.kind === 'bank') banks++;
  return banks * BANK_BASE_CAPITAL;
}

/** 准备金 = 银行资本 × (1 - 准备金率)；不足 → 挤兑风险指数 */
export function reserveOf(n: NationState): number {
  const rr = RESERVE_RATIO[n.policies.economicLaw] ?? 0.2;
  return bankCapitalOf(n) * (1 - rr);
}

/** 金融危机检查：资本池透支超阈值 → 返回危机月数（0=无危机） */
export function crisisMonthsOf(n: NationState): number {
  return n.capitalWealth < CRISIS_TRIGGER ? Math.min(6, Math.ceil(-n.capitalWealth / 100)) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---- 月度结算（确定性；由 economy.settleFinanceMonth 调用） ----

export interface FinanceSettlement {
  /** 月度金融现金流（万₭；正=进国库，负=出国库）——记入 ledger.finance */
  cashflow: number;
  /** 本月铸币额 */
  minted: number;
  /** 本月国债利息（付给银行家/资本池） */
  debtInterest: number;
  /** 本月还本 */
  debtRepay: number;
  /** 本月新发债（玩家操作，结算时落账） */
  issued: number;
  /** 通胀压力（0-1，结算后更新） */
  inflation: number;
  /** 实际利率（年化 %） */
  rate: number;
}

/**
 * 金融月度结算：
 *  - 铸币：n.mintRate 万₭/月 → 国库 +铸币税（扣除铸币成本），货币供给 +
 *  - 国债利息：debtTotal × actualRate/12 → 国库 -，资本池 +（银行家利差收入）
 *  - 私营杠杆：资本池不足时自动透支（简单版：透支额 = min(信贷上限剩余, 缺口)）→ 资本池 -
 *  - 金融危机：资本池超透支 → n.finCrisisMonths 冷却，投资冻结
 */
export function settleFinanceMonth(state: GameState): FinanceSettlement {
  const n = state.nations[state.playerNation];
  const out: FinanceSettlement = {
    cashflow: 0, minted: 0, debtInterest: 0, debtRepay: 0, issued: 0, inflation: 0, rate: actualRateOf(n),
  };

  // ① 铸币（玩家设定月铸币率，万₭/月）
  const mintRate = n.mintRate ?? 0;
  if (mintRate > 0.001) {
    const minted = mintRate;
    const cost = minted * MINT_COST_RATIO;
    out.minted = minted;
    n.treasury += minted - cost; // 铸币税 = minted - cost
    n.moneySupply += minted;
    out.cashflow += minted - cost;
  }

  // ② 国债利息（debtTotal × 年利率/12）
  if (n.debtTotal > 0.001) {
    const interest = (n.debtTotal * out.rate) / 100 / 12;
    n.treasury -= interest;
    n.capitalWealth += interest; // 银行家利差收入（并入资本池）
    out.debtInterest = interest;
    out.cashflow -= interest;
    // 还本（简化：无到期日，按 2%/月 摊还；利率已含风险）
    const repay = Math.min(n.debtTotal, n.debtTotal * 0.02);
    n.treasury -= repay;
    n.debtTotal -= repay;
    out.debtRepay = repay;
    out.cashflow -= repay;
  }

  // ③ 私营杠杆（简单版）：资本池透支建厂额度 = 银行资本 × 0.5（随银行扩张）
  //    实际透支发生在 buildings 自动投资时（capitalWealth 允许为负至 -信贷杠杆上限）；
  //    这里只做危机检查与恢复。透支部分按 1%/月 计息（从资本池扣，不进国库）。
  if (n.capitalWealth < 0) {
    const leverageInterest = -n.capitalWealth * 0.01;
    n.capitalWealth -= leverageInterest; // 负利滚负
  }
  if (n.finCrisisMonths > 0) {
    n.finCrisisMonths--;
    n.capitalWealth = Math.min(n.capitalWealth, -1); // 危机中资本池冻结（不允许再透支）
  } else {
    const crisis = crisisMonthsOf(n);
    if (crisis > 0) {
      n.finCrisisMonths = crisis;
      out.cashflow += 0; // 危机本身无现金流
    }
  }

  // ④ 通胀压力更新（温和修正，供市场引用）；年 GDP ≈ 人口 × 人均 4 万₭/年（与月度实收取大）
  const annualGdp = Math.max(n.monthly.income * 12 + n.monthly.investReturn * 12, n.popWan * 4);
  out.inflation = inflationPressureOf(n.moneySupply, Math.max(1, annualGdp));
  n.inflation = out.inflation;

  return out;
}

/** 发行国债（玩家操作）：borrow 万₭（受信贷上限约束） */
export function issueDebt(state: GameState, borrow: number): boolean {
  const n = state.nations[state.playerNation];
  if (borrow <= 0) return false;
  const limit = creditLimitOf(n);
  if (n.debtTotal + borrow > limit) return false;
  n.debtTotal += borrow;
  n.moneySupply += borrow; // 信贷创造
  n.treasury += borrow;
  return true;
}

/** 归还国债（玩家操作） */
export function repayDebt(state: GameState, amount: number): boolean {
  const n = state.nations[state.playerNation];
  if (amount <= 0 || n.debtTotal <= 0) return false;
  const a = Math.min(amount, n.treasury, n.debtTotal);
  n.treasury -= a;
  n.debtTotal -= a;
  n.moneySupply = Math.max(0, n.moneySupply - a); // 还本回收货币
  return true;
}

/** 铸币率设定（玩家操作；万₭/月） */
export function setMintRate(state: GameState, rate: number): void {
  const n = state.nations[state.playerNation];
  n.mintRate = clamp(rate, 0, 50);
}

// ---- 市场价格修正（温和通胀） ----
/** 通胀修正系数：价格 × (1 + inflationPressure × priceExposure)；exposure 按商品敏感度 */
export function priceInflationFactor(inflation: number, good: GoodId): number {
  // 必需品敏感度低（政策受控），奢侈品/中间品敏感度高
  const SENS: Partial<Record<GoodId, number>> = {
    food: 0.6, wheat: 0.6, coal: 0.7, iron: 0.8, steel: 0.9, tools: 0.8,
    luxury: 1.1, coffee: 1.0, tobacco: 1.0, clothing: 0.7,
  };
  const s = SENS[good] ?? 0.8;
  return 1 + inflation * s;
}
