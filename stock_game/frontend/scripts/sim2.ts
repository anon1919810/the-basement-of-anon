// 无头 60 天对局模拟（v0.1.0 深度版校验）
// 覆盖：宏观（利率升降方向、危机股市跌黄金涨）、做空（保证金/强平/可借余量）、
//       交易者（成交占比）、资产（债券利率反向、黄金危机大涨）、全流程（现金非负、多空一致）
// 运行：cd frontend && cmd /c "npx.cmd tsx scripts/sim2.ts"

import { createInitialState, computeAssets, placeMarketOrder } from "../src/game/state";
import { advanceDay } from "../src/game/engine";
import { STOCKS, TOTAL_DAYS } from "../src/game/stocks";
import { BONDS, COMMODITIES } from "../src/game/assets";
import { fundamentalValue, triggerMacroEvent } from "../src/game/macro";
import {
  openShort,
  coverShort,
  forceCloseShorts,
  borrowableOf,
  forceClosePrice,
} from "../src/game/short";
import { lastBar, lastClose, round2 } from "../src/game/util";
import type { GameState } from "../src/game/types";

let failures = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

// mock 后端新闻（走 "ai" 分支，纯离线）
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      news: [
        { title: "测试利好", summary: "摘要", impact_stock: "STK", impact_range: "+3%~+5%", duration: 2 },
        { title: "测试利空", summary: "摘要", impact_stock: "能源", impact_range: "-4%~-2%", duration: 2 },
      ],
    }),
    { status: 200 },
  );

// ============ A. 宏观基础价值方向（纯函数） ============
console.log("[A] 宏观基础价值公式");
{
  const base = createInitialState();
  const fundAtRate = (rate: number) => {
    const s = structuredClone(base);
    s.macro.rateValue = rate;
    return fundamentalValue(s, STOCKS[0]);
  };
  assert(fundAtRate(0.06) < fundAtRate(0.03), "利率 6% > 3% → 基础价值下降（杀估值）");
  assert(fundAtRate(0.01) > fundAtRate(0.03), "利率 1% < 3% → 基础价值上升（估值扩张）");

  const fundAtInf = (inf: number, def = STOCKS[0]) => {
    const s = structuredClone(base);
    s.macro.inflationValue = inf;
    return fundamentalValue(s, def);
  };
  assert(fundAtInf(0.08) < fundAtInf(0.03), "高通胀 → 基础价值下降（利润率压缩）");
  const cyc = STOCKS.find((s) => s.cyclical)!;
  const nonCyc = STOCKS.find((s) => !s.cyclical)!;
  const cycRatio = fundAtInf(0.08, cyc) / fundAtInf(0.03, cyc);
  const nonCycRatio = fundAtInf(0.08, nonCyc) / fundAtInf(0.03, nonCyc);
  assert(cycRatio < nonCycRatio, "周期股对通胀更敏感（跌幅更大）");
}

// ============ B. 利率升降 → 债券反向 ============
console.log("[B] 利率方向 → 国债价格反向");
{
  let s = createInitialState();
  const fired = triggerMacroEvent(s, "rate_hike");
  assert(fired === "rate_hike", "强制触发加息事件");
  assert(s.macro.rateValue === 0.06, "加息后利率 = 6%");
  const before = lastClose(s.market["GB10"]);
  s = await advanceDay(s);
  const after = lastClose(s.market["GB10"]);
  assert(after < before, `加息后国债价格下跌（${before.toFixed(2)} → ${after.toFixed(2)}）`);
  assert(
    s.news.some((n) => n.kind === "macro" && n.impactRange.startsWith("-")),
    "宏观（加息）新闻已进新闻流",
  );
  const s2 = createInitialState();
  triggerMacroEvent(s2, "rate_cut");
  assert(s2.macro.rateValue === 0.01, "降息后利率 = 1%");
  const b2 = lastClose(s2.market["GB10"]);
  const s2b = await advanceDay(s2);
  const a2 = lastClose(s2b.market["GB10"]);
  assert(a2 > b2, `降息后国债价格上涨（${b2.toFixed(2)} → ${a2.toFixed(2)}）`);
}

