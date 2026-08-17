import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { CandlestickChart, BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { fmtPct, fmtVol, lastBar } from "../game/util";
import type { GameState } from "../game/types";

echarts.use([
  CandlestickChart,
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

interface Props {
  state: GameState;
  code: string;
}

const UP = "#e03636";
const DOWN = "#17a05e";
const RETAIL_COLOR = "#8a8f98";
const INST_COLOR = "#1f6feb";
const HOT_COLOR = "#d98a00";

export default function CandleChart({ state, code }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const market = state.market[code];
  const index = state.indices[code];
  const isIndex = !market && !!index;

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
    if (!chart) return;

    // 指数 → 折线
    if (isIndex && index) {
      const history = index.history;
      const days = history.map((b) => `D${b.day}`);
      const closes = history.map((b) => b.close);
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
              bar ? `涨跌幅 ${fmtPct(bar.changePct)}` : ""
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
            name: index.def.name,
            type: "line",
            data: closes,
            symbol: "none",
            lineStyle: { width: 1.6, color: INST_COLOR },
          },
        ],
      });
      return;
    }

    if (!market) return;
    const history = market.history;
    const days = history.map((b) => `D${b.day}`);
    const kdata = history.map((b) => [b.open ?? b.close, b.close, b.low, b.high]);
    const retailData = history.map((b) => b.volBreakdown?.retail ?? 0);
    const instData = history.map((b) => b.volBreakdown?.inst ?? 0);
    const hotData = history.map((b) => b.volBreakdown?.hot ?? 0);

    chart.setOption({
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; data: unknown; seriesName: string; color: string }>;
          if (arr.length === 0) return "";
          const idx = days.indexOf(arr[0].axisValue);
          const bar = history[idx];
          if (!bar) return "";
          const vol = bar.volBreakdown;
          const volText = vol
            ? `散户 ${fmtVol(vol.retail)} / 机构 ${fmtVol(vol.inst)} / 游资 ${fmtVol(vol.hot)}手`
            : `成交量 ${fmtVol(bar.volume)}手`;
          return [
            `${arr[0].axisValue}`,
            `开 ${(bar.open ?? bar.close).toFixed(2)}　收 <b>${bar.close.toFixed(2)}</b>`,
            `高 ${bar.high.toFixed(2)}　低 ${bar.low.toFixed(2)}`,
            `涨跌幅 ${fmtPct(bar.changePct)}　${volText}`,
          ].join("<br/>");
        },
      },
      legend: {
        data: ["K线", "散户", "机构", "游资"],
        top: 4,
        left: 8,
        textStyle: { fontSize: 10, color: "#666" },
      },
      grid: [
        { left: 52, right: 16, top: 44, height: "58%" },
        { left: 52, right: 16, top: "74%", height: "18%" },
      ],
      xAxis: [
        {
          type: "category",
          data: days,
          boundaryGap: true,
          axisLine: { lineStyle: { color: "#b0b0b0" } },
          axisLabel: { fontSize: 10, color: "#666" },
          axisTick: { show: false },
        },
        {
          type: "category",
          gridIndex: 1,
          data: days,
          boundaryGap: true,
          axisLine: { lineStyle: { color: "#b0b0b0" } },
          axisLabel: { show: false },
          axisTick: { show: false },
        },
      ],
      yAxis: [
        {
          type: "value",
          scale: true,
          axisLabel: { fontSize: 10, color: "#666" },
          splitLine: { lineStyle: { color: "#eee" } },
        },
        {
          type: "value",
          gridIndex: 1,
          axisLabel: { fontSize: 9, color: "#999" },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], start: 0, end: 100 },
        { type: "slider", xAxisIndex: [0, 1], start: 0, end: 100, height: 14, bottom: 2 },
      ],
      series: [
        {
          name: "K线",
          type: "candlestick",
          data: kdata,
          itemStyle: {
            color: UP,
            color0: DOWN,
            borderColor: UP,
            borderColor0: DOWN,
          },
        },
        {
          name: "散户",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: retailData,
          stack: "vol",
          itemStyle: { color: RETAIL_COLOR },
          barWidth: "70%",
        },
        {
          name: "机构",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: instData,
          stack: "vol",
          itemStyle: { color: INST_COLOR },
          barWidth: "70%",
        },
        {
          name: "游资",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: hotData,
          stack: "vol",
          itemStyle: { color: HOT_COLOR },
          barWidth: "70%",
        },
      ],
    });
  }, [state, code, market, index, isIndex]);

  const title = market ? market.def.name : index ? index.def.name : code;
  const sub = market
    ? `${market.def.code} · ${market.def.kind === "stock" ? market.def.sector : market.def.kind === "bond" ? "债券" : "商品"}`
    : index
      ? `${index.def.code} · 指数（不可交易）`
      : "";

  return (
    <div className="panel-inner chart-panel">
      <h2 className="panel-title">
        {title} <span className="sub">{sub}</span>
        {market && market.def.kind === "stock" && (
          <span className="chart-hint">日K · 成交量按 散户/机构/游资 拆分</span>
        )}
      </h2>
      <div ref={ref} className="chart" />
      <div className="vol-legend">
        <span className="vl-item"><i style={{ background: RETAIL_COLOR }} />散户</span>
        <span className="vl-item"><i style={{ background: INST_COLOR }} />机构</span>
        <span className="vl-item"><i style={{ background: HOT_COLOR }} />游资</span>
      </div>
      {market && (
        <div className="chart-latest">
          最新 {lastBar(market).close.toFixed(2)}（{fmtPct(lastBar(market).changePct)}） · 成交量{" "}
          {fmtVol(lastBar(market).volume)} 手
        </div>
      )}
    </div>
  );
}
