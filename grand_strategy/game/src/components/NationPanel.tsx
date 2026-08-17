import { useState } from 'react';
import type { GameMap, Province } from '../game/map';
import { CLIMATE_LABEL, TERRAIN_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import type { ClassId, GoodId, NationId, TaxLevel } from '../game/types';
import { NATIONS } from '../game/nations';
import {
  TAX_LEVELS,
  TAX_RATES,
  nationMonthlyIncome,
  nationMonthlySpending,
  nationMonthlyGrain,
  provincePopWan,
  provinceGrainPerYear,
  nationClassMixOf,
  nationClassPower,
} from '../game/economy';
import { GOODS, GOOD_LABEL, JOB_LABEL, JOBS, RACE_LABEL, provinceLuxuryPotential } from '../game/pops';
import { CLASSES, CLASS_DEFS, classDef } from '../game/classes';
import { nextJobThreshold } from '../game/labor';
import { BUILDING_DEFS, BUILDING_KINDS, buildingSkillReqPop, projectProgress, buildingUnlock } from '../game/buildings';
import type { BuildingKind } from '../game/buildings';
import { provinceResourceLabels } from '../game/resources';
import { monthLabel } from '../game/clock';

interface Props {
  game: GameState;
  map: GameMap;
  selectedProvince: number | null;
  onTax: (level: TaxLevel) => void;
  onSpending: (kind: 'military' | 'admin' | 'infra' | 'court' | 'health', value: number) => void;
  onRetrain: (provId: number, popIndex: number) => void;
  onInvest: (kind: BuildingKind, provId: number) => void;
  onCancelInvest: (projectId: number) => void;
  onTogglePolicy: (policy: 'progressiveTax' | 'universalSuffrage', on: boolean) => void;
  onAbolish: () => void;
}

type Tab = 'economy' | 'nation' | 'invest' | 'class' | 'log';
type MktLevel = 'nation' | 'province' | 'county';

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
  return `${inputs || '—'} → ${GOOD_LABEL[d.output]}×${d.capacity}`;
}

