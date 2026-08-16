#!/bin/bash
# ============================================================
# 撷菁轩后端 · PythonAnywhere 一键部署脚本
# 用法：注册 pythonanywhere.com 后 → 顶部菜单 Consoles → Bash
#       把本文件内容整段复制粘贴到控制台，回车即可
# ============================================================
set -e

REPO="https://github.com/anon1919810/the-basement-of-anon.git"

echo "=== 1/4 克隆仓库（公开仓库，无需密码） ==="
cd ~
if [ ! -d "the-basement-of-anon" ]; then
  git clone "$REPO"
else
  cd the-basement-of-anon && git pull && cd ~
fi

echo "=== 2/4 创建虚拟环境并安装依赖 ==="
PY=python3.12
command -v $PY >/dev/null 2>&1 || PY=python3
cd ~/the-basement-of-anon/backend
$PY -m venv venv
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt a2wsgi -q
echo "依赖安装完成"

echo "=== 3/4 生成 .env 模板（稍后用 Files 页面上传你本地的 .env 覆盖） ==="
if [ ! -f ~/the-basement-of-anon/.env ]; then
  cat > ~/the-basement-of-anon/.env << 'EOF'
DEEPSEEK_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
SESSION_SECRET=
INVITE_CODE=931226
ADMIN_USERNAMES=失败主义谋士千早爱音
EOF
  echo "已生成模板 .env：请用 Files 页面上传本地 .env 覆盖它"
else
  echo ".env 已存在，跳过"
fi

echo "=== 4/4 写入 WSGI 入口（用 a2wsgi 把 FastAPI 包装成 WSGI） ==="
cat > ~/dsh_wsgi.py << EOF
import sys
sys.path.insert(0, "/home/$(whoami)/the-basement-of-anon/backend")
from a2wsgi import ASGIMiddleware
from app.main import app
application = ASGIMiddleware(app)
EOF

echo ""
echo "============================================================"
echo "完成！接下来在网页上做 3 步："
echo "1) 顶部菜单 Web → Add a new web app → Manual configuration → Python 3.12"
echo "2) Virtualenv 填: /home/$(whoami)/the-basement-of-anon/backend/venv"
echo "3) WSGI configuration file 改成: /home/$(whoami)/dsh_wsgi.py"
echo "4) Files 页面上传本地 .env 到 /home/$(whoami)/the-basement-of-anon/.env"
echo "5) 回 Web 页点 Reload，访问 https://$(whoami).pythonanywhere.com/api/health"
echo "============================================================"
