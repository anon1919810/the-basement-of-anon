# 📚 文献文化要素提取工具 v4.0.0

从地方志、档案等 PDF/Word 文献中**自动提取文化要素**（遗址、建筑、人物、事件、习俗等），
自动分类为五大文化维度（物质/精神/制度/行为/心理），并整理成 Excel 表格。

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 📄 多格式输入 | PDF（文本层/扫描件）、Word(.docx) |
| 🧠 AI 提取 | DeepSeek 大模型，五类文化维度自动分类 |
| 📚 子目模式 | 自动识别【】/加粗提行子目，每个子目一条、不细分 |
| 🔍 智能 OCR | 本地 RapidOCR（中文最优）+ Tesseract 兜底；300dpi 自适应 |
| 🔤 错字纠正 | 易混淆字表 + 省域字典，自动纠正"潮北省→湖北省"类错误 |
| 📜 引文校验 | 每条"历史文献"自动核对原文，异常自动标记"⚠待核对" |
| 🗺️ 省域字典 | 长江流域省市区自动补全（湖北全量+12省市） |
| 💾 缓存 | 全文哈希+配置签名，重复处理零 Token |
| ⚡ 并行+多轮 | 多文件并行、每块多轮并集（自适应收敛省 Token） |
| 🔐 用户系统 | 登录/注册、24小时免登录、留言板、用户自带 API Key、邀请码 |
| 🛡️ 管理后台 | 留言管理、Key 管理（管理员） |
| 📊 看板与编辑 | 统计图表、在线编辑、Excel 下载 |

## 🚀 快速开始（本地）

```bash
pip install -r requirements.txt
# 可选：提升扫描件识别质量
pip install rapidocr_onnxruntime
```

1. 复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY`（DeepSeek 开放平台获取）
2. 运行 `streamlit run app.py`
3. 浏览器打开 http://localhost:8501

## 💡 推荐工作流（扫描件效果最佳）

```
扫描版PDF → WPS转Word → WPS AI修正错字 → 上传Word → 高质量Excel
```

Word 直接读取文本、完全跳过 OCR，摘录忠实度接近 100%（实测重庆分册 259 条 vs 人工 270 条）。

## ☁️ 云端部署（Streamlit Cloud）

1. 推送到 GitHub，在 [share.streamlit.io](https://share.streamlit.io) 连接仓库部署
2. **Secrets** 配置（Settings → Secrets）：

```toml
DEEPSEEK_API_KEY = "sk-..."
SUPABASE_URL = "https://你的项目.supabase.co"
SUPABASE_KEY = "你的anon key"
SESSION_SECRET = "随机长字符串（会话加密）"
INVITE_CODE = "你的邀请码（可选）"
ADMIN_USERNAMES = "作者用户名（可选，逗号分隔）"
```

3. **Supabase** 执行一次 `db_schema.sql`（建表+追加列+策略）
4. 重新部署生效

## ⚙️ 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API Key |
| `SUPABASE_URL` / `SUPABASE_KEY` | ⚠️ | 不配则用代码内默认（推荐配置） |
| `SESSION_SECRET` | ⚠️ | 登录令牌与 Key 加密密钥，务必配置随机值 |
| `INVITE_CODE` | 可选 | 邀请码；用户填对后 24 小时内用作者 Key |
| `ADMIN_USERNAMES` | 可选 | 管理员用户名（逗号分隔） |
| `REQUIRE_KEY_OR_INVITE` | 可选 | 默认 true；false 恢复"人人用作者 Key" |

## 📂 项目结构

```
app.py               Streamlit 主界面（登录/提取/管理后台）
extract_papers.py    核心调度（缓存/拆分/API/并行）
prompts.py           提示词模板与结构检测
ocr_engine.py        文本/OCR引擎（RapidOCR/Tesseract/Word）
postprocess.py       后处理（规范化/合并/标注/引文校验）
ocr_corrections.py   OCR错字纠正（易混淆字表+专名）
province_dict.py     长江流域省域字典
database.py          Supabase 操作（用户/留言/Key/邀请码/会话）
shared.py            共享工具
config.py            全部可调参数
db_schema.sql        Supabase 建表脚本
示例/                黄金标准与参考数据
_run_regression.py   回归测试（发布前必跑）
_learn_corrections.py 从人工确认数据挖掘纠错对（轻量学习）
```

## 🧪 开发者工具

```bash
python _run_regression.py           # 回归测试（缓存命中零API，全过退出码0）
python _learn_corrections.py --xlsx 示例/xx.xlsx --source results/xx.txt --apply
```

## ❓ 常见问题

- **部署报 Error installing requirements**：检查 requirements.txt 是否为最小依赖集
- **引文出现"⚠待核对"**：模型改写了原文，请对照原扫描页人工确认
- **管理后台不显示**：登录用户名须与 `ADMIN_USERNAMES` 完全一致
- **邀请码兑换提示数据库未更新**：需在 Supabase 执行 `db_schema.sql`

## 📜 版本

v4.0.0 — 正式版。详见应用内"更新日志"。
