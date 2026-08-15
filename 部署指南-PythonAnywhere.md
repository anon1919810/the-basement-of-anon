# 部署指南：PythonAnywhere（免费、免绑卡、常驻不睡）

> 适用：把后端（FastAPI）部署到 PythonAnywhere 免费档。
> 前提：GitHub 仓库已是公开的 ✅（已经是了，clone 不用密码）

---

## 一、注册（2 分钟）

1. 打开 **pythonanywhere.com** → 右上角 **Sign up / 注册**
2. 填邮箱 + 密码。**用户名会变成网址的一部分**，比如用户名 `abc` → 网址 `abc.pythonanywhere.com`，起个好记的
3. 选**免费 Beginner 档**（不用绑卡）
4. 去邮箱点验证链接，登录

## 二、跑一键脚本（Console 里粘贴一次）

1. 登录后，顶部菜单点 **Consoles** → 点 **Bash**（打开黑色控制台）
2. 打开仓库里的 **`backend/deploy_pythonanywhere.sh`**，把内容**整段复制**
3. 粘贴到控制台，回车，等它跑完（约 1-3 分钟）
4. 它会自动：克隆仓库 → 建虚拟环境 → 装依赖 → 写好 WSGI 入口

## 三、在网页上配置（Web 标签，3 步）

1. 顶部菜单 **Web** → **Add a new web app**
2. 依次选：**pythonanywhere.com** → Next → **Manual configuration** → Next → **Python 3.12** → Next
3. 创建后，在 Web 页往下找两行，点铅笔编辑：
   - **Virtualenv**：填 `/home/你的用户名/the-basement-of-anon/backend/venv`
   - **WSGI configuration file**：改成 `/home/你的用户名/dsh_wsgi.py`
4. 顶部菜单 **Files** → 进入 `the-basement-of-anon` 文件夹 → **Upload a file** → 上传你**本地的 .env**（覆盖模板）
5. 回 **Web** 页 → 点绿色 **Reload** 按钮

## 四、验收

浏览器打开 `https://你的用户名.pythonanywhere.com/api/health`
看到 `{"ok": true, ...}` 就大成功啦！🎉

## 以后更新代码

- 控制台里：`cd ~/the-basement-of-anon && git pull`
- 回 Web 页点 **Reload**
（也可以让そよ远程帮你做）

## 注意事项

- 免费档磁盘 512MB：现在刚好够；**OCR 大依赖先不上**（坚持 Word/文字版 PDF 流程即可，反正这也是推荐流程）
- 免费档 CPU 有限：适合"文本提取 + 等 DeepSeek 回话"，别做大批量扫描 OCR
- 以后想要更宽松：**国内轻量服务器**（腾讯云/阿里云，支付宝支付，¥100-200/年）一劳永逸，前端也能放
