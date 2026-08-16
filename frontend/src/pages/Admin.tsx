import { useEffect, useState } from 'react'
import { Database, Users } from 'lucide-react'
import { api } from '../lib/api'
import { toast } from '../lib/toast'

export default function Admin() {
  const [users, setUsers] = useState<any>(null)
  const [extractions, setExtractions] = useState<any[]>([])
  const [err, setErr] = useState('')

  async function load() {
    setErr('')
    try {
      const [u, e] = await Promise.all([
        api('/api/admin/users'),
        api('/api/admin/extractions'),
      ])
      setUsers(u)
      setExtractions(e.extractions || [])
    } catch (e2: any) {
      setErr(e2.message || '加载失败（可能不是管理员）')
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function grantInvite(uid: string) {
    try {
      await api(`/api/admin/users/${uid}/grant-invite`, { method: 'POST' })
      toast('已开通24小时邀请', 'success')
      load()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  async function clearKey(uid: string) {
    try {
      await api(`/api/admin/users/${uid}/clear-key`, { method: 'POST' })
      toast('已清空该用户的 Key', 'success')
      load()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  async function deleteExtraction(id: number) {
    try {
      await api(`/api/admin/extractions/${id}`, { method: 'DELETE' })
      load()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  return (
    <div className="space-y-6">
      {err && <div className="card !border-red-200 text-sm text-red-500">{err}</div>}

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <Users size={15} />
            用户统计
          </span>
        </h2>
        {users && (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>用户名</th><th>提取次数</th><th>总条数</th><th>平均评分</th><th>最近提取</th><th>操作</th></tr>
              </thead>
              <tbody>
                {(users.stats || []).map((s: any) => (
                  <tr key={s.user_id}>
                    <td>{s.username}</td>
                    <td>{s['提取次数']}</td>
                    <td>{s['总条数']}</td>
                    <td>{s['平均评分'] ?? '-'}</td>
                    <td>{s['最近提取']}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => grantInvite(s.user_id)}>
                        开通邀请
                      </button>{' '}
                      <button className="btn btn-sm" onClick={() => clearKey(s.user_id)}>
                        清空 Key
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">
          <span className="titled-icon">
            <Database size={15} />
            提取记录（{extractions.length}）
          </span>
        </h2>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr><th>ID</th><th>用户名</th><th>书名</th><th>文件名</th><th>条数</th><th>评分</th><th>时间</th><th>删除</th></tr>
            </thead>
            <tbody>
              {extractions.map((x) => (
                <tr key={x.id}>
                  <td>{x.id}</td>
                  <td>{x.username}</td>
                  <td>{x.book_name}</td>
                  <td>{x.file_name}</td>
                  <td>{x.entry_count}</td>
                  <td>{x.rating ?? '-'}</td>
                  <td>{String(x.created_at || '').slice(0, 16)}</td>
                  <td>
                    <button className="text-xs text-neutral-400 hover:text-red-500"
                            onClick={() => deleteExtraction(x.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
