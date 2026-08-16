import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, MapChart } from 'echarts/charts'
import { GeoComponent, GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { Star } from 'lucide-react'

// 按需注册（P2-15：整包 1.4MB → 核心+柱状图+地图 ≈ 400KB）
echarts.use([
  BarChart,
  LineChart,
  MapChart,
  GridComponent,
  GeoComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export default function StatsCharts({ stats }: { stats: any }) {
  const catRef = useRef<HTMLDivElement>(null)
  const basinRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const trendRef = useRef<HTMLDivElement>(null)
  const [drill, setDrill] = useState<string | null>(null)

  useEffect(() => {
    const cleanups: Array<() => void> = []
    let mapCleanup: (() => void) | null = null

    function renderChart(
      el: HTMLDivElement | null,
      labels: string[],
      values: number[],
      type: 'bar' | 'line' = 'bar',
    ) {
      if (!el || labels.length === 0) return
      const chart = echarts.init(el)
      chart.setOption({
        grid: { left: 8, right: 12, top: 18, bottom: 4, containLabel: true },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'category',
          data: labels,
          axisLine: { lineStyle: { color: cssVar('--border-strong', '#d0d3d7') } },
          axisTick: { show: false },
          axisLabel: { color: cssVar('--text-muted', '#6b7280'), fontSize: 11 },
        },
        yAxis: {
          type: 'value',
          minInterval: type === 'bar' ? 1 : undefined,
          splitLine: { lineStyle: { color: cssVar('--border', '#e6e8eb') } },
          axisLabel: { color: cssVar('--text-muted', '#6b7280'), fontSize: 11 },
        },
        series: [
          {
            type,
            data: values,
            itemStyle: { color: '#3ecf8e' },
            barMaxWidth: 36,
            lineStyle: { color: '#3ecf8e', width: 2 },
            areaStyle:
              type === 'line' ? { color: 'rgba(62,207,142,0.15)' } : undefined,
            smooth: type === 'line',
          },
        ],
      })
      const onResize = () => chart.resize()
      window.addEventListener('resize', onResize)
      cleanups.push(() => {
        window.removeEventListener('resize', onResize)
        chart.dispose()
      })
    }

    const cat = Object.entries(stats.category_distribution || {})
    const basin = Object.entries(stats.basin_distribution || {})
    renderChart(catRef.current, cat.map((x) => x[0] as string), cat.map((x) => x[1] as number))
    renderChart(basinRef.current, basin.map((x) => x[0] as string), basin.map((x) => x[1] as number))

    // 时间趋势（按月提取次数）
    const trend = Object.entries(stats.trend || {})
    renderChart(
      trendRef.current,
      trend.map((x) => x[0] as string),
      trend.map((x) => x[1] as number),
      'line',
    )

    // 中国地图（P1-5）：GeoJSON 从 public 加载，注册后渲染省域分布
    fetch('/china_provinces.json')
      .then((r) => r.json())
      .then((geo) => {
        const el = mapRef.current
        if (!el) return
        echarts.registerMap('china', geo)
        const chart = echarts.init(el)
        const entries2 = Object.entries(stats.province_distribution || {}).filter(([k]) => k !== '不详')
        const data = entries2.map(([k, v]) => ({ name: k, value: v as number }))
        const max = Math.max(...data.map((d) => d.value), 1)
        chart.setOption({
          tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}：${p.value ?? 0} 条` },
          visualMap: {
            min: 0,
            max,
            left: 8,
            bottom: 8,
            text: ['高', '低'],
            calculable: true,
            inRange: { color: ['#e6f7f0', '#3ecf8e', '#1f9d6c'] },
            textStyle: { color: cssVar('--text-muted', '#6b7280') },
          },
          series: [
            {
              type: 'map',
              map: 'china',
              roam: false,
              label: { show: false },
              itemStyle: { areaColor: '#f1f5f9', borderColor: cssVar('--border', '#e6e8eb') },
              emphasis: { label: { show: true }, itemStyle: { areaColor: '#2fbf83' } },
              data,
            },
          ],
        })
        const onResize = () => chart.resize()
        window.addEventListener('resize', onResize)
        mapCleanup = () => {
          window.removeEventListener('resize', onResize)
          chart.dispose()
        }
        // 地图下钻：点击省份 → 市级分布
        chart.on('click', (p: any) => {
          if (p && p.name && p.name !== '不详') setDrill(p.name)
        })
      })
      .catch(() => {
        /* 地图加载失败时静默（其他图表不受影响） */
      })

    return () => {
      cleanups.forEach((fn) => fn())
      mapCleanup?.()
    }
  }, [stats])

  const total = Number(stats.total_records) || 0
  const avg = total > 0 ? (Number(stats.total_entries) / total).toFixed(1) : '-'
  const overview = [
    { label: '提取记录', value: String(stats.total_records ?? 0) },
    { label: '总条目', value: String(stats.total_entries ?? 0) },
    { label: '平均每次', value: avg },
  ]
  const highRated = stats.high_rated || []

  return (
    <div className="mt-3">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
        {overview.map((o) => (
          <div
            key={o.label}
            style={{
              border: '1px solid var(--border)',
              padding: '12px 14px',
              background: 'var(--bg)',
            }}
          >
            <div className="muted" style={{ fontSize: 12 }}>
              {o.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 650, marginTop: 2 }}>{o.value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="card-title">提取趋势（按月）</div>
        <div ref={trendRef} style={{ height: 200 }} />
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div>
          <div className="card-title">类别分布</div>
          <div ref={catRef} style={{ height: 220 }} />
        </div>
        <div>
          <div className="card-title">流域分布</div>
          <div ref={basinRef} style={{ height: 220 }} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="card-title">地域分布（按省级统计，点击省份下钻）</div>
        <div ref={mapRef} style={{ height: 340 }} />
        {drill && (
          <div style={{ marginTop: 12 }}>
            <div className="card-title">
              {drill} · 市级分布
              <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setDrill(null)}>
                返回省级
              </button>
            </div>
            {(() => {
              const cities = (stats.city_distribution || {})[drill] || {}
              const arr = Object.entries(cities)
              const max = Math.max(...arr.map(([, v]) => v as number), 1)
              return arr.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>
                  暂无市级数据
                </div>
              ) : (
                <div className="space-y-1">
                  {arr.map(([c, v]) => (
                    <div
                      key={c}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                    >
                      <span style={{ width: 90, flexShrink: 0 }}>{c}</span>
                      <div
                        style={{
                          flex: 1,
                          height: 14,
                          background: 'var(--bg-subtle)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div
                          style={{
                            width: `${((v as number) / max) * 100}%`,
                            height: '100%',
                            background: '#3ecf8e',
                          }}
                        />
                      </div>
                      <span className="muted" style={{ width: 40, textAlign: 'right' }}>
                        {String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="card-title">条目热度榜（Top 10）</div>
        {Object.keys(stats.hot_entries || {}).length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            暂无数据
          </div>
        ) : (
          <div className="space-y-1">
            {Object.entries(stats.hot_entries).map(([name, cnt], i) => (
              <div
                key={name}
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
              >
                <span className="muted" style={{ width: 22 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1 }}>{name}</span>
                <span className="chip chip-green">{String(cnt)} 次</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="card-title">
          <span className="titled-icon">
            <Star size={14} />
            高分提取（≥8分）
          </span>
        </div>
        {highRated.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            还没有高分记录
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>用户名</th>
                <th>书名</th>
                <th>条数</th>
                <th>评分</th>
              </tr>
            </thead>
            <tbody>
              {highRated.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.username}</td>
                  <td>{x.book_name}</td>
                  <td>{x.entry_count}</td>
                  <td>{x.rating}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
