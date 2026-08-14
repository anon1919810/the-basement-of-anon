import sqlite3
import hashlib
import datetime

DB_PATH = "data.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """初始化数据库表"""
    conn = get_db()
    cursor = conn.cursor()
    
    # 用户表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email TEXT,
            qq TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # 留言表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    ''')
    
    conn.commit()
    conn.close()

def hash_password(password):
    """加密密码"""
    return hashlib.sha256(password.encode()).hexdigest()

def register_user(username, password, email="", qq=""):
    """注册用户"""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO users (username, password, email, qq) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), email, qq)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

def login_user(username, password):
    """登录验证"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE username = ? AND password = ?",
        (username, hash_password(password))
    )
    user = cursor.fetchone()
    conn.close()
    return user

def get_messages(limit=100):
    """获取留言列表"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM messages ORDER BY created_at DESC LIMIT ?",
        (limit,)
    )
    messages = cursor.fetchall()
    conn.close()
    return messages

def add_message(user_id, username, content):
    """添加留言"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (user_id, username, content) VALUES (?, ?, ?)",
        (user_id, username, content)
    )
    conn.commit()
    conn.close()

def delete_message(message_id, user_id):
    """删除自己的留言"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "DELETE FROM messages WHERE id = ? AND user_id = ?",
        (message_id, user_id)
    )
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted