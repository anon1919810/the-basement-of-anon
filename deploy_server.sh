#!/bin/bash
# ============================================================
# 撷菁轩后端 · 国内轻量服务器（Ubuntu 22.04）一键部署脚本
# 用法（以 root 登录后）：
#   cd /root
#   git clone https://github.com/anon1919810/the-basement-of-anon.git
#   cd the-basement-of-anon
#   bash deploy_server.sh
# ============================================================
set -e

echo "=== 1/5 换用腾讯云/清华镜像源（加速） ==="
sed -i 's|archive.ubuntu.com|mirrors.cloud.tencent.com|g; s|security.ubuntu.com|mirrors.cloud.tencent.com|g' /etc/apt/sources.list 2>/dev/null || true

echo "=== 2/5 安装系统依赖 ==="
apt-get update -y
apt-get install -y python3-venv python3-pip git curl

echo "=== 3/5 虚拟环境与依赖（清华 pip 源） ==="
cd /root/the-basement-of-anon/backend
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip -q
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt -q
echo "依赖安装完成"

echo "=== 4/5 生成 .env 模板（稍后用 nano 填入真实值） ==="
if [ ! -f /root/the-basement-of-anon/.env ]; then
  cat > /root/the-basement-of-anon/.env << 'EOF'
DEEPSEEK_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
SESSION_SECRET=
INVITE_CODE=931226
ADMIN_USERNAMES=失败主义谋士千早爱音
EOF
  echo "已生成 .env 模板"
else
  echo ".env 已存在，跳过"
fi

echo "=== 5/5 注册 systemd 服务（开机自启 + 崩溃自动重启） ==="
cat > /etc/systemd/system/dsh.service << 'EOF'
[Unit]
Description=撷菁轩 FastAPI 后端
After=network.target

[Service]
User=root
WorkingDirectory=/root/the-basement-of-anon/backend
ExecStart=/root/the-basement-of-anon/backend/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 80
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable dsh
systemctl restart dsh

echo ""
echo "============================================================"
echo "部署完成！接下来："
echo "1) 填 .env：nano /root/the-basement-of-anon/.env"
echo "   （把本地 .env 的内容粘贴进去，Ctrl+O 回车保存，Ctrl+X 退出）"
echo "2) 重启服务：systemctl restart dsh"
echo "3) 验证：curl http://你的IP/api/health"
echo "4) 改密码：passwd（重要！）"
echo "============================================================"
