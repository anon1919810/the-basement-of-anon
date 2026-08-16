# 配置指南：网络加速 / Cline / Render / UptimeRobot

> 写给宝宝本人看，纯操作步骤，没有代码细节。版本基线：v4.7.0 车书万里。

---

## 一、网络加速（Watt Toolkit / Steam++）

**用途**：加速 GitHub、Render、Vercel 等国外网站。

**对开发有没有用？有用。** 推送代码到 GitHub 走的是电脑本机网络，加速后
`git push / git pull` 更稳定（此前经常 Connection reset，要靠重试循环）。

**注意**：
- 加速对象勾选 GitHub 即可；Render / Vercel 网页用浏览器访问时也能加速。
- 它通过改 hosts 文件加速。如果之后本地工具（localhost 网页、后端本地测试）出现怪问题，**先关掉加速再试**。
- pip / npm 下载依赖走国内镜像更稳（pip 用清华源、npm 用 npmmirror），不需要靠加速。
- DeepSeek 接口在国内，不需要加速。

## 二、Cline + DeepSeek（让 Cline 帮你写代码）

1. VS Code → 左侧「扩展」→ 搜索 **Cline** → 安装（作者 saoudrizwan）。
2. 左侧出现 Cline 图标 → 点开。
3. 顶部 **API Provider** 选提供商。**两个入口二选一**（看你的 Cline 版本）：
   - **新版 Cline：列表里直接有 `DeepSeek`** → 选它，**只需要填 API Key，不用填 Base URL**（地址自动填好）。推荐走这个。
   - 旧版只有 **OpenAI Compatible（OpenAI 兼容）** → 选它后才会出现 **Base URL** 输入框（中文版可能显示为"基础 URL / 基本 URL"）。
   - 解释：**Base URL = AI 服务的地址（门牌号）**，API Key = 钥匙。Cline 要找到 DeepSeek 的"门"才能进去。
4. **Base URL**（仅 OpenAI Compatible 需要）填：`https://api.deepseek.com/v1`（或 `https://api.deepseek.com`，两者都行）。
5. **API Key** 填：DeepSeek 的 API Key（即本地 `.env` 里 `DEEPSEEK_API_KEY` 的值；
   也可登录 platform.deepseek.com 查看/复制）。
6. **Model ID** 填：`deepseek-chat`（日常）；复杂推理可换 `deepseek-reasoner`（更慢更聪明）。
7. 对话框发一句「你好」，能正常回复 = 配置成功。
8. 开始干活：把仓库根目录的《迁移计划.md》拖进对话，
   说「按顺序做 ticket，一次 1-2 个，做完跑 `python _run_regression.py` 回归，再提交 git」。

## 三、Render 注册（免费档，可稍后做）

1. 打开 render.com → 右上 **Sign Up** → 选 **GitHub** 一键注册。
2. 授权时允许访问仓库 `the-basement-of-anon`（或全选）。
3. 注册完成即可。等后端写好，再按《迁移计划.md》的 T19 配置 Web Service。

## 四、UptimeRobot（可选监控，国内服务器不睡觉）

> 更新：后端已上线腾讯云轻量服务器 `http://119.91.211.156`，24 小时不睡，
> UptimeRobot 不再用于"防休眠"，仅作可选宕机监控。

1. 打开 uptimerobot.com → 注册免费账号。
2. **Add New Monitor** → Monitor Type 选 **HTTP(s)**。
3. URL 填 `http://119.91.211.156/api/health`。
4. Interval 选 **10 分钟** → Create Monitor。
5. 若收到告警邮件说明服务器宕机，可进云控制台排查（重启实例等）。
