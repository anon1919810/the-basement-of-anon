"""T9 管理后台 API（仅管理员：username 在 ADMIN_USERNAMES 中）。"""

from fastapi import APIRouter, Depends, HTTPException

from .. import database as db
from .. import env
from .auth import get_current_user

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_admin(user: dict) -> dict:
    if user.get("username") not in env.ADMIN_USERNAMES:
        raise HTTPException(status_code=403, detail="仅管理员可访问")
    return user


@router.get("/users")
def admin_users(user: dict = Depends(get_current_user)):
    _require_admin(user)
    return {"ok": True, "stats": db.get_user_stats(), "key_users": db.list_users_with_keys()}


@router.post("/users/{user_id}/grant-invite")
def grant_invite(user_id: str, user: dict = Depends(get_current_user)):
    _require_admin(user)
    ok = db.save_invite(user_id, hours=24)
    if not ok:
        raise HTTPException(status_code=400, detail="开通邀请失败")
    return {"ok": True, "message": "已开通24小时邀请"}


@router.post("/users/{user_id}/clear-key")
def clear_key(user_id: str, user: dict = Depends(get_current_user)):
    _require_admin(user)
    db.clear_api_key(user_id)
    return {"ok": True, "message": "已清空该用户的Key与邀请状态"}


@router.get("/extractions")
def admin_extractions(user: dict = Depends(get_current_user)):
    _require_admin(user)
    return {"ok": True, "extractions": db.list_extractions(limit=100)}


@router.delete("/extractions/{record_id}")
def delete_extraction(record_id: int, user: dict = Depends(get_current_user)):
    _require_admin(user)
    ok = db.delete_extraction(record_id)
    if not ok:
        raise HTTPException(status_code=404, detail="记录不存在")
    return {"ok": True, "message": "已删除提取记录"}


@router.delete("/messages/{message_id}")
def delete_message_any(message_id: int, user: dict = Depends(get_current_user)):
    _require_admin(user)
    ok = db.delete_message_any(message_id)
    if not ok:
        raise HTTPException(status_code=404, detail="留言不存在")
    return {"ok": True, "message": "已删除留言"}
