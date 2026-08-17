import { useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Brain,
  Check,
  FileSpreadsheet,
  FileText,
  History as HistoryIcon,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Table2,
  Upload,
  Wand2,
} from 'lucide-react'
import { api, apiBlob, apiSSE } from '../lib/api'
import { toast } from '../lib/toast'
import StatsCharts from '../components/StatsCharts'

interface Entry {
  名称: string
  类别: string
  时间?: string
  空间?: string
  流域?: string
  基础信息?: string
  历史文献?: string
}

const _PROV_RE = /^(.*?省|重庆市|上海市)/
const _CITY_PROV = ['重庆市', '上海市', '北京市', '天津市']

/** 从当前条目构建"本次提取"统计对象（与后端 /api/stats 同构） */
function buildLocalStats(entries: Entry[]): any {
  const cat: Record<string, number> = {}
  const basin: Record<string, number> = {}
  const prov: Record<string, number> = {}
  const city: Record<string, Record<string, number>> = {}
  const hot: Record<string, number> = {}
  for (const e of entries) {
    const c = e.类别 || '不详'
    cat[c] = (cat[c] || 0) + 1
    const b = e.流域 || '不详'
    basin[b] = (basin[b] || 0) + 1
    const n = (e.名称 || '').trim()
    if (n) hot[n] = (hot[n] || 0) + 1
    const sp = String(e.空间 || '')
    const m = sp.match(_PROV_RE)
    const p = m ? m[1] : '不详'
    if (p !== '不详') {
      prov[p] = (prov[p] || 0) + 1
      let cty: string | null = null
      if (_CITY_PROV.includes(p)) {
        const cm = sp.match(/([\u4e00-\u9fff]{2,4}区)/)
        cty = cm ? cm[1] : p
      } else {
        const cm = sp.match(/([\u4e00-\u9fff]+?市)/)
        cty = cm ? cm[1] : p
      }
      if (cty) {
        city[p] = city[p] || {}
        city[p][cty] = (city[p][cty] || 0) + 1
      }
    }
  }
  const hotSorted = Object.entries(hot).sort((a, b) => b[1] - a[1]).slice(0, 10)
  return {
    total_records: 1,
    total_entries: entries.length,
    category_distribution: cat,
    basin_distribution: basin,
    province_distribution: prov,
    city_distribution: city,
    hot_entries: Object.fromEntries(hotSorted),
    trend: {},
    high_rated: [],
    user_stats: [],
    recent: [],
  }
}

