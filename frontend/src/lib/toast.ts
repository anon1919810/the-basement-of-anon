/** 轻量 Toast 提示（无依赖，命令式调用） */
export type ToastType = 'success' | 'error' | 'info'

let host: HTMLDivElement | null = null

export function toast(message: string, type: ToastType = 'info') {
  if (!host) {
    host = document.createElement('div')
    host.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:flex-end;'
    document.body.appendChild(host)
  }
  const el = document.createElement('div')
  const border = type === 'error' ? '#f87171' : type === 'success' ? 'var(--accent)' : 'var(--border-strong)'
  const bg = type === 'error' ? '#fef2f2' : type === 'success' ? '#f0fdf6' : 'var(--bg)'
  const color = type === 'error' ? '#b91c1c' : type === 'success' ? 'var(--accent-dark)' : 'var(--text)'
  el.style.cssText = `min-width:220px;max-width:340px;padding:10px 14px;font-size:13px;border:1px solid ${border};background:${bg};color:${color};box-shadow:0 4px 14px rgba(0,0,0,.12);`
  el.textContent = message
  host.appendChild(el)
  window.setTimeout(() => {
    el.style.transition = 'opacity .3s'
    el.style.opacity = '0'
    window.setTimeout(() => el.remove(), 320)
  }, 2600)
}
