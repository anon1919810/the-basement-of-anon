/**
 * v0.7 迷你图表（ECharts 按需引入）：
 * 只注册 LineChart/BarChart/PieChart + Grid/Tooltip/Legend/Title + CanvasRenderer，
 * 其余组件不打包（tree-shaking）。主题色走 CSS 变量（亮/暗模式自适应）。
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
]);

/** 读取 CSS 变量（亮/暗模式自适应；返回原始字符串） */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 生成与主题一致的通用图表 option 基底 */
export function themedBase(): { text: string; dim: string; line: string; accent: string; grid: string } {
  return {
    text: cssVar('--text', '#2b2b28'),
    dim: cssVar('--text-dim', '#8a8a84'),
    line: cssVar('--line-soft', '#ececea'),
    accent: cssVar('--accent', '#2f7d45'),
    grid: cssVar('--glass-bg', '#ffffff'),
  };
}

interface Props {
  option: EChartsOption;
  height?: number;
}

export default function MiniChart({ option, height = 96 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  // 初始化一次（含 ResizeObserver 自适应）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el);
    instRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      inst.dispose();
      instRef.current = null;
    };
  }, []);

  // 数据/主题变化 → 全量替换 option
  useEffect(() => {
    instRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} className="mini-chart" style={{ height }} />;
}
