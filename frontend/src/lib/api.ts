const API_BASE = (import.meta.env.VITE_API_BASE as string) ?? ''

export function getToken(): string | null {
  return localStorage.getItem('dsh_token')
}
export function setToken(t: string) {
  localStorage.setItem('dsh_token', t)
}
export function clearToken() {
  localStorage.removeItem('dsh_token')
}

async function handle<T = any>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`
    try {
      const body = await res.json()
      if (body && body.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

/** JSON 请求 */
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const t = getToken()
  if (t) headers.Authorization = `Bearer ${t}`
  const res = await fetch(API_BASE + path, { ...opts, headers })
  return handle<T>(res)
}

/** 表单上传 + SSE 事件流（提取进度 / 对话流） */
export async function apiSSE(
  path: string,
  body: FormData | string,
  isJson: boolean,
  onEvent: (e: any) => void,
): Promise<void> {
  const headers: Record<string, string> = {}
  if (isJson) headers['Content-Type'] = 'application/json'
  const t = getToken()
  if (t) headers.Authorization = `Bearer ${t}`
  const res = await fetch(API_BASE + path, { method: 'POST', headers, body })
  if (!res.ok || !res.body) {
    let detail = `请求失败（${res.status}）`
    try {
      const b = await res.json()
      if (b && b.detail) detail = b.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data: '))
      if (line) onEvent(JSON.parse(line.slice(6)))
    }
  }
}
