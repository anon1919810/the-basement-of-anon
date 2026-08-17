import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 允许读取项目目录外的地图数据（grand_strategy/data）
    fs: {
      allow: ['..'],
    },
  },
  build: {
    // 地图 JSON（2.7MB）内联进 bundle，放宽 chunk 警告阈值
    chunkSizeWarningLimit: 4000,
  },
})