// ============ C. 黑天鹅危机 ============
console.log("[C] 黑天鹅危机：股市跌、黄金涨");
{
  const s = createInitialState();
  triggerMacroEvent(s, "black_swan");
  assert(s.macro.crisisRemaining === 3, "危机持续 3 天");
  const s2 = await advanceDay(s);
  const avgStock = STOCKS.reduce((sum, d) => sum + lastBar(s2.market[d.code]).changePct, 0) / STOCKS.length;
  assert(avgStock < -0.02, `危机日股票平均跌幅 ${(avgStock * 100).toFixed(2)}% < -2%`);
  const goldChg = lastBar(s2.market["GOLD"]).changePct;
  assert(goldChg > 0.01, `危机日黄金涨幅 ${(goldChg * 100).toFixed(2)}% > +1%`);
}

// ============ D. 做空机制 ============
console.log("[D] 做空：保证金 / 强平 / 可借余量 / T+1");
{
  const s = createInitialState();
  const r1 = openShort(s, "STK", 1000000);
  assert(!r1.ok, "保证金不足 → 拒开做空");

  const r2 = openShort(s, "STK", 100);
  assert(r2.ok, "正常做空成功");
  assert(s.shorts.length === 1, "空头持仓已记录");
  assert(Math.abs(s.marginReserved - 100 * 100 * 0.5) < 0.01, `冻结保证金 = 金额 × 50%（${s.marginReserved}）`);

  const rc = coverShort(s, "STK", 100);
  assert(!rc.ok, "做空 T+1：当日不可平仓");

  // 可借余量耗尽
  s.borrowed["STK"] = STOCKS[0].borrowLimit;
  const r3 = openShort(s, "STK", 100);
  assert(!r3.ok, "可借余量为 0 → 拒开做空");
  s.borrowed["STK"] = 0;

  // 达线强平：把现价抬到强平线上方
  const pos = s.shorts[0];
  const fp = forceClosePrice(s, pos);
  s.market["STK"].history[s.market["STK"].history.length - 1].close = round2(fp * 1.01);
  forceCloseShorts(s);
  assert(s.shorts.length === 0, "浮亏达保证金 80% → 自动强平");
  assert(s.tradeLog.some((t) => t.action === "force_cover"), "强平记录进成交流水");

  // 次日平空成功
  const s2 = createInitialState();
  openShort(s2, "STK", 100);
  s2.day = 1;
  const ok2 = coverShort(s2, "STK", 100);
  assert(ok2.ok, "T+1 后平空成功");
  assert(s2.shorts.length === 0 && Math.abs(s2.marginReserved) < 0.01, "平空后保证金释放、空头清空");
  assert(borrowableOf(s2, "STK") === STOCKS[0].borrowLimit, "平空后可借余量恢复");
}

