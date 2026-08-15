"""环境变量加载：从仓库根目录 .env 读取（与 Streamlit 版共用一份 .env）。

注意：backend/app/config.py 为调参常量（与根目录 config.py 一致），
本模块负责所有"环境变量驱动"的配置（密钥、URL、白名单等）。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# backend/app/env.py -> backend -> 仓库根目录
BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

SESSION_SECRET = os.getenv("SESSION_SECRET", "")
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "24"))
INVITE_CODE = os.getenv("INVITE_CODE", "931226")
ADMIN_USERNAMES = {u.strip() for u in os.getenv("ADMIN_USERNAMES", "").split(",") if u.strip()}

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

# 权限开关：True=非管理员用户必须自带Key或有效邀请码才能提取
REQUIRE_KEY_OR_INVITE = os.getenv("REQUIRE_KEY_OR_INVITE", "true").lower() != "false"

CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    ).split(",")
    if o.strip()
]
