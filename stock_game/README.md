# 覆巢之下 · 股市模拟游戏（v0.0.0 MVP）

> 你是一名投资经理。初始资金 **10,000 虚拟货币**，共 **30 个交易日**，在 T+1、双向手续费、
> ±10% 涨跌停规则下让总资产最大化，并与 3 名 AI 模拟交易者比拼收益率。

---

## 一、策划案 v1

### 1. 市场（8 只虚拟股票）

| 名称 | 代码 | 行业 | 基础价值 |
| --- | --- | --- | --- |
| 星辰科技 | STK | 科技 | 100 |
| 云端软件 | CLD | 科技 | 88 |
| 味珍食品 | FOOD | 消费 | 42 |
| 黑金能源 | ENE | 能源 | 35 |
| 康泰医药 | MED | 医药 | 66 |
| 汇通银行 | BANK | 金融 | 28 |
| 钢铁巨擘 | IRON | 原材料 | 18 |
| 清源水务 | WAT | 公用事业 | 55 |

行业：科技 / 消费 / 能源 / 医药 / 金融 / 原材料 / 公用事业。

### 2. 每日价格引擎（每只股票每天生成新价格，基于前收盘）

1. **随机游走**：±1.5% 随机扰动；
2. **趋势因子**：若过去 3 日累计上涨，则小幅顺延 +0.3%~0.8%（下跌则反向）；
3. **均值回归**：相对基础价值偏离 >15% 时向基础价值拉回（每次 0.2%~1.0%）；
4. **新闻事件影响**：按该股所属行业/个股/全市场新闻的 `impact_range` 中值影响
   （个股新闻 ×1.3 权重更高，行业 ×1.0，全市场 ×0.7），持续 `duration` 个交易日；
5. **AI 交易者扰动**：AI 买卖对价格产生 ±0.5%~2% 额外扰动，成交量放大 1.2~2 倍；
6. **涨跌停**：单日涨跌幅 clamp 在 ±10%；
7. **成交量**：随机 1000~20000 手，AI 活跃时放大。

### 3. 新闻系统

- 每天生成 1-3 条新闻；
- 优先调用后端 `POST /api/news`（DeepSeek AI 生成，temperature 0.8，JSON 输出）；
- 后端任何异常（无 Key / 网络错 / 解析失败）返回内置中文模板新闻；
- 前端请求失败（6 秒超时 / 后端未启动）时用前端内置模板兜底 —— **纯离线也能玩**；
- 字段：`title / summary / impact_stock（股票代码或行业名或 ALL）/ impact_range（如 "+5%~+8%"）/ duration（1-3 天）/ sector?`。

### 4. AI 交易者（3 名，模拟"多名交易者同台"）

| 选手 | 风格 | 策略 |
| --- | --- | --- |
| 陈锐（激进） | 追动量+新闻 | 买动量+新闻得分前 2 名（各 35% 现金），动量转弱（<-2%）时减仓 30% |
| 李安（稳健） | 左侧低吸 | 低于基础价值 ≥10% 买入（15% 现金），盈利 >12% 分批止盈 50% |
| 王趋势（趋势） | 跟随趋势 | 3 日累计涨幅 >3% 买龙头（30% 现金），跌幅 <-3% 清仓 |

AI 的买卖计入当日成交量，并对价格产生 ±0.5%~2% 扰动。游戏结束时给出玩家与 3 名 AI 的收益率排名。

### 5. 交易规则

- **T+1**：当日买入次日方可卖出（持仓记录区分"可卖数量"，每日开盘自动解锁）；
- **双向手续费 0.1%，最低 1**；
- **市价单**：立即按当前价成交；**限价单**：挂出后在下一交易日撮合（买入需现价 ≤ 限价，卖出需现价 ≥ 限价）；
- **涨跌停 ±10%**：涨停无法买入、跌停无法卖出，限价单在涨跌停日不成交；
- 买不起 / 卖不出（T+1 可卖不足）时给出明确中文提示。

### 6. 玩家操作

买 / 卖（市价、限价）→ 看持仓 → 看行情 → 看新闻 → 「下一日」推进一个交易日 →
30 天后弹出结算面板（总资产、收益率、与 AI 排名、重新开始）。

### 7. 存档

localStorage 自动保存（每个交易日 + 每次操作），提供「新游戏」按钮（需确认）。

---

## 二、MVP 范围（v0.0.0 已交付）

- [x] 8 只虚拟股票 + 每日价格引擎（6 个因子 + 涨跌停 + 成交量）
- [x] 新闻系统：后端 AI（DeepSeek）+ 后端模板兜底 + 前端模板兜底
- [x] 3 名 AI 交易者（激进/稳健/趋势），计入成交量并扰动价格
- [x] 交易：市价/限价、T+1、双向手续费、涨跌停、明确提示
- [x] 前端：顶栏 / 行情表 / ECharts 走势图 / 交易面板 / 持仓表 / 新闻流 / 结算弹窗
- [x] 存档：localStorage 自动保存 + 新游戏
- [x] 后端：`GET /api/health`、`POST /api/news`、CORS、`.env` 加载
- [x] 冒烟测试 `_smoke.py` 与前端 `npm run build`（0 TS 错误）通过

