import os
import hashlib
from supabase import create_client, Client

# ========== Supabase 配置 ==========
SUPABASE_URL = "https://vnnhcveudcoetzcuceun.supabase.co"
SUPABASE_KEY = "sb_publishable_occHvZCJl5DmiNlL08qsdQ_BnQ6szlR"

def get_supabase() -> Client:
    """获取 Supabase 客户端"""
    return create_client(SUPABASE_URL, SUPABASE_KEY)

def hash_password(password):
    """加密密码"""
    return hashlib.sha256(password.encode()).hexdigest()

def init_db():
    """兼容旧接口"""
    print("✅ 已连接到 Supabase 数据库")
    pass

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
        result = supabase.table("users").select("*").eq("username", username).eq("password", hash_password(password)).execute()
        if result.data:
            return result.data[0]
        return None
    except Exception as e:
        print(f"登录失败：{e}")
        return None

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