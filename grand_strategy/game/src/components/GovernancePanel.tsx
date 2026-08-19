/**
 * v0.5/v0.7 左侧治理面板：国家治理元素从右侧 NationPanel 移到左侧边栏。
 * 分区（可折叠手风琴）：经济 / 稳定度 / 市场 / 税收 / 阶级 / 人口 / 政策 / 投资 / 大事记。
 * v0.7：五个分区内嵌 ECharts 迷你图表（经济/人口/市场/税收/稳定度，近 12 月历史快照）。
 * 右侧区域让位给 地图 + 选中省份详情（ProvincePanel）。
 */
import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { Coins, LineChart, BadgePercent, Users2, Users, ScrollText, Factory, Newspaper, HeartPulse } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import MiniChart, { themedBase } from './MiniChart';
import type { GameMap, Province } from '../game/map';
import type { GameState } from '../game/state';
import type { HistoryMonth } from '../game/state';
import type { ClassId, GoodId } from '../game/types';
import { NATIONS } from '../game/nations';
import {
  nationMonthlyIncome,
  nationMonthlySpending,
  nationMonthlyGrain,
  nationClassMixOf,
  nationClassPower,
  nationClassTaxBurden,
  taxTransmissionHints,
} from '../game/economy';
import { GOODS, GOOD_LABEL, JOB_LABEL, JOBS, RACE_LABEL } from '../game/pops';
import { CLASSES, CLASS_DEFS } from '../game/classes';
import { TAX_KINDS, TAX_LABEL, TAX_DESC, TAX_MAX, taxPenalty, weightedTaxRate } from '../game/tax';
import type { TaxKind } from '../game/tax';
import { GOOD_CATEGORY } from '../game/market';
import { nextJobThreshold } from '../game/labor';
import { BUILDING_DEFS, BUILDING_KINDS, buildingSkillReqPop, projectProgress, buildingUnlock } from '../game/buildings';
import type { BuildingKind } from '../game/buildings';
import { monthLabel } from '../game/clock';
import { isCoastal } from '../game/logistics';

interface Props {
  game: GameState;
  map: GameMap;
  onTaxRate: (kind: TaxKind, value: number) => void;
  onGoodsTax: (good: GoodId, value: number) => void;
  onSpending: (kind: 'military' | 'admin' | 'infra' | 'court' | 'health', value: number) => void;
  onRetrain: (provId: number, popIndex: number) => void;
  onInvest: (kind: BuildingKind, provId: number) => void;
  onCancelInvest: (projectId: number) => void;
  /** v0.9 双轨制：国有化私营建筑（有偿补偿） */
  onNationalize: (projectId: number) => void;
  onTogglePolicy: (policy: 'progressiveTax' | 'universalSuffrage', on: boolean) => void;
  onAbolish: () => void;
  /** v0.8 开放贸易（国家开关） */
  onToggleTrade: (on: boolean) => void;
  /** v0.8 出口权（省授予/收回） */
  onExportRight: (provId: number, on: boolean) => void;
}

type Section = 'economy' | 'stability' | 'market' | 'tax' | 'class' | 'pop' | 'policy' | 'invest' | 'log';
type MktLevel = 'nation' | 'province' | 'county';

/** 阶级饼图配色（与 ClassTab 一致） */
const CLASS_COLORS: Record<ClassId, string> = {
  1: '#b5472f', 2: '#c8aa3c', 3: '#2f7d45', 4: '#466ec8', 5: '#7d8a96', 6: '#5a6470', 7: '#2b2b28',
};

/** 历史月份标签（短：年份后两位-月序） */
function monthTick(h: HistoryMonth): string {
  return `${h.year.toString().slice(2)}-${(h.month % 12) + 1}`;
}

/** 迷你图表通用基底（主题色 + 微缩刻度） */
function baseChart(theme: ReturnType<typeof themedBase>): {
  grid: object;
  tooltip: object;
  textStyle: { color: string; fontSize: number };
} {
  return {
    grid: { left: 2, right: 6, top: 10, bottom: 2, containLabel: true },
    tooltip: { confine: true, textStyle: { fontSize: 10 } },
    textStyle: { color: theme.text, fontSize: 10 },
  };
}

const SPEND_LABEL: Record<'military' | 'admin' | 'infra' | 'court' | 'health', string> = {
  military: '军费',
  admin: '行政',
  infra: '基建',
  court: '宫廷',
  health: '卫生',
};

const CATEGORY_LABEL: Record<string, string> = {
  agriculture: '农业',
  extraction: '采掘',
  processing: '加工',
  heavy: '重工',
  fine: '精工',
};

const GOOD_CAT_LABEL: Record<string, string> = {
  resource: '资源',
  semi: '半成品',
  finished: '成品',
};

// ---- v0.7 侧栏图表 option 构建（数据源：state.history 近 12 月快照；主题色走 CSS 变量） ----

/** 经济：国库（左轴）/ 月收支（右轴）折线 */
function ecoChartOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  return {
    ...base,
    grid: { ...(base.grid as object), top: 14 },
    tooltip: { ...(base.tooltip as object), trigger: 'axis' },
    legend: { top: 0, left: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 9, color: theme.dim } },
    xAxis: {
      type: 'category',
      data: history.map(monthTick),
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { fontSize: 8, color: theme.dim, interval: 2 },
    },
    yAxis: [
      { type: 'value', scale: true, splitLine: { lineStyle: { color: theme.line, opacity: 0.5 } }, axisLabel: { fontSize: 8, color: theme.dim } },
      { type: 'value', scale: true, splitLine: { show: false }, axisLabel: { fontSize: 8, color: theme.dim } },
    ],
    series: [
      { name: '国库', type: 'line', data: history.map((h) => Math.round(h.treasury)), smooth: true, showSymbol: false, lineStyle: { width: 1.4, color: theme.accent }, itemStyle: { color: theme.accent } },
      { name: '月收入', type: 'line', yAxisIndex: 1, data: history.map((h) => Math.round(h.income)), showSymbol: false, lineStyle: { width: 1, color: '#466ec8' }, itemStyle: { color: '#466ec8' } },
      { name: '月支出', type: 'line', yAxisIndex: 1, data: history.map((h) => Math.round(h.spending)), showSymbol: false, lineStyle: { width: 1, color: '#b5472f' }, itemStyle: { color: '#b5472f' } },
    ],
  };
}

/** 人口：人口曲线（近 12 月） */
function popChartOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  return {
    ...base,
    tooltip: { ...(base.tooltip as object), trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: history.map(monthTick),
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { fontSize: 8, color: theme.dim, interval: 2 },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: theme.line, opacity: 0.5 } },
      axisLabel: { fontSize: 8, color: theme.dim },
    },
    series: [
      { name: '人口', type: 'line', data: history.map((h) => Math.round(h.popWan)), smooth: true, showSymbol: false, areaStyle: { opacity: 0.12, color: theme.accent }, lineStyle: { width: 1.4, color: theme.accent }, itemStyle: { color: theme.accent } },
    ],
  };
}

