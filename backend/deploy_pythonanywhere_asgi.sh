#!/bin/bash
# ============================================================
# 撷菁轩后端 · PythonAnywhere 原生 ASGI 部署（推荐，替代 a2wsgi WSGI 方案）
# 背景：a2wsgi + uWSGI 在 PythonAnywhere 上会卡死（请求 40s 超时、转圈）。
#       官方原生 ASGI beta 直接跑 uvicorn，FastAPI 原生支持，稳定。
# 前置：在 pythonanywhere.com → Account(账户) → API token 里生成一个 token
# 用法：注册后 → Consoles → Bash → 把本文件内容整段粘贴 → 回车
# ============================================================
set -e

PA_DOMAIN="${PA_DOMAIN:-yangduanming.pythonanywhere.com}"

echo "=== 1/3 安装 pa 命令行工具（typing-extensions 报错可忽略） ==="
pip install --upgrade pythonanywhere || true

echo "=== 2/3 查看当前网站 ==="
pa website list 2>/dev/null || echo "（pa list 不可用，直接尝试创建）"

echo "=== 3/3 创建原生 ASGI 网站 ==="
pa website create --domain "$PA_DOMAIN" --command '/home/yangduanming/the-basement-of-anon/backend/venv/bin/uvicorn --app-dir /home/yangduanming/the-basement-of-anon/backend --uds ${DOMAIN_SOCKET} app.main:app'

echo ""
echo "============================================================"
echo "完成！如果提示域名已被占用："
echo "  先在 Web 页面删掉旧的 WSGI app（页面底部 Delete this web app），"
echo "  然后重新运行本脚本。"
echo "访问: https://$PA_DOMAIN/api/health"
echo "============================================================"
