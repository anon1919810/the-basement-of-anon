import { useEffect, useState } from 'react'
import { History as HistoryIcon, KeyRound, Save, User } from 'lucide-react'
import { api } from '../lib/api'
import { toast } from '../lib/toast'

export default function Profile() {
  const [items, setItems] = useState<any[]>([])
  const [keyStatus, setKeyStatus] = useState<any>(null)
  const [keyInput, setKeyInput] = useState('')

  async function load() {
    try {
      const [h, ks] = await Promise.all([
        api('/api/extract/history'),
        api('/api/auth/key-status'),
      ])
      setItems(h.items)
      setKeyStatus(ks)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function saveKey() {
    const k = keyInput.trim()
    if (!k) {
      toast('请输入 API Key', 'error')
      return
    }
    try {
      const r = await api('/api/auth/key', { method: 'POST', body: JSON.stringify({ api_key: k }) })
      toast(r.message || '已保存', 'success')
      setKeyInput('')
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const total = items.reduce((s, x) => s + (x.entry_count || 0), 0)
  const rated = items.filter((x) => x.rating)
  const avg = rated.length
    ? (rated.reduce((s, x) => s + x.rating, 0) / rated.length).toFixed(1)
    : '-'

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <User size={15} />
            我的资料
          </span>
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {[
            { l: '提取次数', v: String(items.length) },
            { l: '总条目', v: String(total) },
            { l: '平均评分', v: avg },
          ].map((o) => (
            <div
              key={o.l}
              style={{ border: '1px solid var(--border)', padding: '12px 14px' }}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                {o.l}
              </div>
              <div style={{ fontSize: 22, fontWeight: 650 }}>{o.v}</div>
            </div>
          ))}
        </div>
        {keyStatus && (
          <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            AI 使用权限：{keyStatus.allowed ? keyStatus.message : '无权限（请设置自己的 Key 或联系作者）'}
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <KeyRound size={15} />
            API Key 管理
          </span>
        </h2>
        <div className="flex gap-2">
          <input
            className="input"
            type="password"
            placeholder="粘贴你的 DeepSeek API Key（sk- 开头）"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button className="btn btn-icon" onClick={saveKey}>
            <Save size={14} />
            保存
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          保存后 AI 提取将使用你自己的 Key；未保存时使用作者 Key（管理员 / 邀请码有效期内）。
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <HistoryIcon size={15} />
            我的提取记录
          </span>
        </h2>
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗂️</div>
            还没有提取记录
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>书名</th>
                  <th>文件</th>
                  <th>条数</th>
                  <th>评分</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((h) => (
                  <tr key={h.id}>
                    <td>{h.id}</td>
                    <td>{h.book_name}</td>
                    <td>{h.file_name}</td>
                    <td>{h.entry_count}</td>
                    <td>{h.rating ?? '-'}</td>
                    <td>{String(h.created_at || '').slice(0, 16)}</td>
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
