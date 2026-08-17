import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// v0.7 玻璃拟态 + 深色模式样式（index_new.css = index.css 超集 + 玻璃/暗色变量）
import './index_new.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