### 数值模型说明

- 价格：初始价 = 基础价值；每日 `close = prevClose × (1 + clamp(漂移, ±10%))`；
- 漂移 = 随机 ±1.5% + 趋势 ±(0.3%~0.8%) + 均值回归 ±(0.2%~1.0%) + 新闻中值 + AI 扰动 ±(0.5%~2%)；
- 手续费 `fee = max(1, round(数量 × 价格 × 0.1%))`，买卖双向收取；
- 收益率 = 总资产 / 初始资金 − 1；总资产 = 现金 + Σ(持仓 × 现价)。

---

## 三、目录结构

```
stock_game/
├── README.md                 # 本文档
├── backend/
│   ├── requirements.txt      # fastapi, uvicorn, python-dotenv, requests, httpx(测试用)
│   ├── _smoke.py             # 冒烟测试（TestClient 断言 health + news）
│   └── app/
│       ├── __init__.py
│       └── main.py           # FastAPI：/api/health、/api/news（DeepSeek + 模板兜底）
└── frontend/                 # Vite + React + TS
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig*.json
    └── src/
        ├── main.tsx / App.tsx / index.css
        ├── game/             # 引擎（纯逻辑，无 UI 依赖）
        │   ├── types.ts      # 全局类型
        │   ├── stocks.ts     # 股票定义 + 全局参数
        │   ├── engine.ts     # 日循环 + 价格引擎 + 结算排名
        │   ├── news.ts       # 新闻模板兜底 + 影响解析/判定
        │   ├── ai.ts         # 3 名 AI 交易者
        │   ├── state.ts      # 状态/存档/交易撮合
        │   ├── api.ts        # 后端调用（失败兜底）
        │   └── util.ts       # 数值工具
        └── components/       # TopBar / MarketTable / PriceChart / TradePanel / HoldingsTable / NewsFeed / SettlementModal
```

---

## 四、运行方式

### 完整模式（后端 AI 新闻 + 前端）

```powershell
# 终端 1：启动后端（读取仓库根 .env 中的 DEEPSEEK_API_KEY）
cd C:\Users\杨睿\Desktop\pdf_extractor\stock_game\backend
C:\Users\杨睿\Desktop\pdf_extractor\.venv\Scripts\python.exe -m pip install -r requirements.txt
C:\Users\杨睿\Desktop\pdf_extractor\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000

# 终端 2：启动前端
cd C:\Users\杨睿\Desktop\pdf_extractor\stock_game\frontend
npm.cmd install
npm.cmd run dev
# 浏览器打开 http://localhost:5173
```

### 纯前端模式（离线兜底）

后端不启动也可以玩：前端请求 `http://localhost:8000/api/news` 失败（6 秒超时）后，
自动改用内置中文模板新闻。仍可完整游玩 30 天并结算。

### 冒烟测试 / 构建

```powershell
# 后端冒烟（会真实调用一次 DeepSeek，极小成本；失败也必须有模板兜底）
cd C:\Users\杨睿\Desktop\pdf_extractor\stock_game\backend
C:\Users\杨睿\Desktop\pdf_extractor\.venv\Scripts\python.exe _smoke.py
# 要求退出码 0

# 前端构建（tsc + vite，0 TS 错误）
cd C:\Users\杨睿\Desktop\pdf_extractor\stock_game\frontend
npm.cmd run build
```

---

## 五、已知简化 / 妥协（v0.0.0）

1. **AI 新闻依赖真实网络**：DeepSeek 调用有 20 秒后端超时、前端 6 秒超时；超时/失败时按设计走模板兜底。
2. **限价单撮合简化**：限价单在"下一交易日"收盘价上撮合（买入现价 ≤ 限价、卖出现价 ≥ 限价即按限价成交），
   未引入委托队列/滑点；涨跌停日不成交并撤单。
3. **AI 决策简化**：AI 基于"前收盘价 + 当日新闻"决策（未模拟日内成交价），整手交易（100 股/手），
   无手续费、无 T+1 限制（不卖当日新买）。
4. **K 线简化**：走势图为收盘价折线（含日/收盘/涨跌幅/成交量 tooltip），未做蜡烛图与分时。
5. **行情只按日推进**：一个"交易日"即一次「下一日」，无盘中连续报价。
6. **手续费取整**：`fee = max(1, round(金额×0.1%))`，未按分计算小数尾差。
7. **前端 bundle 体积**：ECharts 按需引入后主 chunk 约 712 kB（gzip 238 kB），vite 有 >500 kB 提示，属预期（MVP 未做代码分割）。
