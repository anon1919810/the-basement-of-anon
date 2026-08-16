import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

interface Step {
  target: string
  title: string
  text: string
}

const STEPS: Step[] = [
  {
    target: '[data-tour="upload"]',
    title: '上传文献',
    text: '把地方志 PDF / Word 文件拖进来，或点击选择。推荐使用 Word 文件（文字版最准）；扫描版会自动走 OCR。',
  },
  {
    target: '[data-tour="book"]',
    title: '填写书名',
    text: '建议写全名，如「武汉市志 文物志」，便于结果分类与评分。',
  },
  {
    target: '[data-tour="maxonly"]',
    title: '仅提取最大子目',
    text: '默认开启：每个【子目】只提取一条核心要素，避免过度提取；关闭后粒度更细、条目更多。',
  },
  {
    target: '[data-tour="extract"]',
    title: '开始提取',
    text: '点击后 AI 自动读取文本、多轮提取并合并去重。条目多时请耐心等待进度提示。',
  },
  {
    target: '[data-tour="ai"]',
    title: 'AI 工作台',
    text: '提取完成后，选中条目让 AI 补充基础信息，或自由提问查证史实。',
  },
  {
    target: '[data-tour="stats"]',
    title: '统计看板',
    text: '查看全部提取的类别、流域分布和地域地图。',
  },
  {
    target: '[data-tour="msg"]',
    title: '留言板',
    text: '给作者留下建议或反馈，帮助撷菁轩变得更好。',
  },
]

export default function Tour({
  open,
  onClose,
  onSkipSession,
}: {
  open: boolean
  onClose: () => void
  onSkipSession: () => void
}) {
  const [step, setStep] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const s = STEPS[step]
    const el = document.querySelector<HTMLElement>(s.target)
    if (!el) {
      setPos(null)
      return
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const apply = () => {
      const r = el.getBoundingClientRect()
      const bw = 300
      const bh = bubbleRef.current?.offsetHeight ?? 230
      let left = r.left
      if (left + bw > window.innerWidth - 12) left = window.innerWidth - bw - 12
      if (left < 12) left = 12
      // 下方空间不足时改为向上展示（修复底部气泡点不到的问题）
      const below = r.bottom + bh + 12 <= window.innerHeight - 12
      const top = below ? r.bottom + 12 : Math.max(12, r.top - bh - 12)
      setPos({ top, left })
      el.style.outline = '2px solid var(--accent)'
      el.style.outlineOffset = '2px'
    }
    const timer = window.setTimeout(apply, 350)
    window.addEventListener('resize', apply)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', apply)
      el.style.outline = ''
      el.style.outlineOffset = ''
    }
  }, [open, step])

  if (!open) return null
  const s = STEPS[step]

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }}>
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)' }}
        onClick={onClose}
      />
      {pos && (
        <div
          ref={bubbleRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 300,
            zIndex: 9999,
            border: '1px solid var(--border-strong)',
            background: 'var(--bg)',
            boxShadow: '0 8px 28px rgba(0,0,0,.18)',
            padding: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <span style={{ fontWeight: 650, fontSize: 14 }}>{s.title}</span>
            <button
              className="icon-btn"
              onClick={onClose}
              title="关闭引导"
              style={{ width: 24, height: 24 }}
            >
              <X size={14} />
            </button>
          </div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
            {s.text}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-sm" disabled={step === 0} onClick={() => setStep(step - 1)}>
              <ChevronLeft size={13} />
              上一步
            </button>
            {step < STEPS.length - 1 ? (
              <button className="btn btn-accent btn-sm btn-icon" onClick={() => setStep(step + 1)}>
                下一步
                <ChevronRight size={13} />
              </button>
            ) : (
              <button className="btn btn-accent btn-sm" onClick={onClose}>
                完成
              </button>
            )}
            <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
              {step + 1}/{STEPS.length}
            </span>
          </div>
          <button
            className="faint"
            style={{
              marginTop: 8,
              fontSize: 12,
              textDecoration: 'underline',
              cursor: 'pointer',
              border: 'none',
              background: 'none',
              padding: 0,
            }}
            onClick={onSkipSession}
          >
            本次登录不再播放
          </button>
        </div>
      )}
    </div>
  )
}
