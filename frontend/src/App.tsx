import { useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { GraduationCap, Moon, PanelLeftClose, PanelLeftOpen, Sun } from 'lucide-react'
import Login from './pages/Login'
import Workbench from './pages/Workbench'
import Admin from './pages/Admin'
import Help from './pages/Help'
import Profile from './pages/Profile'
import Sidebar from './components/Sidebar'
import Tour from './components/Tour'
import { clearToken, getToken } from './lib/api'

const TITLES: Record<string, string> = {
  '/workbench': '提取工作台',
  '/profile': '我的资料',
  '/admin': '管理后台',
  '/help': '使用帮助',
}

export default function App() {
  const [logged, setLogged] = useState(!!getToken())
  const [collapsed, setCollapsed] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('dsh_theme') || 'light')
  const [tourOpen, setTourOpen] = useState(false)
  const loc = useLocation()
  const user = localStorage.getItem('dsh_username')
  const title = TITLES[loc.pathname] ?? '杨端明的撷菁轩'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dsh_theme', theme)
  }, [theme])

  // 新手引导：登录后进入工作台自动播放一次（本次登录可跳过）
  useEffect(() => {
    if (!logged) return
    if (!loc.pathname.startsWith('/workbench')) return
    if (sessionStorage.getItem('dsh_tour_skipped')) return
    const t = window.setTimeout(() => setTourOpen(true), 700)
    return () => window.clearTimeout(t)
  }, [logged, loc.pathname])

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
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <span className="topbar-title">{title}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={() => setTourOpen(true)} title="新手引导">
            <GraduationCap size={15} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <span className="chip chip-green">v5.0 撷菁新篇</span>
        </header>
        <main className="flex-1" style={{ overflowY: 'auto', padding: 20 }}>
          <div style={{ maxWidth: 980, margin: '0 auto' }}>
            <Routes>
              <Route path="/" element={<Workbench />} />
              <Route path="/workbench" element={<Workbench />} />
              <Route path="/profile" element={<Profile />} />
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
      <Tour
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        onSkipSession={() => {
          sessionStorage.setItem('dsh_tour_skipped', '1')
          setTourOpen(false)
        }}
      />
    </div>
  )
}