// ============ E. 60 天全流程 ============
console.log("[E] 60 天全流程：成交构成 / 不变量 / 结算复盘");
{
  let s = createInitialState();
  let retailSum = 0;
  let instSum = 0;
  let hotSum = 0;
  let volDays = 0;

  const allAssets = [...STOCKS, ...BONDS, ...COMMODITIES];

  for (let d = 1; d <= TOTAL_DAYS; d++) {
    s = await advanceDay(s);

    // ---- 玩家随机操作（保持现金非负由撮合校验保证）----
    const rnd = Math.random();
    if (rnd < 0.35) {
      const def = allAssets[Math.floor(Math.random() * allAssets.length)];
      placeMarketOrder(s, "buy", def.code, 100);
    } else if (rnd < 0.55) {
      const h = s.holdings.find((x) => x.sellable >= 100);
      if (h) placeMarketOrder(s, "sell", h.code, 100);
    } else if (rnd < 0.78) {
      const def = STOCKS[Math.floor(Math.random() * STOCKS.length)];
      if (borrowableOf(s, def.code) >= 100) openShort(s, def.code, 100);
    } else {
      const pos = s.shorts.find((p) => p.openDay < s.day && p.qty >= 100);
      if (pos) coverShort(s, pos.code, 100);
    }

    // ---- 不变量 ----
    if (s.cash < -1e-6) throw new Error(`现金为负 D${d}: ${s.cash}`);
    for (const h of s.holdings) {
      if (h.qty < 0) throw new Error(`多头持仓为负 ${h.code}`);
      if (h.sellable > h.qty + 1e-9) throw new Error(`可卖>持仓 ${h.code}`);
    }
    for (const p of s.shorts) {
      if (p.qty <= 0) throw new Error(`空头数量非正 ${p.code}`);
    }
    const marginSum = s.shorts.reduce((sum, p) => sum + p.margin, 0);
    if (Math.abs(marginSum - s.marginReserved) > 0.01)
      throw new Error(`保证金合计不一致 D${d}: ${marginSum} vs ${s.marginReserved}`);
    for (const def of STOCKS) {
      const bar = lastBar(s.market[def.code]);
      if (Math.abs(bar.changePct) > s.params.limitPct + 1e-6)
        throw new Error(`股票涨跌停超限 ${def.code} D${d}: ${bar.changePct}`);
      if (!(bar.close > 0)) throw new Error(`非正价格 ${def.code}`);
      if (bar.volume < 0) throw new Error(`负成交量 ${def.code}`);
      const vb = bar.volBreakdown;
      if (vb) {
        retailSum += vb.retail;
        instSum += vb.inst;
        hotSum += vb.hot;
        volDays += 1;
      }
    }
    for (const def of [...BONDS, ...COMMODITIES]) {
      const bar = lastBar(s.market[def.code]);
      if (Math.abs(bar.changePct) > s.params.assetLimitPct + 1e-6)
        throw new Error(`债券/商品日波动超限 ${def.code} D${d}: ${bar.changePct}`);
      if (!(bar.close > 0)) throw new Error(`非正价格 ${def.code}`);
    }
  }

  assert(s.phase === "settled", "第 60 天进入结算");
  assert(s.report !== null, "结算生成复盘报告");
  assert(s.macro.events.length >= 2, `宏观事件发生 ${s.macro.events.length} 次（>=2）`);
  assert(
    s.macro.events.some((e) => e.type === "rate_hike" || e.type === "rate_cut"),
    "利率周期事件至少发生 1 次",
  );

  const total = retailSum + instSum + hotSum;
  const rShare = total > 0 ? retailSum / total : 0;
  const iShare = total > 0 ? instSum / total : 0;
  const hShare = total > 0 ? hotSum / total : 0;
  assert(rShare >= 0.3 && rShare <= 0.5, `散户成交占比 ${(rShare * 100).toFixed(1)}% ∈ [30%, 50%]`);
  assert(iShare >= 0.35 && iShare <= 0.55, `机构成交占比 ${(iShare * 100).toFixed(1)}% ∈ [35%, 55%]`);
  assert(hShare >= 0.05 && hShare <= 0.25, `游资成交占比 ${(hShare * 100).toFixed(1)}% ∈ [5%, 25%]`);

  const rep = s.report!;
  assert(Number.isFinite(rep.ret) && Number.isFinite(rep.alpha), "报告包含收益率与超额收益");
  assert(rep.attribution.length > 0, `收益归因 ${rep.attribution.length} 个标的`);
  assert(rep.tradeStats.totalFee >= 0 && rep.winRate >= 0 && rep.winRate <= 1, "交易统计合法");

  const assets = computeAssets(s);
  console.log(
    `  天数:${s.day} 玩家资产:${assets.toFixed(2)} 收益率:${(rep.ret * 100).toFixed(2)}% 指数:${(rep.indexRet * 100).toFixed(2)}% alpha:${(rep.alpha * 100).toFixed(2)}%`,
  );
  console.log(`  宏观事件: ${s.macro.events.map((e) => e.type).join(", ")}`);
  console.log(`  交易: ${rep.tradeStats.totalTrades} 次 手续费+借券费:${rep.tradeStats.totalFee.toFixed(2)} 胜率:${(rep.winRate * 100).toFixed(1)}%`);
  console.log(`  成交构成: 散户${(rShare * 100).toFixed(1)}% 机构${(iShare * 100).toFixed(1)}% 游资${(hShare * 100).toFixed(1)}%`);
}

console.log("");
if (failures > 0) {
  console.error(`SIM2 FAILED: ${failures} 项断言失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`SIM2 OK: ${passed} 项断言全部通过`);
