"""后端配置：从仓库根目录 .env 加载环境变量（与 Streamlit 版共用一份 .env）。"""

import os
from pathlib import Path

from dotenv import load_dotenv

# backend/app/config.py -> backend -> 仓库根目录
BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

APP_NAME = os.getenv("APP_NAME", "杨端明的撷菁轩")
VERSION = os.getenv("VERSION", "4.7.0")
VERSION_TAG = "车书万里"

SESSION_SECRET = os.getenv("SESSION_SECRET", "")
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "24"))
INVITE_CODE = os.getenv("INVITE_CODE", "931226")
ADMIN_USERNAMES = {u.strip() for u in os.getenv("ADMIN_USERNAMES", "").split(",") if u.strip()}

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    ).split(",")
    if o.strip()
]
