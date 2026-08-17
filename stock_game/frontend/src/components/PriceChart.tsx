import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { fmtPct, fmtVol, lastBar } from "../game/util";
import type { GameState } from "../game/types";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  state: GameState;
  code: string;
}

export default function PriceChart({ state, code }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const market = state.market[code];

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !market) return;
    const history = market.history;
    const days = history.map((b) => `D${b.day}`);
    const closes = history.map((b) => b.close);
    const latest = lastBar(market);
    const up = latest.changePct >= 0;
    const color = up ? "#e03636" : "#17a05e";

    chart.setOption({
      animation: false,
      grid: { left: 52, right: 16, top: 40, bottom: 28 },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; data: number }>;
          const p = arr[0];
          if (!p) return "";
          const idx = days.indexOf(p.axisValue);
          const bar = history[idx];
          return `${p.axisValue}　收盘 <b>${p.data.toFixed(2)}</b><br/>${
            bar ? `涨跌幅 ${fmtPct(bar.changePct)}　成交量 ${fmtVol(bar.volume)}手` : ""
          }`;
        },
      },
      xAxis: {
        type: "category",
        data: days,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#b0b0b0" } },
        axisLabel: { fontSize: 10, color: "#666" },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { fontSize: 10, color: "#666" },
        splitLine: { lineStyle: { color: "#eee" } },
      },
      series: [
        {
          name: "收盘价",
          type: "line",
          data: closes,
          smooth: false,
          symbol: "none",
          lineStyle: { width: 1.5, color },
          areaStyle: { opacity: 0.06, color },
        },
      ],
    });
  }, [state, code, market]);

  return (
    <div className="panel-inner chart-panel">
      <h2 className="panel-title">
        {market ? market.def.name : code}{" "}
        <span className="sub">{market ? `${market.def.code} · ${market.def.sector}` : ""}</span>
      </h2>
      <div ref={ref} className="chart" />
    </div>
  );
}
