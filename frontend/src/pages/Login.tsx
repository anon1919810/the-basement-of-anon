import { useState } from 'react'
import { api, setToken } from '../lib/api'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // 登录
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // 注册
  const [regUser, setRegUser] = useState('')
  const [regPass, setRegPass] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regQq, setRegQq] = useState('')

  async function doLogin() {
    setErr('')
    setBusy(true)
    try {
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setToken(r.token)
      localStorage.setItem('dsh_username', r.user.username)
      onLogin()
    } catch (e: any) {
      setErr(e.message || '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function doRegister() {
    setErr('')
    setBusy(true)
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: regUser,
          password: regPass,
          email: regEmail,
          qq: regQq,
        }),
      })
      setTab('login')
      setUsername(regUser)
      setPassword('')
      setErr('注册成功，请登录')
    } catch (e: any) {
      setErr(e.message || '注册失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="card w-full max-w-sm">
        <div className="mb-4 text-center">
          <div className="text-xl font-bold">📚 杨端明的撷菁轩</div>
          <div className="mt-1 text-xs text-neutral-400">地方志文化要素提取工具</div>
        </div>

        <div className="mb-4 flex border border-neutral-200">
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setErr('')
              }}
              className={`flex-1 py-2 text-sm ${
                tab === t ? 'bg-[#3ecf8e] font-medium text-white' : 'text-neutral-500'
              }`}
            >
              {t === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        {tab === 'login' ? (
          <div className="space-y-3">
            <input className="input" placeholder="用户名" value={username}
                   onChange={(e) => setUsername(e.target.value)} />
            <input className="input" type="password" placeholder="密码" value={password}
                   onChange={(e) => setPassword(e.target.value)}
                   onKeyDown={(e) => e.key === 'Enter' && doLogin()} />
            <button className="btn btn-accent w-full" disabled={busy} onClick={doLogin}>
              {busy ? '登录中…' : '登 录'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input className="input" placeholder="用户名（至少2个字符）" value={regUser}
                   onChange={(e) => setRegUser(e.target.value)} />
            <input className="input" type="password" placeholder="密码（至少4个字符）" value={regPass}
                   onChange={(e) => setRegPass(e.target.value)} />
            <input className="input" placeholder="邮箱（选填）" value={regEmail}
                   onChange={(e) => setRegEmail(e.target.value)} />
            <input className="input" placeholder="QQ号（选填）" value={regQq}
                   onChange={(e) => setRegQq(e.target.value)} />
            <button className="btn btn-accent w-full" disabled={busy} onClick={doRegister}>
              {busy ? '注册中…' : '注 册'}
            </button>
          </div>
        )}

        {err && <div className={`mt-3 text-sm ${err.includes('成功') ? 'text-[#3ecf8e]' : 'text-red-500'}`}>{err}</div>}
      </div>
    </div>
  )
}
