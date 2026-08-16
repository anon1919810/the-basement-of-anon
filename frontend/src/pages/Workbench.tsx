import { useRef, useState } from 'react'
import {
  BarChart3,
  Brain,
  Check,
  Download,
  FileText,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Table2,
  Upload,
  Wand2,
} from 'lucide-react'
import { api, apiSSE } from '../lib/api'
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

export default function Workbench() {
  // ---- 上传提取 ----
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [bookName, setBookName] = useState('')
  const [maxOnly, setMaxOnly] = useState(true)
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [recordId, setRecordId] = useState<number | null>(null)

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

  const fileRef = useRef<HTMLInputElement>(null)

  async function doExtract() {
    setErr('')
    if (!file) {
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
    fd.append('file', file)
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

  function exportCsv() {
    if (!entries || entries.length === 0) return
    const cols = ['名称', '类别', '时间', '空间', '流域', '基础信息', '历史文献']
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = entries.map((e) => cols.map((c) => esc((e as any)[c])).join(','))
    const csv = '\uFEFF' + cols.map(esc).join(',') + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${bookName || '文化要素提取结果'}.csv`
    a.click()
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
            placeholder="书名（如：武汉市志 文物志）"
            value={bookName}
            onChange={(e) => setBookName(e.target.value)}
          />
          <div
            className={`dropzone ${dragOver ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) setFile(f)
            }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.doc"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="btn-icon" style={{ justifyContent: 'center' }}>
                <FileText size={15} />
                {file.name}（{(file.size / 1024 / 1024).toFixed(1)} MB）
                <button
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFile(null)
                    if (fileRef.current) fileRef.current.value = ''
                  }}
                >
                  清除
                </button>
              </span>
            ) : (
              <span className="btn-icon" style={{ justifyContent: 'center' }}>
                <Upload size={16} />
                拖拽 PDF / Word 到这里，或点击选择
              </span>
            )}
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-neutral-600">
          <input type="checkbox" checked={maxOnly} onChange={(e) => setMaxOnly(e.target.checked)} />
          仅提取最大子目（推荐）
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-accent btn-icon" disabled={busy} onClick={doExtract}>
            <Sparkles size={14} />
            {busy ? '提取中…' : '开始提取'}
          </button>
          {stage && <span className="text-sm text-[#1f9d6c]">{stage}</span>}
        </div>
      </section>

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
            <button className="btn btn-icon btn-sm" onClick={exportCsv}>
              <Download size={13} />
              导出 CSV
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
                    <td>{e.类别}</td>
                    <td>{e.时间 ?? ''}</td>
                    <td>{e.空间 ?? ''}</td>
                    <td>{e.流域 ?? ''}</td>
                    <td>{e.基础信息 ?? ''}</td>
                    <td>{e.历史文献 ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---------- AI 工作台 ---------- */}
      <section className="card">
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
      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <BarChart3 size={15} />
            统计看板
          </span>
        </h2>
        <button className="btn btn-icon btn-sm" onClick={loadStats}>
          <RefreshCw size={13} />
          加载统计
        </button>
        {stats && <StatsCharts stats={stats} />}
      </section>

      {/* ---------- 留言板 ---------- */}
      <section className="card">
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
    </div>
  )
}