export default function Workbench() {
  // ---- 上传提取（支持多文件） ----
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [bookName, setBookName] = useState('')
  const [maxOnly, setMaxOnly] = useState(true)
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [recordId, setRecordId] = useState<number | null>(null)

  // ---- 表格在线编辑 ----
  const [editing, setEditing] = useState<{ row: number; field: string } | null>(null)
  const [draft, setDraft] = useState('')

  // ---- AI 工作台 ----
  const [selName, setSelName] = useState('')
  const [supplement, setSupplement] = useState('')
  const [chatQ, setChatQ] = useState('')
  const [chatLog, setChatLog] = useState<{ role: string; content: string }[]>([])
  const [chatBusy, setChatBusy] = useState(false)

  // ---- 评分 ----
  const [rating, setRating] = useState<number>(9)
  const [ratingMsg, setRatingMsg] = useState('')

  // ---- 留言板 / 统计 ----
  const [messages, setMessages] = useState<any[]>([])
  const [msgText, setMsgText] = useState('')
  const [stats, setStats] = useState<any>(null)
  const [statsMode, setStatsMode] = useState<'all' | 'current'>('all')

  const localStats = useMemo(() => (entries ? buildLocalStats(entries) : null), [entries])

  // ---- 提取历史 ----
  const [history, setHistory] = useState<any[]>([])

  const fileRef = useRef<HTMLInputElement>(null)

  async function doExtract() {
    setErr('')
    if (!files.length) {
      setErr('请先选择 PDF 或 Word 文件')
      return
    }
    setBusy(true)
    setEntries(null)
    setRecordId(null)
    setStage('准备上传…')
    const fd = new FormData()
    fd.append('book_name', bookName)
    fd.append('extract_max_only', maxOnly ? 'true' : 'false')
    files.forEach((f) => fd.append('files', f))
    try {
      await apiSSE('/api/extract/stream', fd, false, (e) => {
        if (e.type === 'stage') setStage(e.message || e.stage)
        else if (e.type === 'done') {
          setEntries(e.entries)
          setRecordId(e.record_id)
          setStage(`完成：共 ${e.entry_count} 条`)
          toast(`提取完成：共 ${e.entry_count} 条`, 'success')
        } else if (e.type === 'error') {
          setErr(e.detail || '提取失败')
          setStage('')
        }
      })
    } catch (e: any) {
      setErr(e.message || '提取失败')
      setStage('')
    } finally {
      setBusy(false)
    }
  }

  async function doSupplement() {
    setErr('')
    if (!entries || !selName) return
    const row = entries.find((e) => e.名称 === selName)
    if (!row) return
    try {
      const r = await api('/api/chat/supplement', {
        method: 'POST',
        body: JSON.stringify({
          name: row.名称,
          category: row.类别 || '',
          time: row.时间 || '',
          space: row.空间 || '',
          info: row.基础信息 || '',
          quote: row.历史文献 || '',
        }),
      })
      setSupplement(r.reply)
    } catch (e: any) {
      setErr(e.message || 'AI 补充失败')
    }
  }

  function applySupplement() {
    if (!entries || !selName || !supplement) return
    setEntries(entries.map((e) => (e.名称 === selName ? { ...e, 基础信息: supplement } : e)))
    setSupplement('')
    toast('已写入该条目的基础信息', 'success')
  }

  async function sendChat() {
    const q = chatQ.trim()
    if (!q || chatBusy) return
    setChatQ('')
    setChatBusy(true)
    const hist = [...chatLog, { role: 'user', content: q }]
    setChatLog([...hist, { role: 'assistant', content: '' }])
    let acc = ''
    try {
      await apiSSE(
        '/api/chat',
        JSON.stringify({ messages: hist }),
        true,
        (e) => {
          if (e.type === 'delta') {
            acc += e.content
            setChatLog([...hist, { role: 'assistant', content: acc }])
          } else if (e.type === 'error') {
            setErr(e.detail || '对话失败')
          }
        },
      )
    } catch (e: any) {
      setErr(e.message || '对话失败')
    } finally {
      setChatBusy(false)
    }
  }

  async function doRate() {
    if (!recordId) return
    try {
      await api('/api/rating', {
        method: 'POST',
        body: JSON.stringify({ record_id: recordId, rating, feedback: '' }),
      })
      setRatingMsg('评分已保存 ✅')
      toast('评分已保存', 'success')
    } catch (e: any) {
      setRatingMsg(e.message || '评分失败')
    }
  }

  async function loadMessages() {
    try {
      const r = await api('/api/messages')
      setMessages(r.messages)
    } catch (e: any) {
      setErr(e.message)
    }
  }

  async function postMessage() {
    const c = msgText.trim()
    if (!c) return
    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ content: c }) })
      setMsgText('')
      toast('留言成功', 'success')
      loadMessages()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  async function deleteMessage(id: number) {
    try {
      await api(`/api/messages/${id}`, { method: 'DELETE' })
      loadMessages()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  async function loadStats() {
    try {
      const r = await api('/api/stats')
      setStats(r)
    } catch (e: any) {
      setErr(e.message)
    }
  }

  function exportExcel() {
    if (!entries || entries.length === 0) return
    apiBlob('/api/extract/export', { book_name: bookName, entries })
      .then((blob) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${bookName || '文化要素提取结果'}.xlsx`
        a.click()
        toast('已导出 Excel', 'success')
      })
      .catch((e: any) => toast(e.message || '导出失败', 'error'))
  }

  function downloadText(name: string, content: string) {
    const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
  }

  // GB/T 7714 参考文献格式
  function exportGbt() {
    if (!entries || !entries.length) return
    const lines = entries.map(
      (e, i) =>
        `${i + 1}. ${e.名称}[M]//${bookName || '地方志'}．${e.时间 || ''}．${e.空间 || ''}．${e.基础信息 || ''}`,
    )
    downloadText(`${bookName || '引用'}-GB-T7714.txt`, lines.join('\n'))
    toast('已导出 GB/T 7714 引用', 'success')
  }

  // RIS（可导入 Zotero / EndNote）
  function exportRis() {
    if (!entries || !entries.length) return
    const lines = ['TY - GEN', `T1 - ${bookName || '地方志'} 文化要素`]
    entries.forEach((e) => {
      lines.push(`N1 - ${e.名称}：${e.基础信息 || ''}（${e.时间 || ''}；${e.空间 || ''}）`)
    })
    lines.push('ER - ')
    downloadText(`${bookName || '引用'}.ris`, lines.join('\n'))
    toast('已导出 RIS（可导入 Zotero/EndNote）', 'success')
  }

  async function loadHistory() {
    try {
      const r = await api('/api/extract/history')
      setHistory(r.items)
    } catch (e: any) {
      toast(e.message || '加载历史失败', 'error')
    }
  }

  async function viewHistory(id: number) {
    try {
      const r = await api(`/api/extract/history/${id}`)
      setEntries(r.entries)
      setBookName(r.book_name || '')
      setRecordId(id)
      toast(`已载入 ${r.entries.length} 条（记录 #${id}）`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  async function delHistory(id: number) {
    try {
      await api(`/api/extract/history/${id}`, { method: 'DELETE' })
      toast('已删除记录', 'success')
      loadHistory()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  function startEdit(row: number, field: string, value: string) {
    setEditing({ row, field })
    setDraft(value ?? '')
  }

  function commitEdit() {
    if (!editing || !entries) {
      setEditing(null)
      return
    }
    const { row, field } = editing
    setEntries(entries.map((e, i) => (i === row ? { ...e, [field]: draft } : e)))
    setEditing(null)
    toast('已修改', 'success')
  }

  return (
    <div className="space-y-6">
      {err && <div className="notice-error">{err}</div>}

      {/* ---------- 上传提取 ---------- */}
      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <Upload size={15} />
            上传文献提取
          </span>
        </h2>
        <div className="space-y-3">
          <input
            className="input"
            data-tour="book"
            placeholder="书名（如：武汉市志 文物志）"
            value={bookName}
            onChange={(e) => setBookName(e.target.value)}
          />
          <div
            className={`dropzone ${dragOver ? 'over' : ''}`}
            data-tour="upload"
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const dropped = Array.from(e.dataTransfer.files ?? [])
              if (dropped.length) setFiles(dropped)
            }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.doc"
              multiple
              hidden
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {files.length ? (
              <span className="btn-icon" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                <FileText size={15} />
                {files.length} 个文件：
                {files.slice(0, 3).map((f) => (
                  <span key={f.name} className="chip">
                    {f.name}
                  </span>
                ))}
                {files.length > 3 && <span className="chip">+{files.length - 3}</span>}
                <button
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFiles([])
                    if (fileRef.current) fileRef.current.value = ''
                  }}
                >
                  清除
                </button>
              </span>
            ) : (
              <span className="btn-icon" style={{ justifyContent: 'center' }}>
                <Upload size={16} />
                拖拽 PDF / Word 到这里，或点击选择（支持多选）
              </span>
            )}
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-neutral-600" data-tour="maxonly">
          <input type="checkbox" checked={maxOnly} onChange={(e) => setMaxOnly(e.target.checked)} />
          仅提取最大子目（推荐）
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-accent btn-icon" data-tour="extract" disabled={busy} onClick={doExtract}>
            <Sparkles size={14} />
            {busy ? '提取中…' : '开始提取'}
          </button>
          {stage && <span className="text-sm text-[#1f9d6c]">{stage}</span>}
        </div>
      </section>

      {/* ---------- 提取中骨架屏 ---------- */}
      {busy && (
        <section className="card">
          <div className="card-title">正在提取，请稍候…</div>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton" style={{ height: 18 }} />
            ))}
          </div>
        </section>
      )}

      {/* ---------- 空状态引导 ---------- */}
      {!entries && !busy && (
        <div className="empty-state">
          <div className="empty-icon">📄</div>
          上传 PDF / Word 文献，填写书名后点击「开始提取」
          <br />
          AI 将为你梳理物质 / 精神 / 制度 / 行为 / 心理五类文化要素
        </div>
      )}

      {/* ---------- 结果 ---------- */}
      {entries && (
        <section className="card">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="card-title" style={{ marginBottom: 0 }}>
              <span className="titled-icon">
                <Table2 size={15} />
                提取结果（{entries.length} 条）
              </span>
            </h2>
            <button className="btn btn-accent btn-icon" onClick={exportExcel}>
              <FileSpreadsheet size={14} />
              导出 Excel
            </button>
            <button className="btn btn-icon btn-sm" onClick={exportGbt}>
              <FileText size={13} />
              GB/T 引用
            </button>
            <button className="btn btn-icon btn-sm" onClick={exportRis}>
              <FileText size={13} />
              RIS
            </button>
            {recordId && (
              <span className="flex items-center gap-2 text-sm">
                评分：
                <select className="input !w-16 !py-1" value={rating}
                        onChange={(e) => setRating(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="btn btn-icon btn-sm" onClick={doRate}>
                  <Star size={13} />
                  保存评分
                </button>
                {ratingMsg && <span className="text-xs text-neutral-400">{ratingMsg}</span>}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>名称</th><th>类别</th><th>时间</th><th>空间</th>
                  <th>流域</th><th>基础信息</th><th>历史文献</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td className="font-medium">{e.名称}</td>
                    {(['类别', '时间', '空间', '流域', '基础信息'] as const).map((f) => {
                      const editingThis = editing && editing.row === i && editing.field === f
                      return (
                        <td
                          key={f}
                          onClick={() => !editingThis && startEdit(i, f, String((e as any)[f] ?? ''))}
                          style={{ cursor: 'text', minWidth: f === '基础信息' ? 200 : undefined }}
                        >
                          {editingThis ? (
                            <input
                              className="input"
                              autoFocus
                              value={draft}
                              onChange={(ev) => setDraft(ev.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(ev) => {
                                if (ev.key === 'Enter') commitEdit()
                                if (ev.key === 'Escape') setEditing(null)
                              }}
                            />
                          ) : (
                            <span title="点击编辑">{(e as any)[f] ?? '—'}</span>
                          )}
                        </td>
                      )
                    })}
                    <td>{e.历史文献 ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---------- AI 工作台 ---------- */}
      <section className="card" data-tour="ai">
        <h2 className="card-title">
          <span className="titled-icon">
            <Brain size={15} />
            AI 工作台
          </span>
        </h2>
        {entries && entries.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select className="input !w-56" value={selName}
                    onChange={(e) => { setSelName(e.target.value); setSupplement('') }}>
              <option value="">选择要补充的条目</option>
              {entries.map((e) => <option key={e.名称} value={e.名称}>{e.名称}</option>)}
            </select>
            <button className="btn btn-icon" onClick={doSupplement}>
              <Wand2 size={14} />
              AI 补充基础信息
            </button>
            {supplement && (
              <>
                <div className="w-full supplement-box p-3 text-sm">
                  {supplement}
                </div>
                <button className="btn btn-accent btn-icon" onClick={applySupplement}>
                  <Check size={14} />
                  写入该条目
                </button>
              </>
            )}
          </div>
        )}
        <div className="space-y-2">
          {chatLog.map((m, i) => (
            <div key={i} className={`text-sm ${m.role === 'user' ? 'text-right' : ''}`}>
              <span className={`inline-block max-w-[80%] px-3 py-2 ${
                m.role === 'user' ? 'border border-[#3ecf8e] bg-[#3ecf8e]/10' : 'bubble-assistant'
              }`}>
                {m.content || '…'}
              </span>
            </div>
          ))}
          <div className="flex gap-2">
            <input className="input" placeholder="向 AI 提问（如：盘龙城遗址的发现过程？）"
                   value={chatQ} onChange={(e) => setChatQ(e.target.value)}
                   onKeyDown={(e) => e.key === 'Enter' && sendChat()} />
            <button className="btn btn-icon" disabled={chatBusy} onClick={sendChat}>
              <Send size={14} />
              发送
            </button>
          </div>
        </div>
      </section>

      {/* ---------- 统计看板 ---------- */}
      <section className="card" data-tour="stats">
        <h2 className="card-title">
          <span className="titled-icon">
            <BarChart3 size={15} />
            统计看板
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
          <button
            className={`btn btn-sm ${statsMode === 'current' ? 'btn-accent' : ''}`}
            onClick={() => setStatsMode('current')}
          >
            本次提取
          </button>
          <button
            className={`btn btn-sm ${statsMode === 'all' ? 'btn-accent' : ''}`}
            onClick={() => setStatsMode('all')}
          >
            全部数据
          </button>
          {statsMode === 'all' && (
            <button className="btn btn-icon btn-sm" onClick={loadStats}>
              <RefreshCw size={13} />
              加载统计
            </button>
          )}
        </div>
        {statsMode === 'current' ? (
          localStats ? (
            <StatsCharts stats={localStats} />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">📊</div>
              先完成一次提取，查看本次提取的统计
            </div>
          )
        ) : stats ? (
          <StatsCharts stats={stats} />
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            点击「加载统计」查看全部提取数据（类别 / 流域 / 地域分布）
          </div>
        )}
      </section>

      {/* ---------- 留言板 ---------- */}
      <section className="card" data-tour="msg">
        <h2 className="card-title">
          <span className="titled-icon">
            <MessageSquare size={15} />
            留言板
          </span>
        </h2>
        <div className="mb-3 flex gap-2">
          <input className="input" placeholder="写下你的想法…" value={msgText}
                 onChange={(e) => setMsgText(e.target.value)} />
          <button className="btn btn-icon" onClick={postMessage}>
            <Send size={14} />
            发布
          </button>
          <button className="btn btn-icon btn-sm" onClick={loadMessages}>
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
        <div className="space-y-2">
          {messages.map((m) => (
            <div key={m.id} className="msg-row flex items-start justify-between p-2 text-sm">
              <div>
                <span className="font-medium">{m.username}</span>
                <span className="ml-2 text-xs text-neutral-400">{m.created_at}</span>
                <div className="mt-1">{m.content}</div>
              </div>
              <button className="text-xs text-neutral-400 hover:text-red-500"
                      onClick={() => deleteMessage(m.id)}>删除</button>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 提取历史 ---------- */}
      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <HistoryIcon size={15} />
            提取历史
          </span>
        </h2>
        <button className="btn btn-icon btn-sm" onClick={loadHistory}>
          <RefreshCw size={13} />
          加载我的历史
        </button>
        {history.length > 0 && (
          <div className="overflow-x-auto" style={{ marginTop: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>书名</th>
                  <th>文件</th>
                  <th>条数</th>
                  <th>评分</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.id}</td>
                    <td>{h.book_name}</td>
                    <td>{h.file_name}</td>
                    <td>{h.entry_count}</td>
                    <td>{h.rating ?? '-'}</td>
                    <td>{String(h.created_at || '').slice(0, 16)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => viewHistory(h.id)}>
                        载入
                      </button>{' '}
                      <button className="btn btn-sm" onClick={() => delHistory(h.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
