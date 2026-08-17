# 覆巢之下 · 前端

《覆巢之下》股市模拟游戏的前端（Vite + React + TS）。

- 设计文档、玩法与运行方式见仓库根目录 [`../README.md`](../README.md)
- 游戏逻辑在 `src/game/`（纯 TS，无 UI 依赖），组件在 `src/components/`
- 开发期校验脚本：`npx tsx scripts/sim.ts`（无头跑满 30 天并断言核心不变量）

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build（0 TS 错误）
```
