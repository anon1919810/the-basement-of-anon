# -*- coding: utf-8 -*-
"""
Supabase 数据库操作模块 v2
改进：
  - 凭据从环境变量读取（.env / Streamlit Cloud Secrets），不再硬编码
  - 密码加盐哈希（salt$sha256），兼容旧版无盐哈希并在登录后自动升级
  - init_db() 启动自检：连接异常/缺表时返回明确诊断，不再静默失败
"""
import os
import hashlib
import hmac
import base64
import time
import secrets
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

# ========== Supabase 配置（优先环境变量，缺省回退到原默认值） ==========
SUPABASE_URL = os.getenv("SUPABASE_URL") or "https://vnnhcveudcoetzcuceun.supabase.co"
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or "sb_publishable_occHvZCJl5DmiNlL08qsdQ_BnQ6szlR"

if not os.getenv("SUPABASE_URL"):
    print("[提示] 未设置 SUPABASE_URL/SUPABASE_KEY 环境变量，正在使用代码内默认值。"
          "建议配置到 .env（本地）与 Streamlit Cloud Secrets（云端）。")

# ========== 会话令牌（24小时自动登录） ==========
# 无状态HMAC签名令牌：payload=base64(user_id|过期时间戳)，mac=HMAC(SESSION_SECRET)
# 服务端验证，无需建表；SESSION_SECRET 务必在云端Secrets配置
SESSION_SECRET = os.getenv("SESSION_SECRET") or "dev-secret-change-me-please"
SESSION_HOURS = 24

if not os.getenv("SESSION_SECRET"):
    print("[警告] 未设置 SESSION_SECRET 环境变量，使用开发默认值（云端请务必在Secrets配置）")


def _session_sign(payload):
    return hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def create_session_token(user_id, hours=SESSION_HOURS):
    """生成24小时有效的登录令牌（含用户ID与过期时间，签名防伪造）"""
    expires = int(time.time()) + hours * 3600
    payload = base64.urlsafe_b64encode(f"{user_id}|{expires}".encode()).decode().rstrip("=")
    return f"{payload}.{_session_sign(payload)}"


def validate_session_token(token):
    """校验令牌，有效返回user_id字符串，无效/过期返回None"""
    if not token:
        return None
    try:
        payload, mac = token.rsplit(".", 1)
        if not hmac.compare_digest(_session_sign(payload), mac):
            return None
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
        user_id, exp = raw.split("|")
        if int(exp) < time.time():
            return None
        return user_id
    except Exception:
        return None


def get_user_by_id(user_id):
    """按ID查询用户"""
    supabase = get_supabase()
    try:
        r = supabase.table("users").select("*").eq("id", user_id).limit(1).execute()
        return r.data[0] if r.data else None
    except Exception as e:
        print(f"查询用户失败：{e}")
        return None


def get_supabase() -> Client:
    """获取 Supabase 客户端"""
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ========== 密码哈希（加盐，兼容旧版） ==========
def hash_password(password, salt=None):
    """生成加盐密码哈希，存储格式: salt$sha256(salt+password)"""
    if salt is None:
        salt = secrets.token_hex(8)
    digest = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return f"{salt}${digest}"


def verify_password(password, stored):
    """校验密码。兼容旧版无盐 sha256 格式（登录成功后由调用方升级为加盐格式）"""
    if not stored:
        return False
    if "$" in stored:
        salt, digest = stored.split("$", 1)
        expected = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
        return hmac.compare_digest(expected, digest)
    legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(legacy, stored)


# ========== 初始化 / 自检 ==========
def init_db():
    """验证数据库连接与关键表是否存在；返回 (ok, message)

    注意：Supabase 无法通过 anon key 执行 DDL 建表，
    表结构请到 Supabase 控制台 SQL Editor 执行 db_schema.sql。
    """
    supabase = get_supabase()
    try:
        supabase.table("users").select("id").limit(1).execute()
        return True, "Supabase 连接正常"
    except Exception as e:
        msg = str(e)
        lower = msg.lower()
        if "relation" in lower or "does not exist" in lower or "42p01" in lower:
            return False, "users 表不存在：请在 Supabase 控制台 SQL Editor 中执行 db_schema.sql"
        return False, f"Supabase 连接失败：{msg}"


# ========== 用户 ==========
def register_user(username, password, email="", qq=""):
    supabase = get_supabase()
    try:
        data = {
            "username": username,
            "password": hash_password(password),
            "email": email,
            "qq": qq
        }
        result = supabase.table("users").insert(data).execute()
        return len(result.data) > 0
    except Exception as e:
        print(f"注册失败：{e}")
        return False


def login_user(username, password):
    supabase = get_supabase()
    try:
        result = supabase.table("users").select("*").eq("username", username).limit(1).execute()
        if not result.data:
            return None
        user = result.data[0]
        if not verify_password(password, user.get("password", "")):
            return None
        # 旧版无盐哈希 -> 登录成功后原地升级为加盐格式
        if "$" not in user.get("password", ""):
            try:
                supabase.table("users").update({"password": hash_password(password)}).eq("id", user["id"]).execute()
                print(f"已将用户 {username} 的密码升级为加盐哈希")
            except Exception as e:
                print(f"密码升级失败（不影响登录）：{e}")
        return user
    except Exception as e:
        print(f"登录失败：{e}")
        return None


# ========== 留言 ==========
def get_messages(limit=100):
    supabase = get_supabase()
    try:
        result = supabase.table("messages").select("*").order("created_at", desc=True).limit(limit).execute()
        return result.data
    except Exception as e:
        print(f"获取留言失败：{e}")
        return []


def add_message(user_id, username, content):
    supabase = get_supabase()
    try:
        data = {
            "user_id": user_id,
            "username": username,
            "content": content
        }
        result = supabase.table("messages").insert(data).execute()
        return len(result.data) > 0
    except Exception as e:
        print(f"添加留言失败：{e}")
        return False


def delete_message(message_id, user_id):
    supabase = get_supabase()
    try:
        result = supabase.table("messages").delete().eq("id", message_id).eq("user_id", user_id).execute()
        return len(result.data) > 0
    except Exception as e:
        print(f"删除留言失败：{e}")
        return False
