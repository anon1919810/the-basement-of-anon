import { useCallback, useMemo, useState } from "react";
import { STOCKS } from "./game/stocks";
import { advanceDay, computeRanking } from "./game/engine";
import {
  cancelOrder,
  clearSave,
  computeAssets,
  createInitialState,
  loadState,
  placeLimitOrder,
  placeMarketOrder,
  saveState,
} from "./game/state";
import type { GameState, OrderKind, OrderSide } from "./game/types";
import TopBar from "./components/TopBar";
import MarketTable from "./components/MarketTable";
import PriceChart from "./components/PriceChart";
import TradePanel from "./components/TradePanel";
import HoldingsTable from "./components/HoldingsTable";
import NewsFeed from "./components/NewsFeed";
import SettlementModal from "./components/SettlementModal";

export default function App() {
  const [state, setState] = useState<GameState>(() => loadState() ?? createInitialState());
  const [selectedCode, setSelectedCode] = useState<string>(STOCKS[0].code);
  const [busy, setBusy] = useState(false);

  const assets = useMemo(() => computeAssets(state), [state]);
  const ret = assets / state.initialCash - 1;
  const ranking = useMemo(() => (state.phase === "settled" ? computeRanking(state) : []), [state]);

  const commit = useCallback((next: GameState) => {
    setState(next);
    saveState(next);
  }, []);

  const handleTrade = useCallback(
    (side: OrderSide, kind: OrderKind, qty: number, limitPrice?: number) => {
      const next = structuredClone(state);
      const result =
        kind === "market"
          ? placeMarketOrder(next, side, selectedCode, qty)
          : placeLimitOrder(next, side, selectedCode, qty, limitPrice ?? 0);
      if (result.ok) commit(next);
      return result;
    },
    [state, selectedCode, commit],
  );

  const handleCancelOrder = useCallback(
    (orderId: string) => {
      const next = structuredClone(state);
      cancelOrder(next, orderId);
      commit(next);
    },
    [state, commit],
  );

  const handleNextDay = useCallback(async () => {
    if (busy || state.phase === "settled") return;
    setBusy(true);
    try {
      const next = await advanceDay(state);
      commit(next);
    } finally {
      setBusy(false);
    }
  }, [busy, state, commit]);

  const handleNewGame = useCallback(() => {
    if (!window.confirm("确定开始新游戏？当前进度将被清除。")) return;
    clearSave();
    setState(createInitialState());
    setSelectedCode(STOCKS[0].code);
  }, []);

  return (
    <div className="app">
      <TopBar
        state={state}
        assets={assets}
        ret={ret}
        busy={busy}
        onNextDay={handleNextDay}
        onNewGame={handleNewGame}
      />
      <main className="main-grid">
        <aside className="panel">
          <MarketTable state={state} selectedCode={selectedCode} onSelect={setSelectedCode} />
        </aside>
        <section className="panel">
          <PriceChart state={state} code={selectedCode} />
        </section>
        <aside className="panel">
          <TradePanel
            state={state}
            code={selectedCode}
            onTrade={handleTrade}
            onCancelOrder={handleCancelOrder}
          />
        </aside>
      </main>
      <section className="bottom-grid">
        <div className="panel">
          <HoldingsTable state={state} onSelect={setSelectedCode} />
        </div>
        <div className="panel">
          <NewsFeed state={state} />
        </div>
      </section>
      {state.phase === "settled" && (
        <SettlementModal
          state={state}
          playerAssets={assets}
          playerRet={ret}
          ranking={ranking}
          onNewGame={handleNewGame}
        />
      )}
    </div>
  );
}
