import { Link, useLocation } from 'react-router-dom'
import { BookOpen, Library, LogOut, Shield, User } from 'lucide-react'

const NAV = [
  { to: '/workbench', icon: Library, label: '提取工作台' },
  { to: '/profile', icon: User, label: '我的资料' },
  { to: '/admin', icon: Shield, label: '管理后台' },
  { to: '/help', icon: BookOpen, label: '使用帮助' },
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
        <Library size={18} color="#1f9d6c" />
        {!collapsed && <span>杨端明的撷菁轩</span>}
      </div>
      <nav className="sidebar-nav">
        {NAV.map((n) => {
          const Icon = n.icon
          return (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={`sidebar-item ${loc.pathname.startsWith(n.to) ? 'active' : ''}`}
            >
              <span className="sidebar-icon">
                <Icon size={17} />
              </span>
              {!collapsed && <span>{n.label}</span>}
            </Link>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <button className="sidebar-item" onClick={onLogout} title="退出登录">
          <span className="sidebar-icon">
            <User size={17} />
          </span>
          {!collapsed && (
            <span>
              {username || '用户'}
              <LogOut size={13} style={{ verticalAlign: '-2px', marginLeft: 6 }} />
            </span>
          )}
        </button>
      </div>
    </aside>
  )
}
