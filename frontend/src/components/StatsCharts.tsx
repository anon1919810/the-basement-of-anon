import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { Star } from 'lucide-react'

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export default function StatsCharts({ stats }: { stats: any }) {
  const catRef = useRef<HTMLDivElement>(null)
  const basinRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cleanups: Array<() => void> = []
    let mapCleanup: (() => void) | null = null

    function renderChart(el: HTMLDivElement | null, labels: string[], values: number[]) {
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
          minInterval: 1,
          splitLine: { lineStyle: { color: cssVar('--border', '#e6e8eb') } },
          axisLabel: { color: cssVar('--text-muted', '#6b7280'), fontSize: 11 },
        },
        series: [
          {
            type: 'bar',
            data: values,
            itemStyle: { color: '#3ecf8e' },
            barMaxWidth: 36,
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
        <div className="card-title">地域分布（按省级统计）</div>
        <div ref={mapRef} style={{ height: 340 }} />
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