/** 人口：阶级分布饼图（最新快照） */
function classPieOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  const latest = history[history.length - 1];
  const data = latest
    ? CLASSES.map((c, i) => ({ name: CLASS_DEFS[c].label, value: Math.max(0, latest.classMix[i] ?? 0), itemStyle: { color: CLASS_COLORS[c] } })).filter((d) => d.value > 0.01)
    : [];
  return {
    ...base,
    tooltip: { ...(base.tooltip as object), trigger: 'item', formatter: '{b}: {c}万 ({d}%)' },
    series: [
      {
        type: 'pie',
        radius: ['42%', '72%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data,
      },
    ],
  };
}

/** 市场：主要商品（6 种）价格走势多线 */
function marketChartOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  const goods = ['food', 'coal', 'iron', 'steel', 'tools', 'luxury'] as const;
  const palette = ['#2f7d45', '#466ec8', '#b98a2e', '#b5472f', '#8c5ab4', '#3c8c8c'];
  return {
    ...base,
    tooltip: { ...(base.tooltip as object), trigger: 'axis' },
    legend: { top: 0, left: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 8, color: theme.dim } },
    xAxis: {
      type: 'category',
      data: history.map(monthTick),
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { fontSize: 8, color: theme.dim, interval: 2 },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: theme.line, opacity: 0.5 } },
      axisLabel: { fontSize: 8, color: theme.dim },
    },
    series: goods.map((g, i) => ({
      name: GOOD_LABEL[g],
      type: 'line' as const,
      data: history.map((h) => h.prices?.[g] ?? 0),
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 1, color: palette[i] },
      itemStyle: { color: palette[i] },
    })),
  };
}

/** 税收：各税种实收堆叠柱状图（近 12 月） */
function taxChartOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  const kinds = [
    { key: 'land', label: TAX_LABEL.land, color: '#2f7d45' },
    { key: 'poll', label: TAX_LABEL.poll, color: '#466ec8' },
    { key: 'consumption', label: TAX_LABEL.consumption, color: '#b98a2e' },
    { key: 'tariff', label: TAX_LABEL.tariff, color: '#8c5ab4' },
    { key: 'other', label: TAX_LABEL.other, color: '#3c8c8c' },
    { key: 'goods', label: '商品税', color: '#b5472f' },
  ] as const;
  return {
    ...base,
    tooltip: { ...(base.tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, left: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 8, color: theme.dim } },
    xAxis: {
      type: 'category',
      data: history.map(monthTick),
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { fontSize: 8, color: theme.dim, interval: 2 },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: theme.line, opacity: 0.5 } },
      axisLabel: { fontSize: 8, color: theme.dim },
    },
    series: kinds.map((k) => ({
      name: k.label,
      type: 'bar' as const,
      stack: 'tax',
      barMaxWidth: 8,
      data: history.map((h) => Number(((h.tax as Record<string, number>)[k.key] ?? 0).toFixed(1))),
      itemStyle: { color: k.color },
    })),
  };
}

