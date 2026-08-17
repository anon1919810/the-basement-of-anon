import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { lastClose } from "../game/util";
import type { GameState } from "../game/types";

echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

interface Props {
  state: GameState;
}

const PLAYER_COLOR = "#1f6feb";
const INST_COLOR = "#d98a00";
const INDEX_COLOR = "#7a808a";

const SECTOR_COLORS: Record<string, string> = {
  科技: "#1f6feb",
  消费: "#d9822b",
  能源: "#8a5a00",
  医药: "#2f9e8f",
  金融: "#7048b8",
  原材料: "#5f6b7a",
  公用事业: "#2b8a3e",
  债券: "#0b7285",
  商品: "#c92a2a",
};

export default function PortfolioCharts({ state }: Props) {
  const netRef = useRef<HTMLDivElement | null>(null);
  const netChart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const pieRef = useRef<HTMLDivElement | null>(null);
  const pieChart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [pieView, setPieView] = useState<"sector" | "stock">("sector");

  // 净值曲线
  useEffect(() => {
    if (!netRef.current) return;
    const chart = echarts.init(netRef.current);
    netChart.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      netChart.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = netChart.current;
    if (!chart) return;
    const player = state.playerHistory.map((p) => round1((p.assets / state.initialCash) * 100));
    const inst = state.institutionAvgHistory.map((p) => round1((p.assets / state.initialCash) * 100));
    const fcx = state.indices["FCX"]?.history ?? [];
    const days = fcx.map((b) => `D${b.day}`);
    const indexSeries = fcx.map((b) => round1(b.close));
    // 补齐天数（三者应一致）
    const n = Math.max(player.length, inst.length, days.length);
    chart.setOption({
      animation: false,
      color: [PLAYER_COLOR, INST_COLOR, INDEX_COLOR],
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; seriesName: string; data: number }>;
          const lines = arr.map((p) => `${p.seriesName}: <b>${p.data.toFixed(1)}</b>`);
          return `${arr[0]?.axisValue ?? ""}<br/>${lines.join("<br/>")}`;
        },
      },
      legend: { data: ["玩家", "机构平均", "覆巢指数"], top: 4, textStyle: { fontSize: 10, color: "#666" } },
      grid: { left: 44, right: 14, top: 34, bottom: 24 },
      xAxis: {
        type: "category",
        data: days.length >= n ? days : Array.from({ length: n }, (_, i) => `D${i}`),
        boundaryGap: false,
        axisLabel: { fontSize: 9, color: "#999" },
        axisLine: { lineStyle: { color: "#b0b0b0" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { fontSize: 9, color: "#999" },
        splitLine: { lineStyle: { color: "#eee" } },
      },
      series: [
        { name: "玩家", type: "line", data: player, symbol: "none", lineStyle: { width: 1.8, color: PLAYER_COLOR } },
        { name: "机构平均", type: "line", data: inst, symbol: "none", lineStyle: { width: 1.4, color: INST_COLOR } },
        { name: "覆巢指数", type: "line", data: indexSeries, symbol: "none", lineStyle: { width: 1.2, color: INDEX_COLOR, type: "dashed" } },
      ],
    });
  }, [state]);

  // 持仓饼图
  useEffect(() => {
    if (!pieRef.current) return;
    const chart = echarts.init(pieRef.current);
    pieChart.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      pieChart.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = pieChart.current;
    if (!chart) return;
    const longs = state.holdings.map((h) => {
      const def = state.market[h.code]?.def;
      const price = lastClose(state.market[h.code]);
      return { code: h.code, name: def?.name ?? h.code, sector: def?.sector ?? "其他", value: h.qty * price };
    });
    let data: { name: string; value: number; itemStyle?: { color: string } }[];
    if (pieView === "sector") {
      const map = new Map<string, number>();
      for (const l of longs) map.set(l.sector, (map.get(l.sector) ?? 0) + l.value);
      data = [...map.entries()]
        .map(([name, value]) => ({ name, value, itemStyle: { color: SECTOR_COLORS[name] ?? "#999" } }))
        .filter((d) => d.value > 0);
    } else {
      data = longs
        .map((l) => ({ name: l.name, value: l.value, itemStyle: { color: SECTOR_COLORS[l.sector] ?? "#999" } }))
        .filter((d) => d.value > 0);
    }
    chart.setOption({
      animation: false,
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}: <b>${p.value.toFixed(2)}</b>（${p.percent.toFixed(1)}%）`;
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: "#666" } },
      series: [
        {
          type: "pie",
          radius: ["38%", "68%"],
          center: ["50%", "46%"],
          data,
          label: { fontSize: 10, formatter: "{b}\n{d}%" },
        },
      ],
    });
  }, [state, pieView]);

  return (
    <div className="panel-inner">
      <h2 className="panel-title">净值与持仓</h2>
      <div className="charts-duo">
        <div className="duo-block">
          <h3 className="sub-title">净值曲线（起点 = 100）</h3>
          <div ref={netRef} className="chart-sm" />
        </div>
        <div className="duo-block">
          <h3 className="sub-title">
            持仓分布
            <span className="seg seg-sm">
              <button className={`seg-btn ${pieView === "sector" ? "active" : ""}`} onClick={() => setPieView("sector")}>
                按行业
              </button>
              <button className={`seg-btn ${pieView === "stock" ? "active" : ""}`} onClick={() => setPieView("stock")}>
                按个股
              </button>
            </span>
          </h3>
          {state.holdings.length === 0 ? (
            <div className="empty">暂无多头持仓（饼图仅统计多头）</div>
          ) : (
            <div ref={pieRef} className="chart-sm" />
          )}
        </div>
      </div>
    </div>
  );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
