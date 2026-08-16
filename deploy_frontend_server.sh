#!/bin/bash
# ============================================================
# 撷菁轩前端 · 部署到轻量服务器（nginx 托管 React + 代理 /api）
# 前置：后端已上线（dsh.service 在跑）
# 用法：以 root 登录服务器后：
#   cd /root/the-basement-of-anon
#   git pull
#   bash deploy_frontend_server.sh
# ============================================================
set -e

echo "=== 1/5 后端改到 8000 端口（把 80 让给 nginx） ==="
sed -i 's/--port 80/--port 8000/' /etc/systemd/system/dsh.service
systemctl daemon-reload
systemctl restart dsh
sleep 2
curl -s -o /dev/null -w "后端(8000)状态码: %{http_code}\n" http://127.0.0.1:8000/api/health

echo "=== 2/5 安装 nginx ==="
apt-get install -y nginx > /dev/null 2>&1

echo "=== 3/5 安装 Node.js 22（腾讯云镜像） ==="
if ! command -v node > /dev/null 2>&1; then
  cd /tmp
  wget -q https://mirrors.cloud.tencent.com/nodejs-release/v22.12.0/node-v22.12.0-linux-x64.tar.xz
  tar -xJf node-v22.12.0-linux-x64.tar.xz -C /usr/local
  ln -sf /usr/local/node-v22.12.0-linux-x64/bin/node /usr/local/bin/node
  ln -sf /usr/local/node-v22.12.0-linux-x64/bin/npm /usr/local/bin/npm
fi
node -v
npm config set registry https://registry.npmmirror.com

echo "=== 4/5 构建前端 ==="
cd /root/the-basement-of-anon/frontend
npm install
npm run build
echo "前端构建完成"

echo "=== 5/5 配置 nginx（静态托管 + /api 代理到 8000，SSE 关闭缓冲） ==="
cat > /etc/nginx/sites-available/dsh << 'EOF'
server {
    listen 80 default_server;
    server_name _;

    root /root/the-basement-of-anon/frontend/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
ln -sf /etc/nginx/sites-available/dsh /etc/nginx/sites-enabled/dsh
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo ""
echo "============================================================"
echo "前端部署完成！访问: http://你的IP/   （React 界面）"
echo "后端验证:  curl http://127.0.0.1:8000/api/health"
echo "============================================================"
