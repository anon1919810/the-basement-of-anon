import { useCallback, useMemo, useState } from "react";
import { STOCKS } from "./game/stocks";
import { advanceDay } from "./game/engine";
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
import { openShort, coverShort } from "./game/short";
import type { GameState, OrderKind, OrderSide, TunableParams } from "./game/types";
import TopBar from "./components/TopBar";
import MarketTable from "./components/MarketTable";
import CandleChart from "./components/CandleChart";
import TradePanel from "./components/TradePanel";
import HoldingsTable from "./components/HoldingsTable";
import NewsFeed from "./components/NewsFeed";
import PortfolioCharts from "./components/PortfolioCharts";
import TradeLog from "./components/TradeLog";
import ReportModal from "./components/ReportModal";
import TuningPanel from "./components/TuningPanel";

export default function App() {
  const [state, setState] = useState<GameState>(() => loadState() ?? createInitialState());
  const [selectedCode, setSelectedCode] = useState<string>(STOCKS[0].code);
  const [busy, setBusy] = useState(false);
  const [tuningOpen, setTuningOpen] = useState(false);

  const assets = useMemo(() => computeAssets(state), [state]);
  const ret = assets / state.initialCash - 1;

  const commit = useCallback((next: GameState) => {
    setState(next);
    saveState(next);
  }, []);

  const handleTrade = useCallback(
    (side: OrderSide, kind: OrderKind, qty: number, limitPrice?: number) => {
      const next = structuredClone(state);
      let result;
      if (side === "short") {
        result = openShort(next, selectedCode, qty);
      } else if (side === "cover") {
        result = coverShort(next, selectedCode, qty);
      } else {
        result =
          kind === "market"
            ? placeMarketOrder(next, side, selectedCode, qty)
            : placeLimitOrder(next, side === "buy" ? "buy" : "sell", selectedCode, qty, limitPrice ?? 0);
      }
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
    setTuningOpen(false);
  }, []);

  const handleTuningApply = useCallback(
    (params: TunableParams) => {
      const next = structuredClone(state);
      next.pendingParams = { ...params };
      commit(next);
      setTuningOpen(false);
    },
    [state, commit],
  );

  return (
    <div className="app">
      <TopBar
        state={state}
        assets={assets}
        ret={ret}
        busy={busy}
        onNextDay={handleNextDay}
        onNewGame={handleNewGame}
        onOpenTuning={() => setTuningOpen(true)}
      />
      <main className="main-grid">
        <aside className="panel">
          <MarketTable state={state} selectedCode={selectedCode} onSelect={setSelectedCode} />
        </aside>
        <section className="panel">
          <CandleChart state={state} code={selectedCode} />
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
      <section className="charts-grid">
        <div className="panel">
          <PortfolioCharts state={state} />
        </div>
      </section>
      <section className="bottom-grid bottom-grid-3">
        <div className="panel">
          <HoldingsTable state={state} onSelect={setSelectedCode} />
        </div>
        <div className="panel">
          <NewsFeed state={state} />
        </div>
        <div className="panel">
          <TradeLog state={state} />
        </div>
      </section>
      {tuningOpen && (
        <TuningPanel
          current={state.params}
          pending={state.pendingParams}
          onApply={handleTuningApply}
          onClose={() => setTuningOpen(false)}
        />
      )}
      {state.phase === "settled" && state.report && (
        <ReportModal state={state} report={state.report} onNewGame={handleNewGame} />
      )}
    </div>
  );
}
