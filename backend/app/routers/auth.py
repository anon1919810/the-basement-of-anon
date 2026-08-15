"""T3 认证 API：注册 / 登录 / 登出 / 当前用户 / 自带Key / Key来源状态。

与 Streamlit 版保持同一套逻辑：
- 密码：salted sha256（database.hash_password / verify_password）
- 会话：HMAC 无状态令牌 24h（database.create_session_token / validate_session_token）
- Key 来源：用户自带Key > 管理员(作者Key) > 邀请码有效(作者Key) > 无权限
"""

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from .. import database as db
from .. import env

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    username: str
    password: str
    email: str = ""
    qq: str = ""


class LoginIn(BaseModel):
    username: str
    password: str


class KeyIn(BaseModel):
    api_key: str


def get_current_user(authorization: str = Header(default="")) -> dict:
    """Bearer 令牌 → 用户对象（失败抛 401）"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    token = authorization[7:].strip()
    uid = db.validate_session_token(token)
    if not uid:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    user = db.get_user_by_id(uid)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def _public_user(user: dict) -> dict:
    """脱敏后的用户信息（绝不外泄加密Key）"""
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "is_admin": user.get("username") in env.ADMIN_USERNAMES,
        "invite_until": user.get("invite_until"),
        "has_own_key": bool(user.get("api_key")),
    }


def resolve_key_source(user: dict) -> tuple:
    """返回 (来源, 有效Key)。来源：user / admin / invite / (None, None)"""
    user_key = db.get_api_key(user["id"])
    if user_key:
        return "user", user_key
    if user.get("username") in env.ADMIN_USERNAMES:
        return "admin", None
    if env.INVITE_CODE and db.get_invite(user["id"]):
        return "invite", None
    return None, None


@router.post("/register")
def register(body: RegisterIn):
    username = body.username.strip()
    password = body.password
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="用户名至少2个字符")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="密码至少4个字符")
    ok = db.register_user(username, password, body.email.strip(), body.qq.strip())
    if not ok:
        raise HTTPException(status_code=409, detail="用户名已被占用")
    user = db.login_user(username, password)
    return {"ok": True, "message": "注册成功", "user": _public_user(user) if user else None}


@router.post("/login")
def login(body: LoginIn):
    user = db.login_user(body.username.strip(), body.password)
    if not user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = db.create_session_token(user["id"], hours=env.SESSION_HOURS)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.post("/logout")
def logout():
    # 无状态令牌：客户端丢弃即可
    return {"ok": True, "message": "已退出"}


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {"ok": True, "user": _public_user(user)}


@router.post("/key")
def save_key(body: KeyIn, user: dict = Depends(get_current_user)):
    key = body.api_key.strip()
    if not key.startswith("sk-"):
        raise HTTPException(status_code=400, detail="Key 格式不正确（应以 sk- 开头）")
    ok, msg = db.save_api_key(user["id"], key)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.get("/key-status")
def key_status(user: dict = Depends(get_current_user)):
    src, _key = resolve_key_source(user)
    labels = {
        "user": "使用你自己的 Key",
        "admin": "使用作者 Key（管理员）",
        "invite": "使用作者 Key（邀请码有效期内）",
    }
    if src is None:
        if env.REQUIRE_KEY_OR_INVITE:
            return {"ok": True, "source": None, "allowed": False,
                    "message": "无 AI 使用权限：请设置自己的 Key 或填写邀请码"}
        return {"ok": True, "source": None, "allowed": True,
                "message": "使用作者默认 Key"}
    return {"ok": True, "source": src, "allowed": True,
            "message": labels[src], "key_configured": src == "user"}
