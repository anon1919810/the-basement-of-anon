import { useEffect, useRef, useState } from 'react';
import type { GameMap } from './game/map';
import { loadMap } from './game/map';
import type { GameState } from './game/state';
import { loadGame, newGameState, tickDay, saveGame, clearSave, setPolicy, abolishSerfdom, hasOldSave, scaledNationPop } from './game/state';
import type { NationId, Speed } from './game/types';
import type { TaxKind } from './game/tax';
import type { GoodId } from './game/types';
import { monthIndex, daysPerSecond } from './game/clock';
import { retrainPop } from './game/labor';
import { cancelInvestment, startInvestment } from './game/buildings';
import type { BuildingKind } from './game/buildings';
import { NATIONS, NATION_LIST } from './game/nations';
import { clampTax } from './game/tax';
import WorldMap from './components/WorldMap';
import TopBar from './components/TopBar';
import GovernancePanel from './components/GovernancePanel';
import ProvincePanel from './components/ProvincePanel';

export default function App() {
  const mapRef = useRef<GameMap | null>(null);
  if (!mapRef.current) mapRef.current = loadMap();
  const map = mapRef.current;

  const [game, setGame] = useState<GameState>(() =>
    loadGame() ?? newGameState('lorraine', (Date.now() >>> 0) % 0x7fffffff, map),
  );
  const gameRef = useRef(game);
  gameRef.current = game;

  const [selectedProvince, setSelectedProvince] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [oldSaveNotice, setOldSaveNotice] = useState<boolean>(() => hasOldSave());
  const [showNationPicker, setShowNationPicker] = useState(false);
  const [govCollapsed, setGovCollapsed] = useState(false); // v0.5 左侧治理面板可折叠
  const flashTimer = useRef<number | null>(null);

  // 实时时钟：rAF + dt 驱动（暂停 / 1x / 2x / 3x）
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = gameRef.current;
      if (s.speed > 0) {
        acc += dt * daysPerSecond(s.speed);
        while (acc >= 1) {
          tickDay(s, map);
          acc -= 1;
        }
        // 每月自动存档
        const mi = monthIndex(s.day);
        if (mi > 0 && mi !== s.lastAutosaveMonth) {
          s.lastAutosaveMonth = mi;
          saveGame(s);
        }
        setGame({ ...s });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  const flash = () => {
    setSavedFlash(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const actions = {
    setSpeed(s: Speed) {
      const g = gameRef.current;
      if (s > 0) g.prevSpeed = s;
      g.speed = s;
      setGame({ ...g });
    },
    togglePause() {
      const g = gameRef.current;
      actions.setSpeed(g.speed === 0 ? (g.prevSpeed || 1) : 0);
    },
    setNation(id: NationId) {
      const g = gameRef.current;
      g.playerNation = id;
      setGame({ ...g });
    },
    /** v0.4 五税种连续滑块（0%-30%） */
    setTaxRate(kind: TaxKind, value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].tax.rates[kind] = clampTax(value);
      setGame({ ...g });
    },
    /** v0.4 单一商品税滑块（全部商品可选，0%-30%） */
    setGoodsTax(good: GoodId, value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].tax.goods[good] = clampTax(value);
      setGame({ ...g });
    },
    setSpending(kind: 'military' | 'admin' | 'infra' | 'court' | 'health', value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].spending[kind] = value;
      setGame({ ...g });
    },
    retrain(provId: number, popIndex: number) {
      const g = gameRef.current;
      retrainPop(g, map, provId, popIndex);
      setGame({ ...g });
    },
    invest(kind: BuildingKind, provId: number) {
      const g = gameRef.current;
      startInvestment(g, map, kind, provId);
      setGame({ ...g });
    },
    cancelInvest(projectId: number) {
      const g = gameRef.current;
      cancelInvestment(g, projectId);
      setGame({ ...g });
    },
    togglePolicy(policy: 'progressiveTax' | 'universalSuffrage', on: boolean) {
      const g = gameRef.current;
      setPolicy(g, policy, on);
      setGame({ ...g });
    },
    abolish() {
      const g = gameRef.current;
      if (abolishSerfdom(g, map)) {
        setGame({ ...g });
        flash();
      } else {
        window.alert('废农奴制不可用：当前无奴隶或已废除。');
      }
    },
    save() {
      if (saveGame(gameRef.current)) flash();
    },
    newGame() {
      if (!window.confirm('开始新游戏？当前进度将被覆盖。')) return;
      setShowNationPicker(true);
    },
    startNewGame(nation: NationId) {
      const g = newGameState(nation, (Date.now() >>> 0) % 0x7fffffff, map);
      clearSave();
      setOldSaveNotice(false);
      setSelectedProvince(null);
      setShowNationPicker(false);
      setGame(g);
    },
  };

  // v0.5 键盘快捷键：空格=暂停/继续、1/2/3=速度、S=存档、N=新游戏（带确认）
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const a = actionsRef.current;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          a.togglePause();
          break;
        case '1':
          a.setSpeed(1);
          break;
        case '2':
          a.setSpeed(2);
          break;
        case '3':
          a.setSpeed(3);
          break;
        case 's':
        case 'S':
          a.save();
          break;
        case 'n':
        case 'N':
          a.newGame();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar
        game={game}
        onSpeed={actions.setSpeed}
        onNation={actions.setNation}
        onSave={actions.save}
        onNewGame={actions.newGame}
      />
      <main className="main">
        <GovernancePanel
          game={game}
          map={map}
          onTaxRate={actions.setTaxRate}
          onGoodsTax={actions.setGoodsTax}
          onSpending={actions.setSpending}
          onRetrain={actions.retrain}
          onInvest={actions.invest}
          onCancelInvest={actions.cancelInvest}
          onTogglePolicy={actions.togglePolicy}
          onAbolish={actions.abolish}
          collapsed={govCollapsed}
          onToggleCollapse={() => setGovCollapsed((c) => !c)}
        />
        <div className="map-area">
          <WorldMap
            map={map}
            game={game}
            selectedProvince={selectedProvince}
            onSelect={setSelectedProvince}
          />
        </div>
        <ProvincePanel map={map} game={game} selectedProvince={selectedProvince} />
      </main>
      {savedFlash && <div className="toast">已保存到本机</div>}
      {oldSaveNotice && (
        <div className="toast old-save-toast" onClick={() => setOldSaveNotice(false)}>
          ⚠ 检测到 v0.4/v0.5 旧存档（不兼容 v0.6：国界重绘/人口缩放），已开启新局；点击关闭
        </div>
      )}
      {showNationPicker && (
        <div className="modal-overlay" onClick={() => setShowNationPicker(false)}>
          <div className="nation-picker" onClick={(e) => e.stopPropagation()}>
            <h3>选择你的国家（8 国全可玩）</h3>
            <p className="dim">新历 1023 年 · 工业革命前夜。人口按地图住房容量缩放（v0.5），各国政体/识字率/资源禀赋各异</p>
            <div className="nation-picker-grid">
              {NATION_LIST.map((d) => (
                <button key={d.id} className="nation-pick-card" onClick={() => actions.startNewGame(d.id)}>
                  <span className="nation-pick-dot" style={{ background: d.color }} />
                  <b>{d.name}</b>
                  <em className="dim">{d.gov} · 开局 {Math.round(scaledNationPop(map, d.id))} 万 · 识字 {(d.literacy * 100).toFixed(0)}%</em>
                  <span className="dim">{NATIONS[d.id].economy}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
