import { useState } from 'react';
import type { GameMap, Province } from '../game/map';
import { CLIMATE_LABEL, TERRAIN_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import type { NationId, TaxLevel } from '../game/types';
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
import { monthLabel } from '../game/clock';

interface Props {
  game: GameState;
  map: GameMap;
  selectedProvince: number | null;
  onTax: (level: TaxLevel) => void;
  onSpending: (kind: 'military' | 'admin' | 'infra', value: number) => void;
}

type Tab = 'economy' | 'nation' | 'log';

const SPEND_LABEL: Record<'military' | 'admin' | 'infra', string> = {
  military: '军费',
  admin: '行政',
  infra: '基建',
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

function ProvinceInfo({ map, game, prov }: { map: GameMap; game: GameState; prov: Province }) {
  const pop = provincePopWan(map, game, prov.id);
  const grain = provinceGrainPerYear(map, prov.id);
  const ownerName = prov.isUndiscovered ? '未探明' : (NATIONS[prov.owner as NationId]?.name ?? '未知');
  return (
    <div className="province-info">
      <h4>行省 #{prov.id + 1}</h4>
      <dl>
        <dt>归属</dt>
        <dd>{ownerName}</dd>
        <dt>气候</dt>
        <dd>{CLIMATE_LABEL[prov.climate]}（均温 {prov.avgTemp.toFixed(0)}℃ / 降水 {prov.avgPrec.toFixed(0)}）</dd>
        <dt>地形</dt>
        <dd>{TERRAIN_LABEL[prov.terrain]}</dd>
        <dt>格数</dt>
        <dd>{prov.cellIds.length}</dd>
        <dt>人口</dt>
        <dd>{fmt(pop)} 万</dd>
        <dt>年产粮</dt>
        <dd>{grain.toFixed(1)} 万吨</dd>
        <dt>产出修正</dt>
        <dd>×{prov.productivity.toFixed(2)}</dd>
        <dt>粮产修正</dt>
        <dd>×{prov.grainMod.toFixed(2)}</dd>
      </dl>
    </div>
  );
}

export default function NationPanel({ game, map, selectedProvince, onTax, onSpending }: Props) {
  const [tab, setTab] = useState<Tab>('economy');
  const n = game.nations[game.playerNation];
  const def = NATIONS[game.playerNation];
  const incomeM = nationMonthlyIncome(map, game, game.playerNation);
  const spendM = nationMonthlySpending(game, game.playerNation);
  const grainM = nationMonthlyGrain(map, game, game.playerNation);
  const selected = selectedProvince !== null ? map.provinceById.get(selectedProvince) ?? null : null;

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
          <section className="p-sec">
            <h4>税率</h4>
            <div className="tax-row">
              {TAX_LEVELS.map((l) => (
                <button
                  key={l}
                  className={`tax-btn ${n.taxLevel === l ? 'active' : ''}`}
                  onClick={() => onTax(l)}
                  title={`税率 ${(TAX_RATES[l].rate * 100).toFixed(0)}% · 稳定度惩罚 -${TAX_RATES[l].penalty}`}
                >
                  {TAX_RATES[l].label}
                  <em>{(TAX_RATES[l].rate * 100).toFixed(0)}%</em>
                </button>
              ))}
            </div>
          </section>

          <section className="p-sec">
            <h4>月度支出（万₭）</h4>
            {(['military', 'admin', 'infra'] as const).map((k) => (
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
          </section>

          <section className="p-sec">
            <h4>月度结算</h4>
            <table className="mini-table">
              <tbody>
                <tr><td>税收收入</td><td>+{fmt(incomeM)} 万₭</td></tr>
                <tr><td>支出合计</td><td>-{fmt(spendM)} 万₭</td></tr>
                <tr className="sum"><td>国库结余</td><td>{fmt(incomeM - spendM)} 万₭</td></tr>
                <tr><td>粮食月结余</td><td className={grainM >= 0 ? 'pos' : 'neg'}>{grainM >= 0 ? '+' : ''}{grainM.toFixed(1)} 万吨</td></tr>
                <tr><td>粮食储备</td><td>{fmt(n.foodStock)} 万吨</td></tr>
                <tr><td>人口</td><td>{fmt(n.popWan)} 万</td></tr>
                <tr><td>识字率</td><td>{(n.literacy * 100).toFixed(1)}%</td></tr>
                <tr><td>稳定度</td><td>{Math.round(n.stability)} / 100</td></tr>
              </tbody>
            </table>
            {n.foodStock < 0 && (
              <p className="warn">⚠ 缺粮中：稳定度持续下降</p>
            )}
            {n.stability < 30 && (
              <p className="warn">⚠ 稳定度低于 30：随时可能爆发民变</p>
            )}
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
              <dt>国库</dt><dd>{fmt(n.treasury)} 万₭</dd>
              <dt>经济特点</dt><dd>{def.economy}</dd>
            </dl>
            <p className="nation-desc">{def.description}</p>
          </section>
          <section className="p-sec">
            <h4>辖区</h4>
            <p>
              所辖陆地格 {n.cells} 格 ·{' '}
              {map.provinces.filter((p) => p.owner === game.playerNation && !p.isUndiscovered).length} 个行省
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