/** 稳定度：幸福度 / 稳定度 双线（0-100） */
function stabilityChartOption(history: HistoryMonth[], theme: ReturnType<typeof themedBase>): EChartsOption {
  const base = baseChart(theme);
  return {
    ...base,
    tooltip: { ...(base.tooltip as object), trigger: 'axis' },
    legend: { top: 0, left: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 9, color: theme.dim } },
    xAxis: {
      type: 'category',
      data: history.map(monthTick),
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { fontSize: 8, color: theme.dim, interval: 2 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      splitLine: { lineStyle: { color: theme.line, opacity: 0.5 } },
      axisLabel: { fontSize: 8, color: theme.dim },
    },
    series: [
      { name: '稳定度', type: 'line', data: history.map((h) => Math.round(h.stability * 10) / 10), smooth: true, showSymbol: false, lineStyle: { width: 1.4, color: theme.accent }, itemStyle: { color: theme.accent } },
      { name: '幸福度', type: 'line', data: history.map((h) => Math.round(h.happiness * 10) / 10), smooth: true, showSymbol: false, lineStyle: { width: 1.4, color: '#466ec8' }, itemStyle: { color: '#466ec8' } },
    ],
  };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

function trendArrow(t: number): string {
  if (t > 0.005) return '↑';
  if (t < -0.005) return '↓';
  return '→';
}

/** 建筑输入/输出链显示：「铁矿×2 + 煤×1 → 铁锭×2」 */
function chainLabel(kind: BuildingKind): string {
  const d = BUILDING_DEFS[kind];
  const inputs = Object.entries(d.inputs)
    .map(([g, v]) => `${GOOD_LABEL[g as GoodId]}×${v}`)
    .join(' + ');
  const anyOf = (d.anyOf ?? []).map((g) => GOOD_LABEL[g]).join('、');
  const out = d.output ? `${GOOD_LABEL[d.output]}×${d.capacity}` : '公共服务加成';
  const opt = Object.entries(d.opt ?? {})
    .map(([g, v]) => `${GOOD_LABEL[g as GoodId]}×${v}`)
    .join(' / ');
  return `${inputs || anyOf || '—'}${opt ? `（/${opt}）` : ''} → ${out}`;
}

/** 三级市场明细（国/省/县；17 商品，宽表横向滚动） */
function MarketTable({ game, map, ownedProvs, focusProvId }: {
  game: GameState;
  map: GameMap;
  ownedProvs: Province[];
  focusProvId: number | null;
}) {
  const n = game.nations[game.playerNation];
  const [level, setLevel] = useState<MktLevel>('nation');
  const [provPick, setProvPick] = useState<number | null>(focusProvId);
  const provForCounties = provPick ?? focusProvId ?? ownedProvs[0]?.id ?? null;
  const prov = provForCounties !== null ? map.provinceById.get(provForCounties) ?? null : null;

  return (
    <div className="mkt-panel">
      <div className="mkt-levels">
        {(['nation', 'province', 'county'] as MktLevel[]).map((l) => (
          <button key={l} className={`mkt-btn ${level === l ? 'active' : ''}`} onClick={() => setLevel(l)}>
            {l === 'nation' ? '国家' : l === 'province' ? '省' : '县'}
          </button>
        ))}
      </div>

      {level === 'nation' && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>商品</th><th>供需比</th><th>价格</th><th>趋势</th><th>库存</th>
            </tr>
          </thead>
          <tbody>
            {GOODS.map((g: GoodId) => {
              const m = n.market[g];
              const ratio = m.supply > 0 ? m.demand / m.supply : Infinity;
              return (
                <tr key={g}>
                  <td>{GOOD_LABEL[g]}</td>
                  <td>{Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}</td>
                  <td>{m.price.toFixed(2)}</td>
                  <td className={m.trend > 0.005 ? 'neg' : m.trend < -0.005 ? 'pos' : ''}>{trendArrow(m.trend)}</td>
                  <td>{n.stocks[g].toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {level === 'province' && (
        <div className="mkt-scroll">
          <table className="mini-table mkt-matrix">
            <thead>
              <tr>
                <th>行省</th>
                {GOODS.map((g) => <th key={g}>{GOOD_LABEL[g]}</th>)}
              </tr>
            </thead>
            <tbody>
              {ownedProvs.map((p) => {
                const pm = n.provinceMarkets[p.id];
                return (
                  <tr key={p.id}>
                    <td className="dim">#{p.id + 1}</td>
                    {GOODS.map((g) => {
                      const m = pm?.[g];
                      if (!m) return <td key={g}>—</td>;
                      const ratio = m.supply > 0 ? m.demand / m.supply : Infinity;
                      return (
                        <td key={g} title={`供需比 ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'} · 净流 ${m.netFlow.toFixed(2)}`}>
                          {m.price.toFixed(2)}
                          <em className="mkt-trend">{trendArrow(m.trend)}</em>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {level === 'county' && (
        <div>
          <div className="mkt-pick">
            <label>县所属省：</label>
            <select value={provForCounties ?? ''} onChange={(e) => setProvPick(Number(e.target.value))}>
              {ownedProvs.map((p) => (
                <option key={p.id} value={p.id}>行省 #{p.id + 1}</option>
              ))}
            </select>
          </div>
          {prov ? (
            <div className="mkt-scroll">
              <table className="mini-table mkt-matrix">
                <thead>
                  <tr>
                    <th>县</th>
                    {GOODS.map((g) => <th key={g}>{GOOD_LABEL[g]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {prov.counties.map((c) => {
                    const cm = n.countyMarkets[c.id];
                    return (
                      <tr key={c.id}>
                        <td className="dim">#{c.id + 1}</td>
                        {GOODS.map((g) => {
                          const m = cm?.[g];
                          if (!m) return <td key={g}>—</td>;
                          const ratio = m.supply > 0 ? m.demand / m.supply : Infinity;
                          return (
                            <td key={g} title={`供需比 ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'} · 净流 ${m.netFlow.toFixed(2)} · 消费 ${m.consumed.toFixed(2)}`}>
                              {m.price.toFixed(2)}
                              <em className="mkt-trend">{trendArrow(m.trend)}</em>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="dim">无辖区</p>
          )}
        </div>
      )}
    </div>
  );
}

/** 投资页：产业链建筑清单（解锁条件/输入输出/技能要求） */
function InvestTab({ game, map, ownedProvs, onInvest, onCancelInvest, onNationalize }: {
  game: GameState;
  map: GameMap;
  ownedProvs: Province[];
  onInvest: Props['onInvest'];
  onCancelInvest: Props['onCancelInvest'];
  onNationalize: Props['onNationalize'];
}) {
  const n = game.nations[game.playerNation];
  const [pick, setPick] = useState<Record<BuildingKind, number>>(
    Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0])) as Record<BuildingKind, number>,
  );
  const building = n.projects.filter((p) => p.status === 'building');
  const active = n.projects.filter((p) => p.status === 'active');
  const nationView = { stocks: n.stocks, projects: n.projects, literacy: n.literacy };
  const pickProv = (kind: BuildingKind): Province | null => {
    const provs = ownedProvs.filter((p) => buildingUnlock(map, kind, p, n.infra, nationView).ok);
    const idx = Math.min(pick[kind], Math.max(0, provs.length - 1));
    return provs[idx] ?? null;
  };

  return (
    <div className="tab-body">
      <section className="p-sec">
        <h4>建筑投资现金流（上月）</h4>
        <table className="mini-table">
          <tbody>
            <tr><td>国库</td><td>{fmt(n.treasury)} 万₭</td></tr>
            <tr><td>建筑回报（产出−输入−运营）</td><td className={n.monthly.investReturn >= 0 ? 'pos' : 'neg'}>{n.monthly.investReturn >= 0 ? '+' : ''}{n.monthly.investReturn.toFixed(1)}</td></tr>
            <tr><td>投资支出</td><td className="neg">{n.monthly.investCost > 0 ? `-${n.monthly.investCost.toFixed(1)}` : '—'}</td></tr>
            <tr><td>取消退款</td><td className="pos">{n.monthly.investRefund > 0 ? `+${n.monthly.investRefund.toFixed(1)}` : '—'}</td></tr>
            <tr><td>上层投资收入（POP）</td><td>+{n.monthly.investIncome.toFixed(1)}</td></tr>
          </tbody>
        </table>
        <p className="dim">回报 = 产出×市价 − 输入×市价 − 运营成本；缺技能 POP 或库存不足会打折减产。</p>
      </section>

      {building.length > 0 && (
        <section className="p-sec">
          <h4>在建项目（{building.length}）</h4>
          {building.map((p) => {
            const d = BUILDING_DEFS[p.kind];
            const prog = projectProgress(p);
            const refund = p.totalCost * (1 - prog);
            return (
              <div className="invest-card" key={p.id}>
                <div className="invest-card-head">
                  <b>{d.label}</b>
                  <span className="dim">行省 #{p.provId + 1}</span>
                  <span className="dim">剩余 {p.monthsLeft} 月</span>
                </div>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(prog * 100).toFixed(0)}%` }} /></div>
                <div className="invest-card-foot">
                  <span className="dim">进度 {(prog * 100).toFixed(0)}% · 可退 {refund.toFixed(0)} 万₭</span>
                  <button className="retrain-btn" onClick={() => onCancelInvest(p.id)}>取消（退款）</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {active.length > 0 && (
        <section className="p-sec">
          <h4>
            已投产建筑（{active.length}） · 资本池 {n.capitalWealth.toFixed(0)} 万₭
          </h4>
          <table className="mini-table">
            <thead>
              <tr><th>项目</th><th>位置</th><th>技能/运行</th><th>上月产出</th><th>上月回报</th><th>所有制</th></tr>
            </thead>
            <tbody>
              {active.map((p) => {
                const d = BUILDING_DEFS[p.kind];
                const ret = p.lastRevenue - p.lastInputCost - d.opCost;
                return (
                  <tr key={p.id}>
                    <td>{d.label}</td>
                    <td>#{p.provId + 1}</td>
                    <td title={`技能满足 ${(p.lastSkillFactor * 100).toFixed(0)}% · 输入可用 ${(p.lastRunFactor * 100).toFixed(0)}%`}>
                      {JOB_LABEL[d.skill]} {(p.lastSkillFactor * p.lastRunFactor * 100).toFixed(0)}%
                    </td>
                    <td>{p.lastOutput.toFixed(2)} {d.output ? GOOD_LABEL[d.output] : '—'}</td>
                    <td className={ret >= 0 ? 'pos' : 'neg'}>{ret >= 0 ? '+' : ''}{ret.toFixed(1)}</td>
                    <td>
                      {p.owner === 'private' ? (
                        <>
                          <span className="dim">私营</span>{' '}
                          <button className="btn btn-mini" onClick={() => onNationalize(p.id)}>国有化</button>
                        </>
                      ) : (
                        <span className="dim">国营</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dim">技能满足 = 省内{JOBS.map((j) => JOB_LABEL[j]).join('/')} POP 充足度；输入可用 = 国家库存充足度。私营利润归资本池，连续 3 月亏损破产；国有化按市值 70% 有偿补偿。</p>
        </section>
      )}

      <section className="p-sec">
        <h4>新建筑（国库投入 · 按省份选址 · 技能/资源/基建解锁）</h4>
        {BUILDING_KINDS.map((kind) => {
          const d = BUILDING_DEFS[kind];
          const provs = ownedProvs.filter((p) => buildingUnlock(map, kind, p, n.infra, nationView).ok);
          const sel = pickProv(kind);
          const affordable = sel !== null && n.treasury >= d.cost;
          const inputCost = Object.entries(d.inputs).reduce((s, [g, v]) => s + v * n.market[g as GoodId].price, 0);
          const expRet = (d.output ? d.capacity * n.market[d.output].price : 0) - inputCost - d.opCost;
          return (
            <div className="invest-card" key={kind}>
              <div className="invest-card-head">
                <b>{d.label}</b>
                <span className="dim">{CATEGORY_LABEL[d.category]} · 需{JOB_LABEL[d.skill]} {buildingSkillReqPop(d).toFixed(1)}万</span>
                <span className={expRet >= 0 ? 'pos' : 'neg'}>预期 {expRet >= 0 ? '+' : ''}{expRet.toFixed(1)}/月</span>
              </div>
              <p className="dim">{d.desc}</p>
              <div className="invest-meta">
                <span>链：{chainLabel(kind)}</span>
                <span>成本 {d.cost} 万₭</span>
                <span>工期 {d.duration} 月</span>
                <span>运营 {d.opCost.toFixed(1)}/月</span>
              </div>
              <div className="invest-card-foot">
                <select
                  value={sel ? sel.id : ''}
                  onChange={(e) => setPick((prev) => ({ ...prev, [kind]: Math.max(0, provs.findIndex((p) => p.id === Number(e.target.value)))}))}
                  disabled={provs.length === 0}
                >
                  {provs.length === 0 ? (
                    <option value="">无可建省份</option>
                  ) : (
                    provs.map((p) => (
                      <option key={p.id} value={p.id}>行省 #{p.id + 1}（{p.counties.length} 县）</option>
                    ))
                  )}
                </select>
                <button
                  className="retrain-btn"
                  disabled={!affordable}
                  onClick={() => sel && onInvest(kind, sel.id)}
                  title={!affordable ? (sel ? `国库不足（需 ${d.cost} 万₭）` : '无符合解锁条件的省份') : '投入建设'}
                >
                  投入
                </button>
              </div>
              {provs.length === 0 && <p className="dim warn-soft">未解锁：{unlockReasons(kind, n.infra)}</p>}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function unlockReasons(kind: BuildingKind, infra: { roads: number; ports: number }): string {
  const reasons: string[] = [];
  const d = BUILDING_DEFS[kind];
  if (infra.roads < (d.infra.roads ?? 0)) reasons.push(`道路≥${d.infra.roads}`);
  if (infra.ports < (d.infra.ports ?? 0)) reasons.push(`港口≥${d.infra.ports}`);
  if (d.requireCoastal) reasons.push('沿海省份');
  if (d.requireResource) reasons.push(`省资源「${d.requireResource}」`);
  if (d.requireGood) reasons.push(`本国已产「${d.requireGood}」`);
  if (d.requireLiteracy !== undefined) reasons.push(`识字率≥${(d.requireLiteracy * 100).toFixed(0)}%`);
  if (kind === 'ironWorks') reasons.push('煤矿省或港口≥15');
  return reasons.join('；') || '选址受限';
}

/** 阶级页：七级分布 + 权势构成 + 阶级流动提示（政策移至「政策」分区） */
function ClassTab({ game, map }: { game: GameState; map: GameMap }) {
  const id = game.playerNation;
  const n = game.nations[id];
  const mix = nationClassMixOf(map, game, id);
  const power = nationClassPower(map, game, id);
  const total = CLASSES.reduce((s, c) => s + mix[c], 0);
  const powerTotal = CLASSES.reduce((s, c) => s + power[c], 0);
  const shares = CLASSES.map((c) => (total > 1e-9 ? (mix[c] / total) * 100 : 0));
  const powerShares = CLASSES.map((c) => (powerTotal > 1e-9 ? (power[c] / powerTotal) * 100 : 0));
  const upperShare = powerShares[0] + powerShares[1];
  const middleShare = powerShares[2] + powerShares[3];
  const lowerShare = powerShares[4] + powerShares[5];
  const slaveShare = shares[6];

  let headline = '各阶层大致均衡';
  if (upperShare >= 40) headline = '贵族·财阀权倾朝野';
  else if (upperShare >= 25) headline = '旧贵族势力强盛';
  else if (lowerShare >= 55) headline = '市民与工人崛起';
  else if (middleShare >= 45) headline = '官僚技术阶层掌舵';
  if (slaveShare >= 20) headline = '农奴制阴影笼罩';

  const colors: Record<ClassId, string> = {
    1: '#b5472f', 2: '#c8aa3c', 3: '#2f7d45', 4: '#466ec8', 5: '#7d8a96', 6: '#5a6470', 7: '#2b2b28',
  };

  return (
    <div className="tab-body">
      <section className="p-sec">
        <h4>阶级构成（{fmt(total)} 万 · {headline}）</h4>
        {CLASSES.map((c, i) => (
          <div key={c} className="bar-row">
            <span className="bar-label" style={{ width: 70 }}>{CLASS_DEFS[c].label}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.max(0.4, shares[i])}%`, background: colors[c] }} />
            </div>
            <span className="bar-value">{shares[i].toFixed(1)}%</span>
          </div>
        ))}
        <p className="dim">{CLASSES.map((c) => `${CLASS_DEFS[c].label} ${fmt(mix[c])}万`).join(' · ')}</p>
        <p className="dim">奴隶 {fmt(mix[7])} 万{slaveShare >= 1 && <span className="neg">（农奴制）</span>} · 动乱指数 {n.unrest.toFixed(2)}</p>
      </section>

      <section className="p-sec">
        <h4>权势构成（政治影响力 = 阶级规模 × 权重{ n.policies.universalSuffrage ? ' · 普选修正' : ''}）</h4>
        {CLASSES.map((c, i) => (
          <div key={c} className="bar-row">
            <span className="bar-label" style={{ width: 70 }}>{CLASS_DEFS[c].label}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.max(0.4, powerShares[i])}%`, background: colors[c] }} />
            </div>
            <span className="bar-value">{powerShares[i].toFixed(1)}%</span>
          </div>
        ))}
        <p className="dim">贵族/财阀 {upperShare.toFixed(0)}% · 技术官僚 {middleShare.toFixed(0)}% · 平民 {lowerShare.toFixed(0)}%</p>
      </section>

      <section className="p-sec">
        <h4>阶级流动（识字率 + 财富驱动 · 确定性）</h4>
        <ul className="log-list">
          <li><span className="log-title">佃农/无业 → 自耕农/工人</span><span className="log-choice">识字 + 就业</span></li>
          <li><span className="log-title">自耕农 → 富农 → 地主</span><span className="log-choice">识字 ≥15%/40% + 财富</span></li>
          <li><span className="log-title">工匠 → 技术阶层 → 资本家 → 大贵族</span><span className="log-choice">识字 ≥40%/50%/60%</span></li>
          <li><span className="log-title">工资低迷 → 向下跌落</span><span className="log-choice">至多到无业游民</span></li>
          <li><span className="log-title">奴隶不流动</span><span className="log-choice">除非「废农奴制」</span></li>
        </ul>
        <p className="dim">识字率 {(n.literacy * 100).toFixed(1)}% · 月流动上限 1%· 教育支出提升识字率 → 上层流动加速</p>
      </section>
    </div>
  );
}

/** 税收页（v0.4 立体税制）：六税种滑块 + 全部商品税列表 + 实收 + 阶级负担 + 传导提示 */
function TaxTab({ game, map, onTaxRate, onGoodsTax }: {
  game: GameState;
  map: GameMap;
  onTaxRate: Props['onTaxRate'];
  onGoodsTax: Props['onGoodsTax'];
}) {
  const id = game.playerNation;
  const n = game.nations[id];
  const tax = n.tax;
  const ledger = n.monthly;
  const [filter, setFilter] = useState<'all' | 'resource' | 'semi' | 'finished'>('all');
  const burden = nationClassTaxBurden(map, game, id);
  const hints = taxTransmissionHints(game);
  const total = ledger.pollTax + ledger.landTax + ledger.consumptionTax + ledger.tariff + ledger.otherTax + ledger.goodsTax;
  // v0.7 税收柱状图（近 12 月堆叠）
  const taxTheme = themedBase();
  const taxOption = useMemo(() => taxChartOption(game.history[id] ?? [], taxTheme), [game.history, id, taxTheme]);

  return (
    <div className="tab-body">
      <section className="p-sec">
        <h4>各税种实收（近 12 月 · 万₭/月）</h4>
        <MiniChart option={taxOption} height={100} />
        {game.history[id]?.length ? (
          <p className="dim">近 {game.history[id]?.length} 月 · 随月度结算更新</p>
        ) : (
          <p className="dim">尚无历史数据——推进一个月后开始记录。</p>
        )}
      </section>
      <section className="p-sec">
        <h4>税制概览</h4>
        <table className="mini-table">
          <tbody>
            <tr><td>综合税负</td><td>{(weightedTaxRate(tax) * 100).toFixed(1)}%（0-30% 连续滑块）</td></tr>
            <tr><td>稳定度惩罚</td><td className="neg">-{taxPenalty(tax).toFixed(1)}</td></tr>
            <tr><td>上月税收合计</td><td className="pos">+{total.toFixed(1)} 万₭/月</td></tr>
          </tbody>
        </table>
        <p className="dim">六税种 = 五类直接税（土地/人头/消费/关税/特别）+ 单一商品税（全部 17 商品可选，可多选叠加）。</p>
      </section>

      <section className="p-sec">
        <h4>五类直接税（阶级负担矩阵 · 连续滑块 0%-30%）</h4>
        {TAX_KINDS.map((k) => (
          <label key={k} className="slider-row">
            <span className="slider-label" title={TAX_DESC[k]}>{TAX_LABEL[k]}</span>
            <input
              type="range"
              min={0}
              max={TAX_MAX}
              step={0.005}
              value={tax.rates[k]}
              onChange={(e) => onTaxRate(k, Number(e.target.value))}
            />
            <span className="slider-value">{(tax.rates[k] * 100).toFixed(0)}%</span>
          </label>
        ))}
        <p className="dim">
          {TAX_KINDS.map((k) => `${TAX_LABEL[k]}：${TAX_DESC[k]}`).join('；')}
        </p>
        {n.policies.progressiveTax && <p className="dim pos">累进税生效：土地/人头/消费税上层↑下层↓</p>}
      </section>

      <section className="p-sec">
        <h4>单一商品税（全部商品可选 · 买方支付 市价×(1+税率)）</h4>
        <div className="mkt-pick">
          <label>筛选：</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">全部</option>
            <option value="resource">资源</option>
            <option value="semi">半成品</option>
            <option value="finished">成品</option>
          </select>
        </div>
        {GOODS.filter((g) => filter === 'all' || GOOD_CATEGORY[g] === filter).map((g) => (
          <label key={g} className="slider-row">
            <span className="slider-label" title={`${GOOD_CAT_LABEL[GOOD_CATEGORY[g]]} · 市价 ${n.market[g].price.toFixed(2)} → 有效价 ${n.market[g].effPrice.toFixed(2)}`}>
              {GOOD_LABEL[g]}
            </span>
            <input
              type="range"
              min={0}
              max={TAX_MAX}
              step={0.005}
              value={tax.goods[g]}
              onChange={(e) => onGoodsTax(g, Number(e.target.value))}
            />
            <span className="slider-value">{(tax.goods[g] * 100).toFixed(0)}%</span>
          </label>
        ))}
        <p className="dim">有效价 = 市价 × (1+税率)；收入 = 税率 × 成交量（国内消费+进口+建筑消耗）进国库；输入品征税 → 下游成本↑ → 成品价↑。</p>
      </section>

      <section className="p-sec">
        <h4>各税种实收（上月 · 万₭/月）</h4>
        <table className="mini-table">
          <tbody>
            <tr><td>土地税（持地者）</td><td>+{ledger.landTax.toFixed(1)}</td></tr>
            <tr><td>人头税（自由民）</td><td>+{ledger.pollTax.toFixed(1)}</td></tr>
            <tr><td>消费税（消费者）</td><td>+{ledger.consumptionTax.toFixed(1)}</td></tr>
            <tr><td>关税（贸易者）</td><td>+{ledger.tariff.toFixed(1)}</td></tr>
            <tr><td>特别税（运力/港口/印花）</td><td>+{ledger.otherTax.toFixed(1)}</td></tr>
            <tr><td>单一商品税</td><td>+{ledger.goodsTax.toFixed(1)}</td></tr>
            <tr className="sum"><td>税收合计</td><td>+{total.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="p-sec">
        <h4>阶级负担明细（谁在交多少 · 上月）</h4>
        <div className="mkt-scroll">
          <table className="mini-table burden-table">
            <thead>
              <tr>
                <th>阶级</th>
                <th>土地</th><th>人头</th><th>消费</th><th>关税</th><th>特别</th><th>商品税</th><th>合计</th>
              </tr>
            </thead>
            <tbody>
              {CLASSES.map((c) => {
                const r = burden[c];
                const rowTotal = r.land + r.poll + r.consumption + r.tariff + r.other + r.goods;
                return (
                  <tr key={c}>
                    <td>{CLASS_DEFS[c].label}</td>
                    <td>{r.land.toFixed(1)}</td>
                    <td>{r.poll.toFixed(1)}</td>
                    <td>{r.consumption.toFixed(1)}</td>
                    <td>{r.tariff.toFixed(1)}</td>
                    <td>{r.other.toFixed(1)}</td>
                    <td>{r.goods.toFixed(1)}</td>
                    <td className={rowTotal > 0 ? '' : 'dim'}>{rowTotal.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="dim">土地税压在持地者（地主/大贵族/富农/自耕农）；人头/消费税打在下层（奴隶免征）；关税/特别税由商人/资本家承担。</p>
      </section>

      <section className="p-sec">
        <h4>产业链传导提示（输入品税 → 下游成本）</h4>
        {hints.length === 0 ? (
          <p className="dim">尚未对商品征税。试试对「煤炭」或「铁矿」征收商品税，看下游炼铁/炼钢/工具/武器成本如何上升。</p>
        ) : (
          <ul className="log-list">
            {hints.map((h, i) => (
              <li key={i}>
                <span className="log-title">{GOOD_LABEL[h.from]}税 {((tax.goods[h.from]) * 100).toFixed(0)}%</span>
                <span className="log-choice">→ {GOOD_LABEL[h.to]}成本 +{h.pct.toFixed(0)}%{h.depth > 1 ? `（第${h.depth}级）` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 手风琴分区头部（v0.6：各分区配 Lucide 图标；v0.7 data-sfx=panel → 面板开合「哗啦」音效） */
function SectionHead({ title, icon: Icon, open, onToggle }: { title: string; icon: ComponentType<{ size?: number | string; className?: string }>; open: boolean; onToggle: () => void }) {
  return (
    <button className={`gov-sec-head ${open ? 'active' : ''}`} onClick={onToggle} data-sfx="panel">
      <span className="gov-sec-title">
        <Icon size={14} className="gov-sec-icon" />
        {title}
      </span>
      <span className="gov-caret">{open ? '▾' : '▸'}</span>
    </button>
  );
}

export default function GovernancePanel({ game, map, onTaxRate, onGoodsTax, onSpending, onRetrain, onInvest, onCancelInvest, onNationalize, onTogglePolicy, onAbolish, onToggleTrade, onExportRight, collapsed, onToggleCollapse }: Props & { collapsed: boolean; onToggleCollapse: () => void }) {
  const [open, setOpen] = useState<Record<Section, boolean>>({
    economy: true, stability: false, market: true, tax: false, class: false, pop: true, policy: false, invest: false, log: false,
  });
  const n = game.nations[game.playerNation];
  const def = NATIONS[game.playerNation];
  const incomeM = nationMonthlyIncome(map, game, game.playerNation);
  const spendM = nationMonthlySpending(game, game.playerNation);
  const grainM = nationMonthlyGrain(map, game, game.playerNation);
  const ledger = n.monthly;

  const ownedProvs = map.provinces.filter((p) => p.owner === game.playerNation && !p.isUndiscovered);
  const focusProv = ownedProvs[0] ?? null;
  const focusPs = focusProv ? game.provinces[focusProv.id] ?? null : null;
  const netInvest = ledger.investReturn - ledger.investCost + ledger.investRefund;
  const toggle = (s: Section) => setOpen((prev) => ({ ...prev, [s]: !prev[s] }));

  // ---- v0.7 侧栏图表（历史快照 → ECharts option；主题色随 CSS 变量） ----
  const history = game.history[game.playerNation] ?? [];
  const theme = themedBase();
  const ecoOption = useMemo(() => ecoChartOption(history, theme), [history, theme]);
  const popOption = useMemo(() => popChartOption(history, theme), [history, theme]);
  const classPie = useMemo(() => classPieOption(history, theme), [history, theme]);
  const marketOption = useMemo(() => marketChartOption(history, theme), [history, theme]);
  const stabilityOption = useMemo(() => stabilityChartOption(history, theme), [history, theme]);
  const historyTip = history.length === 0
    ? <p className="dim">尚无历史数据——推进一个月后开始记录（仅保留近 12 月）。</p>
    : <p className="dim">近 {history.length} 月 · 随月度结算更新（仅保留 12 月）</p>;

  return (
    <aside className={`gov-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="gov-head">
        <b>国家治理</b>
        <span className="dim">{def.name}</span>
        <button className="gov-collapse" onClick={onToggleCollapse} title={collapsed ? '展开治理面板' : '收起治理面板'}>
          {collapsed ? '▸' : '◂'}
        </button>
      </div>
      {!collapsed && (
        <div className="gov-body">
          {/* ---- 经济 ---- */}
          <SectionHead title="经济" icon={Coins} open={open.economy} onToggle={() => toggle('economy')} />
          {open.economy && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <h4>国库 / 月收支（近 12 月 · 万₭）</h4>
                <MiniChart option={ecoOption} height={92} />
                {historyTip}
              </section>
              <section className="p-sec">
                <h4>月度支出（万₭）</h4>
                {(['military', 'admin', 'infra', 'court', 'health'] as const).map((k) => (
                  <label key={k} className="slider-row">
                    <span className="slider-label">{SPEND_LABEL[k]}</span>
                    <input
                      type="range"
                      min={0}
                      max={def.sliderMax}
                      step={5}
                      value={n.spending[k]}
                      onChange={(e) => onSpending(k, Number(e.target.value))}
                    />
                    <span className="slider-value">{n.spending[k]}</span>
                  </label>
                ))}
                <p className="dim">行政提识字率（促阶级流动）· 卫生提健康 · 基建提产能并降运费 · 军费耗武器</p>
              </section>

              <section className="p-sec">
                <h4>财政结算（上月）</h4>
                <table className="mini-table">
                  <tbody>
                    <tr><td>人头税（自由民）</td><td>+{ledger.pollTax.toFixed(1)}</td></tr>
                    <tr><td>土地税（按地主持有）</td><td>+{ledger.landTax.toFixed(1)}</td></tr>
                    <tr><td>消费税（消费者）</td><td>+{ledger.consumptionTax.toFixed(1)}</td></tr>
                    <tr><td>关税</td><td>+{ledger.tariff.toFixed(1)}</td></tr>
                    <tr><td>特别税（运力/港口/印花）</td><td>+{ledger.otherTax.toFixed(1)}</td></tr>
                    <tr><td>单一商品税</td><td>+{ledger.goodsTax.toFixed(1)}</td></tr>
                    <tr><td>建筑回报</td><td className={ledger.investReturn >= 0 ? 'pos' : 'neg'}>{ledger.investReturn >= 0 ? '+' : ''}{ledger.investReturn.toFixed(1)}</td></tr>
                    <tr><td>投资支出 / 退款</td><td className={netInvest >= 0 ? 'pos' : 'neg'}>{netInvest >= 0 ? '+' : ''}{netInvest.toFixed(1)}</td></tr>
                    <tr><td>支出合计</td><td>-{ledger.spending.toFixed(1)}</td></tr>
                    <tr className="sum"><td>月度结余</td><td>{(ledger.income - ledger.spending + netInvest) >= 0 ? '+' : ''}{(ledger.income - ledger.spending + netInvest).toFixed(1)}</td></tr>
                    <tr><td>国库</td><td>{fmt(n.treasury)} 万₭</td></tr>
                    <tr><td>贸易收支</td><td className={ledger.tradeBalance >= 0 ? 'pos' : 'neg'}>{ledger.tradeBalance >= 0 ? '+' : ''}{ledger.tradeBalance.toFixed(1)} 万₭</td></tr>
                  </tbody>
                </table>
                {n.treasury < 0 && <p className="warn">⚠ 国库为负：连年赤字将触发「国库破产」大事记</p>}
              </section>

              <section className="p-sec">
                <h4>基建（道路 / 港口）</h4>
                <div className="bar-row">
                  <span className="bar-label">道路</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${n.infra.roads}%` }} /></div>
                  <span className="bar-value">{n.infra.roads.toFixed(0)}</span>
                </div>
                <div className="bar-row">
                  <span className="bar-label">港口</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${n.infra.ports}%` }} /></div>
                  <span className="bar-value">{n.infra.ports.toFixed(0)}</span>
                </div>
                <p className="dim">道路/港口达标解锁建筑；港口扩大贸易容量并解锁炼铁厂/船坞</p>
              </section>

              <section className="p-sec">
                <h4>劳动力市场（工资 = 基础 × 供需比）</h4>
                <table className="mini-table">
                  <tbody>
                    {JOBS.map((job) => {
                      const supply = focusPs ? focusPs.pops.filter((p) => p.job === job).reduce((s, p) => s + p.size, 0) : 0;
                      const wage = focusPs?.pops.find((p) => p.job === job)?.wage ?? 0;
                      const { next, literacyReq } = nextJobThreshold(job);
                      return (
                        <tr key={job}>
                          <td>{JOB_LABEL[job]}</td>
                          <td>{supply.toFixed(1)} 万</td>
                          <td>₭{wage.toFixed(1)}</td>
                          <td className="dim">{next ? `→${JOB_LABEL[next]}(识字${(literacyReq * 100).toFixed(0)}%)` : '已到顶'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section className="p-sec">
                <h4>月度结算</h4>
                <table className="mini-table">
                  <tbody>
                    <tr><td>税收收入</td><td>+{fmt(incomeM)} 万₭</td></tr>
                    <tr><td>支出合计</td><td>-{fmt(spendM)} 万₭</td></tr>
                    <tr><td>上层投资收入</td><td>+{ledger.investIncome.toFixed(1)} 万₭</td></tr>
                    <tr><td>粮食月结余</td><td className={grainM >= 0 ? 'pos' : 'neg'}>{grainM >= 0 ? '+' : ''}{grainM.toFixed(1)} 万吨</td></tr>
                    <tr><td>粮食储备</td><td>{fmt(n.foodStock)} 万吨</td></tr>
                  </tbody>
                </table>
                {n.foodStock < 0 && <p className="warn">⚠ 缺粮中：稳定度持续下降</p>}
                {n.stability < 30 && <p className="warn">⚠ 稳定度低于 30：民怨沸腾，危机四伏</p>}
                {n.emigration > 0 && <p className="warn">⚠ 人口外流 {fmt(n.emigration)} 万：住房拥挤或民生恶化</p>}
              </section>
            </div>
          )}

          {/* ---- 稳定度（v0.7 新分区） ---- */}
          <SectionHead title="稳定度" icon={HeartPulse} open={open.stability} onToggle={() => toggle('stability')} />
          {open.stability && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <h4>幸福度 / 稳定度（近 12 月 · 0-100）</h4>
                <MiniChart option={stabilityOption} height={96} />
                {historyTip}
                <p className="dim">
                  稳定度漂移 = 税负惩罚 + 缺粮 + 低幸福 + 下层动乱；当前 {Math.round(n.stability)} · 动乱 {n.unrest.toFixed(2)}。
                  重税稳国库却伤民心——治理即平衡。
                </p>
              </section>
            </div>
          )}

          {/* ---- 市场 ---- */}
          <SectionHead title="市场" icon={LineChart} open={open.market} onToggle={() => toggle('market')} />
          {open.market && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <h4>主要商品价格走势（近 12 月）</h4>
                <MiniChart option={marketOption} height={96} />
                {historyTip}
              </section>
              <section className="p-sec">
                <h4>市场价目（17 商品 · 供需定价 0.4~2.5 倍）</h4>
                <MarketTable game={game} map={map} ownedProvs={ownedProvs} focusProvId={focusProv?.id ?? null} />
                <p className="dim">
                  产/消：{GOODS.map((g) => `${GOOD_LABEL[g]} ${n.market[g].supply.toFixed(1)}/${n.market[g].consumed.toFixed(1)}`).join(' · ')}
                  {n.market.food.unmet > 0.001 && <span className="neg"> · ⚠ 缺粮 {n.market.food.unmet.toFixed(1)}</span>}
                </p>
                <p className="dim">建筑输入参与定价与进口补足；省/县宽表可横向滚动，悬停查看供需比与净流</p>
              </section>
            </div>
          )}

          {/* ---- 税收 ---- */}
          <SectionHead title="税收" icon={BadgePercent} open={open.tax} onToggle={() => toggle('tax')} />
          {open.tax && (
            <TaxTab game={game} map={map} onTaxRate={onTaxRate} onGoodsTax={onGoodsTax} />
          )}

          {/* ---- 阶级 ---- */}
          <SectionHead title="阶级" icon={Users2} open={open.class} onToggle={() => toggle('class')} />
          {open.class && <ClassTab game={game} map={map} />}

          {/* ---- 人口 ---- */}
          <SectionHead title="人口" icon={Users} open={open.pop} onToggle={() => toggle('pop')} />
          {open.pop && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <h4>人口曲线（近 12 月 · 万人）</h4>
                <MiniChart option={popOption} height={88} />
                {historyTip}
              </section>
              <section className="p-sec">
                <h4>阶级分布（最新快照 · 万人）</h4>
                <MiniChart option={classPie} height={92} />
              </section>
              <section className="p-sec">
                <h4>人口概览（v0.5 按容量缩放 · 迁移软化）</h4>
                <table className="mini-table">
                  <tbody>
                    <tr><td>总人口</td><td>{fmt(n.popWan)} 万</td></tr>
                    <tr><td>识字率</td><td>{(n.literacy * 100).toFixed(1)}%</td></tr>
                    <tr><td>健康</td><td>{(n.health * 100).toFixed(0)}%</td></tr>
                    <tr><td>年增长率</td><td className={ledger.growthRate >= 0 ? 'pos' : 'neg'}>{(ledger.growthRate * 100).toFixed(2)}% / 年</td></tr>
                    <tr><td>上月迁出</td><td>{ledger.migrationOut > 0 ? `-${ledger.migrationOut.toFixed(2)} 万` : '—'}</td></tr>
                    <tr><td>上月迁入</td><td>{ledger.migrationIn > 0 ? `+${ledger.migrationIn.toFixed(2)} 万` : '—'}</td></tr>
                    <tr><td>流民（流失他国）</td><td className={n.emigration > 0 ? 'neg' : ''}>{n.emigration > 0 ? `-${fmt(n.emigration)} 万` : '—'}</td></tr>
                  </tbody>
                </table>
                <p className="dim">初始人口 = 全图住房容量×0.75 按国比例缩放（容量不足封顶）；月迁移 ≤ 单省容量 2% + 推拉因子（拥挤度/幸福度）。</p>
              </section>

              {focusProv && focusPs && (
                <section className="p-sec">
                  <h4>
                    POP 明细 · 行省 #{focusProv.id + 1}
                    <span className="dim">（{focusProv.counties.length} 县 · 人口 {fmt(focusPs.popTotal)}/容量 {fmt(focusPs.housingCap)} 万 · 幸福 {focusPs.happiness.toFixed(0)}）</span>
                  </h4>
                  <table className="mini-table pop-table">
                    <tbody>
                      {focusPs.pops.map((pop, i) => {
                        const { next, literacyReq } = nextJobThreshold(pop.job);
                        const canRetrain = n.warTime && next !== null && n.literacy >= literacyReq && pop.size > 0.001;
                        return (
                          <tr key={i}>
                            <td>{RACE_LABEL[pop.race]}{JOB_LABEL[pop.job]}<em className="dim">·{CLASS_DEFS[pop.class].label}</em></td>
                            <td>{pop.size.toFixed(1)}万</td>
                            <td className={pop.happiness >= 60 ? 'pos' : pop.happiness >= 40 ? '' : 'neg'}>{pop.happiness.toFixed(0)}</td>
                            <td>₭{pop.wage.toFixed(1)}{pop.investIncome > 0.01 ? <em className="dim">+投{pop.investIncome.toFixed(1)}</em> : null}</td>
                            <td>
                              {next ? (
                                <button
                                  className={`retrain-btn ${canRetrain ? '' : 'disabled'}`}
                                  disabled={!canRetrain}
                                  onClick={() => onRetrain(focusProv.id, i)}
                                  title={!n.warTime ? '仅战时强制转职（平时靠待遇吸引/自发改行）' : canRetrain ? '转职：3 个月产出减半' : `识字率需 ≥${(literacyReq * 100).toFixed(0)}%`}
                                >
                                  转{next === 'worker' ? '工' : next === 'technician' ? '技' : next === 'clerk' ? '职' : next === 'merchant' ? '商' : next === 'capitalist' ? '资' : '升'}
                                </button>
                              ) : (
                                <span className="dim">顶</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="dim">转职代价：3 个月产出减半。识字率 {(n.literacy * 100).toFixed(1)}%；上层（1-4 级）另获投资收入；奴隶幸福恒低</p>
                </section>
              )}
            </div>
          )}

          {/* ---- 政策 ---- */}
          <SectionHead title="政策" icon={ScrollText} open={open.policy} onToggle={() => toggle('policy')} />
          {open.policy && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <div className="policy-row">
                  <div>
                    <b>废农奴制</b>
                    <p className="dim">一次性：奴隶 → 佃农(60%)/自耕农(40%)；短期稳定度 -15，废除农奴制效率惩罚（长期人口效率↑）</p>
                  </div>
                  <button
                    className={`retrain-btn ${n.policies.abolishedSerfdom || n.slavePop <= 0.01 ? 'disabled' : ''}`}
                    disabled={n.policies.abolishedSerfdom || n.slavePop <= 0.01}
                    onClick={onAbolish}
                    title={n.policies.abolishedSerfdom ? '已废除' : n.slavePop <= 0.01 ? '当前无奴隶' : '解放奴隶'}
                  >
                    {n.policies.abolishedSerfdom ? '已废除 ✓' : '废除'}
                  </button>
                </div>
                <label className="policy-toggle">
                  <input
                    type="checkbox"
                    checked={n.policies.progressiveTax}
                    onChange={(e) => onTogglePolicy('progressiveTax', e.target.checked)}
                  />
                  <span><b>累进税</b>：上层税负 ↑（×1.4/1.3/1.15），下层 ↓（×0.8/0.65）；上层不满、下层受益</span>
                </label>
                <label className="policy-toggle">
                  <input
                    type="checkbox"
                    checked={n.policies.universalSuffrage}
                    onChange={(e) => onTogglePolicy('universalSuffrage', e.target.checked)}
                  />
                  <span><b>普选</b>：下阶层政治权重 ↑，上阶层 ↓；识字率高则稳定度 +3，低则 -4</span>
                </label>
                <p className="dim">政策写入存档；累进税/普选可随时开关，废农奴制仅一次。</p>
              </section>

              <section className="p-sec">
                <h4>对外贸易（v0.8 市场中心 · 省为结算单元）</h4>
                <label className="policy-toggle">
                  <input
                    type="checkbox"
                    checked={n.openTrade}
                    onChange={(e) => onToggleTrade(e.target.checked)}
                  />
                  <span><b>开放贸易</b>：按世界价进出口 + 关税；关闭则完全自给（无任何进出口）</span>
                </label>
                <p className="dim">出口权：仅获权省商品可直通国际市场；沿海/港口省默认获权，内陆省可授予/收回。未获权省商品须运抵口岸出口（运费吨位计税）。</p>
                <div className="mkt-scroll export-right-list">
                  {ownedProvs.map((p) => (
                    <label key={p.id} className="policy-toggle">
                      <input
                        type="checkbox"
                        checked={!!n.exportRights[p.id]}
                        onChange={(e) => onExportRight(p.id, e.target.checked)}
                      />
                      <span>行省 #{p.id + 1}{isCoastal(map, p) ? '（沿海）' : ''}{p.isStrait ? ' · 海峡要道' : ''}</span>
                    </label>
                  ))}
                </div>
                {(n.monthly.exportValue > 0.01 || n.monthly.importValue > 0.01) ? (
                  <p className="dim">上月出口 {n.monthly.exportValue.toFixed(1)} 万₭ · 进口 {n.monthly.importValue.toFixed(1)} 万₭ · 关税 +{n.monthly.tariff.toFixed(1)} 万₭</p>
                ) : (
                  <p className="dim">上月无国际贸易（开放贸易关闭或口岸无余量）。</p>
                )}
              </section>
            </div>
          )}

          {/* ---- 投资 ---- */}
          <SectionHead title="投资" icon={Factory} open={open.invest} onToggle={() => toggle('invest')} />
          {open.invest && (
            <InvestTab game={game} map={map} ownedProvs={ownedProvs} onInvest={onInvest} onCancelInvest={onCancelInvest} onNationalize={onNationalize} />
          )}

          {/* ---- 大事记 ---- */}
          <SectionHead title="大事记" icon={Newspaper} open={open.log} onToggle={() => toggle('log')} />
          {open.log && (
            <div className="gov-sec-body">
              <section className="p-sec">
                <h4>大事记（{game.chronicle.length} 条 · 被动记录）</h4>
                {game.chronicle.length === 0 ? (
                  <p className="dim">暂无大事。历史正在书写…</p>
                ) : (
                  <ul className="log-list">
                    {game.chronicle
                      .slice()
                      .reverse()
                      .slice(0, 200)
                      .map((e, i) => (
                        <li key={i}>
                          <span className="log-date">{monthLabel(e.day)}</span>
                          <span className="log-title">{e.title}</span>
                          {e.detail && <span className="log-choice">{e.detail}</span>}
                        </li>
                      ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      )}
      {collapsed && (
        <div className="gov-body-collapsed">
          <button className="gov-collapse-wide" onClick={onToggleCollapse} title="展开治理面板">治理 ▸</button>
        </div>
      )}
    </aside>
  );
}
