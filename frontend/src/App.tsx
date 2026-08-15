import { useState } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import Login from './pages/Login'
import Workbench from './pages/Workbench'
import Admin from './pages/Admin'
import Help from './pages/Help'
import { clearToken, getToken } from './lib/api'

const NAV = [
  { to: '/workbench', label: '📚 提取工作台' },
  { to: '/admin', label: '🛡️ 管理后台' },
  { to: '/help', label: '📖 使用帮助' },
]

export default function App() {
  const [logged, setLogged] = useState(!!getToken())
  const loc = useLocation()
  const user = localStorage.getItem('dsh_username')

  if (!logged) return <Login onLogin={() => setLogged(true)} />

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="text-lg font-bold">📚 杨端明的撷菁轩</div>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className={`px-3 py-2 text-sm ${
                  loc.pathname.startsWith(n.to)
                    ? 'border-b-2 border-[#3ecf8e] font-medium'
                    : 'text-neutral-500 hover:text-neutral-900'
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-neutral-500">
            {user && <span>👤 {user}</span>}
            <button
              className="btn !py-1"
              onClick={() => {
                clearToken()
                localStorage.removeItem('dsh_username')
                setLogged(false)
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Routes>
          <Route path="/" element={<Workbench />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/help" element={<Help />} />
        </Routes>
      </main>

      <footer className="border-t border-neutral-200 py-6 text-center text-xs text-neutral-400">
        杨端明的撷菁轩 · 致谢王小波和纪德，所有提供建议和素材的朋友们
      </footer>
    </div>
  )
}
