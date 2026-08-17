// 后端 API 调用：AI 新闻（失败时前端模板兜底，保证纯离线可玩）

import { generateFallbackNews } from "./news";
import type { NewsItem } from "./types";

const env = (import.meta as { env?: Record<string, string | undefined> }).env;
const API_BASE: string = env?.VITE_API_BASE ?? "http://localhost:8000";

interface BackendNews {
  title: string;
  summary?: string;
  impact_stock: string;
  impact_range: string;
  duration?: number;
  sector?: string;
}

function toNewsItem(day: number, n: BackendNews): NewsItem {
  const dur = Math.max(1, Math.min(5, Number(n.duration) || 1));
  const code = String(n.impact_stock).trim().split(/[,，、]/)[0].toUpperCase();
  return {
    id: `ai_${day}_${code}_${Math.random().toString(36).slice(2, 8)}`,
    day,
    title: String(n.title).slice(0, 60),
    summary: String(n.summary ?? "").slice(0, 200),
    impactStock: code,
    impactRange: String(n.impact_range).slice(0, 16),
    duration: dur,
    sector: n.sector ? String(n.sector).slice(0, 16) : undefined,
    source: "ai" as const,
    remaining: dur,
  };
}

/** 获取当日新闻：优先后端 AI，6 秒超时或任何失败则用内置模板 */
export async function fetchDailyNews(day: number, market: string): Promise<NewsItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(`${API_BASE}/api/news`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, market }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { news?: BackendNews[] };
    const list = (data.news ?? []).filter(
      (n) =>
        n &&
        typeof n.title === "string" &&
        n.title.trim() &&
        n.impact_stock &&
        n.impact_range,
    );
    if (list.length === 0) throw new Error("empty news from backend");
    return list.map((n) => toNewsItem(day, n));
  } catch {
    return generateFallbackNews(day);
  }
}
