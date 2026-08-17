import { useState } from 'react';
import type { GameMap, Province } from '../game/map';
import { CLIMATE_LABEL, TERRAIN_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import type { GoodId, NationId, TaxLevel } from '../game/types';
import { NATIONS } from '../game/nations';
import {
  TAX_LEVELS,
  TAX_RATES,
  nationMonthlyIncome,
  nationMonthlySpending,
  nationMonthlyGrain,
  provincePopWan,
  provinceGrainPerYear,
} from '../game/economy';
import { GOODS, GOOD_LABEL, JOB_LABEL, JOBS, RACE_LABEL } from '../game/pops';
import { nextJobThreshold } from '../game/labor';
import { monthLabel } from '../game/clock';

interface Props {
  game: GameState;
  map: GameMap;
  selectedProvince: number | null;
  onTax: (level: TaxLevel) => void;
  onSpending: (kind: 'military' | 'admin' | 'infra' | 'court' | 'health', value: number) => void;
  onRetrain: (provId: number, popIndex: number) => void;
}

type Tab = 'economy' | 'nation' | 'log';

const SPEND_LABEL: Record<'military' | 'admin' | 'infra' | 'court' | 'health', string> = {
  military: '军费',
  admin: '行政',
  infra: '基建',
  court: '宫廷',
  health: '卫生',
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
      </dl>
    </div>
  );
}

export default function NationPanel({ game, map, selectedProvince, onTax, onSpending, onRetrain }: Props) {
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

  return (
    <aside className="panel">
      <div className="panel-tabs">
        {(['economy', 'nation', 'log'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'economy' ? '经济' : t === 'nation' ? '国家' : '事件日志'}
          </button>
        ))}
      </div>

      {tab === 'economy' && (
        <div className="tab-body">
          {/* 税率 */}
          <section className="p-sec">
            <h4>税率（土地 / 人头 / 关税 / 盐税）</h4>
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
            </div>
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
            <p className="dim">行政提识字率 · 卫生提健康 · 基建提产能并降运费</p>
          </section>

          {/* 财政 */}
          <section className="p-sec">
            <h4>财政结算（上月）</h4>
            <table className="mini-table">
              <tbody>
                <tr><td>人头税</td><td>+{ledger.pollTax.toFixed(1)}</td></tr>
                <tr><td>土地税</td><td>+{ledger.landTax.toFixed(1)}</td></tr>
                <tr><td>盐税</td><td>+{ledger.saltTax.toFixed(1)}</td></tr>
                <tr><td>关税</td><td>+{ledger.tariff.toFixed(1)}</td></tr>
                <tr><td>支出合计</td><td>-{ledger.spending.toFixed(1)}</td></tr>
                <tr className="sum"><td>月度结余</td><td>{(ledger.income - ledger.spending) >= 0 ? '+' : ''}{(ledger.income - ledger.spending).toFixed(1)}</td></tr>
                <tr><td>国库</td><td>{fmt(n.treasury)} 万₭</td></tr>
                <tr><td>贸易收支</td><td className={ledger.tradeBalance >= 0 ? 'pos' : 'neg'}>{ledger.tradeBalance >= 0 ? '+' : ''}{ledger.tradeBalance.toFixed(1)} 万₭</td></tr>
                <tr><td>人口增长率</td><td>{(ledger.growthRate * 100).toFixed(2)}% / 年</td></tr>
                <tr><td>流亡人口</td><td className={n.emigration > 0 ? 'neg' : ''}>{n.emigration > 0 ? `-${fmt(n.emigration)} 万` : '—'}</td></tr>
              </tbody>
            </table>
            {n.treasury < 0 && <p className="warn">⚠ 国库为负：连年赤字或触发「国库破产」事件</p>}
          </section>

          {/* 市场价目表 */}
          <section className="p-sec">
            <h4>国家市场价目（供需定价 · 0.4~2.5 倍）</h4>
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
                      <td>{m.consumed > 0 || n.stocks[g] > 0 ? n.stocks[g].toFixed(1) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="dim">
              产/消：{GOODS.map((g) => `${GOOD_LABEL[g]} ${n.market[g].supply.toFixed(1)}/${n.market[g].consumed.toFixed(1)}`).join(' · ')}
              {n.market.food.unmet > 0.001 && <span className="neg"> · ⚠ 缺粮 {n.market.food.unmet.toFixed(1)}</span>}
            </p>
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
            <p className="dim">道路降陆运、港口降海运并扩贸易容量；投入「基建」滑杆提升</p>
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
                    return (
                      <tr key={i}>
                        <td>{RACE_LABEL[pop.race]}{JOB_LABEL[pop.job]}</td>
                        <td>{pop.size.toFixed(1)}万</td>
                        <td className={pop.happiness >= 60 ? 'pos' : pop.happiness >= 40 ? '' : 'neg'}>{pop.happiness.toFixed(0)}</td>
                        <td>₭{pop.wage.toFixed(1)}</td>
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
              <p className="dim">转职代价：该 POP 3 个月产出减半。识字率 {(n.literacy * 100).toFixed(1)}%</p>
            </section>
          )}

          <section className="p-sec">
            <h4>月度结算</h4>
            <table className="mini-table">
              <tbody>
                <tr><td>税收收入</td><td>+{fmt(incomeM)} 万₭</td></tr>
                <tr><td>支出合计</td><td>-{fmt(spendM)} 万₭</td></tr>
                <tr><td>粮食月结余</td><td className={grainM >= 0 ? 'pos' : 'neg'}>{grainM >= 0 ? '+' : ''}{grainM.toFixed(1)} 万吨</td></tr>
                <tr><td>粮食储备</td><td>{fmt(n.foodStock)} 万吨</td></tr>
                <tr><td>人口</td><td>{fmt(n.popWan)} 万</td></tr>
                <tr><td>识字率</td><td>{(n.literacy * 100).toFixed(1)}%</td></tr>
                <tr><td>健康</td><td>{(n.health * 100).toFixed(1)}%</td></tr>
                <tr><td>稳定度</td><td>{Math.round(n.stability)} / 100</td></tr>
              </tbody>
            </table>
            {n.foodStock < 0 && <p className="warn">⚠ 缺粮中：稳定度持续下降</p>}
            {n.stability < 30 && <p className="warn">⚠ 稳定度低于 30：随时可能爆发民变</p>}
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

      {tab === 'log' && (
        <div className="tab-body">
          <section className="p-sec">
            <h4>事件日志（{game.eventLog.length} 条）</h4>
            {game.eventLog.length === 0 ? (
              <p className="dim">暂无事件。历史正在书写…</p>
            ) : (
              <ul className="log-list">
                {game.eventLog
                  .slice()
                  .reverse()
                  .slice(0, 200)
                  .map((e, i) => (
                    <li key={i}>
                      <span className="log-date">{monthLabel(e.day)}</span>
                      <span className="log-title">{e.title}</span>
                      <span className="log-choice">{e.choice}</span>
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