function ProvinceInfo({ map, game, prov }: { map: GameMap; game: GameState; prov: Province }) {
  const pop = provincePopWan(map, game, prov.id);
  const grain = provinceGrainPerYear(map, prov.id);
  const ps = game.provinces[prov.id];
  const ownerName = prov.isUndiscovered ? '未探明' : (NATIONS[prov.owner as NationId]?.name ?? '未知');
  return (
    <div className="province-info">
      <h4>行省 #{prov.id + 1}</h4>
      <dl>
        <dt>归属</dt>
        <dd>{ownerName}</dd>
        <dt>辖区</dt>
        <dd>{prov.counties.length} 县 · {prov.cellIds.length} 格</dd>
        <dt>气候</dt>
        <dd>{CLIMATE_LABEL[prov.climate]}（均温 {prov.avgTemp.toFixed(0)}℃ / 降水 {prov.avgPrec.toFixed(0)}）</dd>
        <dt>地形</dt>
        <dd>{TERRAIN_LABEL[prov.terrain]}</dd>
        <dt>海拔</dt>
        <dd>{prov.elevStats.min}–{prov.elevStats.max}（均 {prov.elevStats.avg.toFixed(0)}）</dd>
        <dt>资源</dt>
        <dd>{provinceResourceLabels(prov).join(' · ') || '—'}</dd>
        <dt>人口</dt>
        <dd>{fmt(pop)} 万 / 容量 {ps ? fmt(ps.housingCap) : 0} 万</dd>
        {ps && (
          <>
            <dt>幸福度</dt>
            <dd>{ps.happiness.toFixed(0)} · 效率 ×{ps.efficiency.toFixed(2)}</dd>
            <dt>运费系数</dt>
            <dd>×{ps.freight.toFixed(2)}</dd>
          </>
        )}
        <dt>年产粮</dt>
        <dd>{grain.toFixed(1)} 万吨</dd>
        <dt>奢侈品潜力</dt>
        <dd>×{provinceLuxuryPotential(prov).toFixed(2)}</dd>
      </dl>
    </div>
  );
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
function InvestTab({ game, map, ownedProvs, onInvest, onCancelInvest }: {
  game: GameState;
  map: GameMap;
  ownedProvs: Province[];
  onInvest: Props['onInvest'];
  onCancelInvest: Props['onCancelInvest'];
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
          <h4>已投产建筑（{active.length}）</h4>
          <table className="mini-table">
            <thead>
              <tr><th>项目</th><th>位置</th><th>技能/运行</th><th>上月产出</th><th>上月回报</th></tr>
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
                    <td>{p.lastOutput.toFixed(2)} {GOOD_LABEL[d.output]}</td>
                    <td className={ret >= 0 ? 'pos' : 'neg'}>{ret >= 0 ? '+' : ''}{ret.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dim">技能满足 = 省内{JOBS.map((j) => JOB_LABEL[j]).join('/')} POP 充足度；输入可用 = 国家库存充足度。</p>
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
          const expRet = d.capacity * n.market[d.output].price - inputCost - d.opCost;
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

/** 阶级页：七级分布 + 权势构成 + 阶级流动提示 + 政策 */
function ClassTab({ game, map, onTogglePolicy, onAbolish }: {
  game: GameState;
  map: GameMap;
  onTogglePolicy: Props['onTogglePolicy'];
  onAbolish: Props['onAbolish'];
}) {
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

      <section className="p-sec">
        <h4>政策（作用于当前国）</h4>
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
    </div>
  );
}

export default function NationPanel({ game, map, selectedProvince, onTax, onSpending, onRetrain, onInvest, onCancelInvest, onTogglePolicy, onAbolish }: Props) {
  const [tab, setTab] = useState<Tab>('economy');
  const n = game.nations[game.playerNation];
  const def = NATIONS[game.playerNation];
  const incomeM = nationMonthlyIncome(map, game, game.playerNation);
  const spendM = nationMonthlySpending(game, game.playerNation);
  const grainM = nationMonthlyGrain(map, game, game.playerNation);
  const ledger = n.monthly;

  // 焦点省：选中的玩家省，否则第一个玩家省
  let focusProvId: number | null = null;
  if (selectedProvince !== null) {
    const sp = map.provinceById.get(selectedProvince);
    if (sp && sp.owner === game.playerNation && !sp.isUndiscovered) focusProvId = sp.id;
  }
  if (focusProvId === null) {
    for (const p of map.provinces) {
      if (p.owner === game.playerNation && !p.isUndiscovered) {
        focusProvId = p.id;
        break;
      }
    }
  }
  const selected = selectedProvince !== null ? map.provinceById.get(selectedProvince) ?? null : null;

  const ownedProvs = map.provinces.filter((p) => p.owner === game.playerNation && !p.isUndiscovered);
  const focusProv = focusProvId !== null ? map.provinceById.get(focusProvId) ?? null : null;
  const focusPs = focusProvId !== null ? game.provinces[focusProvId] ?? null : null;
  const netInvest = ledger.investReturn - ledger.investCost + ledger.investRefund;

  return (
    <aside className="panel">
      <div className="panel-tabs">
        {(['economy', 'nation', 'invest', 'class', 'log'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'economy' ? '经济' : t === 'nation' ? '国家' : t === 'invest' ? '投资' : t === 'class' ? '阶级' : '大事记'}
          </button>
        ))}
      </div>

      {tab === 'economy' && (
        <div className="tab-body">
          {/* 税率 */}
          <section className="p-sec">
            <h4>税率（土地 / 人头 / 关税 / 盐税 · 阶级负担）</h4>
            <div className="tax-row">
              {TAX_LEVELS.map((l) => (
                <button
                  key={l}
                  className={`tax-btn ${n.taxLevel === l ? 'active' : ''}`}
                  onClick={() => onTax(l)}
                  title={`稳定度惩罚 -${TAX_RATES[l].penalty}`}
                >
                  {TAX_RATES[l].label}
                  <em>{(TAX_RATES[l].rate * 100).toFixed(0)}%</em>
                </button>
              ))}
            </div>
            <div className="tax-detail">
              {(() => {
                const r = TAX_RATES[n.taxLevel].rates;
                return `土地 ${(r.land * 100).toFixed(0)}% · 人头 ${(r.poll * 100).toFixed(0)}% · 关税 ${(r.tariff * 100).toFixed(0)}% · 盐税 ${(r.salt * 100).toFixed(0)}%`;
              })()}
              {n.policies.progressiveTax && <span className="pos"> · 累进税生效</span>}
            </div>
            <p className="dim">人头/盐税按阶级负担系数征收：苛税打在下层，上层可豁免；上层另有地税负担。</p>
          </section>

          {/* 支出滑杆 */}
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

          {/* 财政 */}
          <section className="p-sec">
            <h4>财政结算（上月）</h4>
            <table className="mini-table">
              <tbody>
                <tr><td>人头税（阶级加权）</td><td>+{ledger.pollTax.toFixed(1)}</td></tr>
                <tr><td>土地税（按地主持有）</td><td>+{ledger.landTax.toFixed(1)}</td></tr>
                <tr><td>盐税</td><td>+{ledger.saltTax.toFixed(1)}</td></tr>
                <tr><td>关税</td><td>+{ledger.tariff.toFixed(1)}</td></tr>
                <tr><td>建筑回报</td><td className={ledger.investReturn >= 0 ? 'pos' : 'neg'}>{ledger.investReturn >= 0 ? '+' : ''}{ledger.investReturn.toFixed(1)}</td></tr>
                <tr><td>投资支出 / 退款</td><td className={netInvest >= 0 ? 'pos' : 'neg'}>{netInvest >= 0 ? '+' : ''}{netInvest.toFixed(1)}</td></tr>
                <tr><td>支出合计</td><td>-{ledger.spending.toFixed(1)}</td></tr>
                <tr className="sum"><td>月度结余</td><td>{(ledger.income - ledger.spending + netInvest) >= 0 ? '+' : ''}{(ledger.income - ledger.spending + netInvest).toFixed(1)}</td></tr>
                <tr><td>国库</td><td>{fmt(n.treasury)} 万₭</td></tr>
                <tr><td>贸易收支</td><td className={ledger.tradeBalance >= 0 ? 'pos' : 'neg'}>{ledger.tradeBalance >= 0 ? '+' : ''}{ledger.tradeBalance.toFixed(1)} 万₭</td></tr>
                <tr><td>人口增长率</td><td>{(ledger.growthRate * 100).toFixed(2)}% / 年</td></tr>
                <tr><td>流亡人口</td><td className={n.emigration > 0 ? 'neg' : ''}>{n.emigration > 0 ? `-${fmt(n.emigration)} 万` : '—'}</td></tr>
              </tbody>
            </table>
            {n.treasury < 0 && <p className="warn">⚠ 国库为负：连年赤字将触发「国库破产」大事记</p>}
          </section>

          {/* 三级市场价目表 */}
          <section className="p-sec">
            <h4>市场价目（17 商品 · 供需定价 0.4~2.5 倍）</h4>
            <MarketTable game={game} map={map} ownedProvs={ownedProvs} focusProvId={focusProvId} />
            <p className="dim">
              产/消：{GOODS.map((g) => `${GOOD_LABEL[g]} ${n.market[g].supply.toFixed(1)}/${n.market[g].consumed.toFixed(1)}`).join(' · ')}
              {n.market.food.unmet > 0.001 && <span className="neg"> · ⚠ 缺粮 {n.market.food.unmet.toFixed(1)}</span>}
            </p>
            <p className="dim">建筑输入参与定价与进口补足；省/县宽表可横向滚动，悬停查看供需比与净流</p>
          </section>

          {/* 基建 */}
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

          {/* 劳动力 & POP */}
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
                    const canRetrain = next !== null && n.literacy >= literacyReq && pop.size > 0.001;
                    const cd = classDef(pop.class);
                    return (
                      <tr key={i}>
                        <td>{RACE_LABEL[pop.race]}{JOB_LABEL[pop.job]}<em className="dim">·{cd.label}</em></td>
                        <td>{pop.size.toFixed(1)}万</td>
                        <td className={pop.happiness >= 60 ? 'pos' : pop.happiness >= 40 ? '' : 'neg'}>{pop.happiness.toFixed(0)}</td>
                        <td>₭{pop.wage.toFixed(1)}{pop.investIncome > 0.01 ? <em className="dim">+投{pop.investIncome.toFixed(1)}</em> : null}</td>
                        <td>
                          {next ? (
                            <button
                              className={`retrain-btn ${canRetrain ? '' : 'disabled'}`}
                              disabled={!canRetrain}
                              onClick={() => onRetrain(focusProv.id, i)}
                              title={canRetrain ? '转职：3 个月产出减半' : `识字率需 ≥${(literacyReq * 100).toFixed(0)}%`}
                            >
                              转{next === 'miner' ? '矿' : next === 'artisan' ? '匠' : '工'}
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

          <section className="p-sec">
            <h4>月度结算</h4>
            <table className="mini-table">
              <tbody>
                <tr><td>税收收入</td><td>+{fmt(incomeM)} 万₭</td></tr>
                <tr><td>支出合计</td><td>-{fmt(spendM)} 万₭</td></tr>
                <tr><td>上层投资收入</td><td>+{ledger.investIncome.toFixed(1)} 万₭</td></tr>
                <tr><td>粮食月结余</td><td className={grainM >= 0 ? 'pos' : 'neg'}>{grainM >= 0 ? '+' : ''}{grainM.toFixed(1)} 万吨</td></tr>
                <tr><td>粮食储备</td><td>{fmt(n.foodStock)} 万吨</td></tr>
                <tr><td>人口</td><td>{fmt(n.popWan)} 万</td></tr>
                <tr><td>识字率</td><td>{(n.literacy * 100).toFixed(1)}%</td></tr>
                <tr><td>健康</td><td>{(n.health * 100).toFixed(0)}%</td></tr>
                <tr><td>稳定度</td><td>{Math.round(n.stability)} / 100</td></tr>
              </tbody>
            </table>
            {n.foodStock < 0 && <p className="warn">⚠ 缺粮中：稳定度持续下降</p>}
            {n.stability < 30 && <p className="warn">⚠ 稳定度低于 30：民怨沸腾，危机四伏</p>}
            {n.emigration > 0 && <p className="warn">⚠ 人口外流 {fmt(n.emigration)} 万：住房拥挤或民生恶化</p>}
          </section>
        </div>
      )}

      {tab === 'nation' && (
        <div className="tab-body">
          <section className="p-sec">
            <h4>{def.name}</h4>
            <dl className="nation-dl">
              <dt>政体</dt><dd>{def.gov}</dd>
              <dt>主体种族</dt><dd>{def.race}</dd>
              <dt>人口</dt><dd>{fmt(n.popWan)} 万</dd>
              <dt>识字率</dt><dd>{(n.literacy * 100).toFixed(1)}%</dd>
              <dt>健康</dt><dd>{(n.health * 100).toFixed(1)}%</dd>
              <dt>国库</dt><dd>{fmt(n.treasury)} 万₭</dd>
              <dt>经济特点</dt><dd>{def.economy}</dd>
            </dl>
            <p className="nation-desc">{def.description}</p>
          </section>
          <section className="p-sec">
            <h4>辖区（三级制）</h4>
            <p>
              所辖陆地格 {n.cells} 格 · {ownedProvs.length} 个行省 ·{' '}
              {ownedProvs.reduce((s, p) => s + p.counties.length, 0)} 个县
            </p>
          </section>
        </div>
      )}

      {tab === 'invest' && (
        <InvestTab game={game} map={map} ownedProvs={ownedProvs} onInvest={onInvest} onCancelInvest={onCancelInvest} />
      )}

      {tab === 'class' && (
        <ClassTab game={game} map={map} onTogglePolicy={onTogglePolicy} onAbolish={onAbolish} />
      )}

      {tab === 'log' && (
        <div className="tab-body">
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

      {selected && (
        <section className="p-sec province-panel">
          <ProvinceInfo map={map} game={game} prov={selected} />
        </section>
      )}
    </aside>
  );
}
