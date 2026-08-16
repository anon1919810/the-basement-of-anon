import { Link, useLocation } from 'react-router-dom'

const NAV = [
  { to: '/workbench', icon: '📚', label: '提取工作台' },
  { to: '/admin', icon: '🛡️', label: '管理后台' },
  { to: '/help', icon: '📖', label: '使用帮助' },
]

export default function Sidebar({
  collapsed,
  username,
  onLogout,
}: {
  collapsed: boolean
  username: string | null
  onLogout: () => void
}) {
  const loc = useLocation()
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span>📚</span>
        {!collapsed && <span>杨端明的撷菁轩</span>}
      </div>
      <nav className="sidebar-nav">
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            title={collapsed ? n.label : undefined}
            className={`sidebar-item ${loc.pathname.startsWith(n.to) ? 'active' : ''}`}
          >
            <span className="sidebar-icon">{n.icon}</span>
            {!collapsed && <span>{n.label}</span>}
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className="sidebar-item" onClick={onLogout} title="退出登录">
          <span className="sidebar-icon">👤</span>
          {!collapsed && <span>{username || '用户'} · 退出</span>}
        </button>
      </div>
    </aside>
  )
}
