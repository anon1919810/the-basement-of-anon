import { useEffect, useRef, useState } from 'react';
import type { GameMap } from './game/map';
import { loadMap } from './game/map';
import type { GameState } from './game/state';
import { loadGame, newGameState, tickDay, processEvent, deferEvent, saveGame, clearSave } from './game/state';
import type { NationId, Speed, TaxLevel } from './game/types';
import { monthIndex, daysPerSecond } from './game/clock';
import { retrainPop } from './game/labor';
import WorldMap from './components/WorldMap';
import TopBar from './components/TopBar';
import NationPanel from './components/NationPanel';
import EventModal from './components/EventModal';

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
    setNation(id: NationId) {
      const g = gameRef.current;
      g.playerNation = id;
      setGame({ ...g });
    },
    setTax(level: TaxLevel) {
      const g = gameRef.current;
      g.nations[g.playerNation].taxLevel = level;
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
    chooseEvent(optionIndex: number) {
      const g = gameRef.current;
      processEvent(g, map, optionIndex);
      setGame({ ...g });
    },
    deferEventNow() {
      const g = gameRef.current;
      deferEvent(g);
      setGame({ ...g });
    },
    save() {
      if (saveGame(gameRef.current)) flash();
    },
    newGame() {
      if (!window.confirm('开始新游戏？当前进度将被覆盖。')) return;
      const g = newGameState('lorraine', (Date.now() >>> 0) % 0x7fffffff, map);
      clearSave();
      setSelectedProvince(null);
      setGame(g);
    },
  };

  return (
    <div className="app">
      <TopBar
        game={game}
        onSpeed={actions.setSpeed}
        onNation={actions.setNation}
        onSave={actions.save}
        onNewGame={actions.newGame}
        onOpenQueue={() => actions.setSpeed(0)}
      />
      <main className="main">
        <WorldMap
          map={map}
          game={game}
          selectedProvince={selectedProvince}
          onSelect={setSelectedProvince}
        />
        <NationPanel
          game={game}
          map={map}
          selectedProvince={selectedProvince}
          onTax={actions.setTax}
          onSpending={actions.setSpending}
          onRetrain={actions.retrain}
        />
      </main>
      <EventModal game={game} onChoose={actions.chooseEvent} onDefer={actions.deferEventNow} />
      {savedFlash && <div className="toast">已保存到本机</div>}
    </div>
  );
}
