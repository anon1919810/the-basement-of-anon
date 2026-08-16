import { useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import Login from './pages/Login'
import Workbench from './pages/Workbench'
import Admin from './pages/Admin'
import Help from './pages/Help'
import Sidebar from './components/Sidebar'
import { clearToken, getToken } from './lib/api'

const TITLES: Record<string, string> = {
  '/workbench': '提取工作台',
  '/admin': '管理后台',
  '/help': '使用帮助',
}

export default function App() {
  const [logged, setLogged] = useState(!!getToken())
  const [collapsed, setCollapsed] = useState(false)
  const loc = useLocation()
  const user = localStorage.getItem('dsh_username')
  const title = TITLES[loc.pathname] ?? '杨端明的撷菁轩'

  if (!logged) return <Login onLogin={() => setLogged(true)} />

  const logout = () => {
    clearToken()
    localStorage.removeItem('dsh_username')
    setLogged(false)
  }

  return (
    <div className="flex" style={{ height: '100vh' }}>
      <Sidebar collapsed={collapsed} username={user} onLogout={logout} />
      <div className="flex flex-1 flex-col" style={{ minWidth: 0 }}>
        <header className="topbar">
          <button
            className="icon-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {collapsed ? '»' : '«'}
          </button>
          <span className="topbar-title">{title}</span>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            v5.0 撷菁新篇
          </span>
        </header>
        <main className="flex-1" style={{ overflowY: 'auto', padding: 20 }}>
          <div style={{ maxWidth: 980, margin: '0 auto' }}>
            <Routes>
              <Route path="/" element={<Workbench />} />
              <Route path="/workbench" element={<Workbench />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/help" element={<Help />} />
            </Routes>
            <footer
              className="muted"
              style={{ textAlign: 'center', padding: '24px 0 8px', fontSize: 12 }}
            >
              杨端明的撷菁轩 · 致谢王小波和纪德，所有提供建议和素材的朋友们
            </footer>
          </div>
        </main>
      </div>
    </div>
  )
}
