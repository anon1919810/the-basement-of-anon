/**
 * v0.5 右侧省份详情面板：地图右侧展示「选中省份」详情（治理元素已移至左侧栏）。
 */
import type { GameMap, Province } from '../game/map';
import { CLIMATE_LABEL, TERRAIN_LABEL } from '../game/map';
import type { GameState } from '../game/state';
import type { NationId } from '../game/types';
import { NATIONS } from '../game/nations';
import { provincePopWan, provinceGrainPerYear } from '../game/economy';
import { provinceLuxuryPotential } from '../game/pops';
import { provinceResourceLabels } from '../game/resources';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

export default function ProvincePanel({ map, game, selectedProvince }: {
  map: GameMap;
  game: GameState;
  selectedProvince: number | null;
}) {
  const selected = selectedProvince !== null ? map.provinceById.get(selectedProvince) ?? null : null;
  if (!selected) {
    return (
      <aside className="prov-panel">
        <div className="prov-empty">
          <p className="prov-empty-title">省份详情</p>
          <p className="dim">在地图上点击任意省份查看详情（辖区/气候/资源/人口/产出）。</p>
        </div>
      </aside>
    );
  }
  return (
    <aside className="prov-panel">
      <ProvinceInfo map={map} game={game} prov={selected} />
    </aside>
  );
}

function ProvinceInfo({ map, game, prov }: { map: GameMap; game: GameState; prov: Province }) {
  const pop = provincePopWan(map, game, prov.id);
  const grain = provinceGrainPerYear(map, prov.id);
  const ps = game.provinces[prov.id];
  const ownerName = prov.isUndiscovered ? '未探明新大陆' : (NATIONS[prov.owner as NationId]?.name ?? '未知');
  return (
    <div className="province-info">
      <h4>
        行省 #{prov.id + 1}
        {prov.isStrait && <span className="prov-strait">海峡要道</span>}
      </h4>
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
      {prov.isUndiscovered && <div className="hover-note">未探明的新大陆，等待征服。</div>}
    </div>
  );
}
