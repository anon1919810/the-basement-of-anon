"""T8 评分 / 统计看板 / 留言板 API。

数据全部复用 database.py（Supabase），统计分布从 extraction_results 的 result_json 现算。
"""

import json
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import database as db
from .auth import get_current_user

router = APIRouter(prefix="/api", tags=["social"])


class RatingIn(BaseModel):
    record_id: int
    rating: int
    feedback: str = ""


class MessageIn(BaseModel):
    content: str


def _distribution(rows: list) -> dict:
    cat, basin = Counter(), Counter()
    for row in rows:
        try:
            entries = json.loads(row.get("result_json") or "[]")
        except Exception:
            continue
        for e in entries:
            cat[e.get("类别") or "不详"] += 1
            basin[e.get("流域") or "不详"] += 1
    return dict(cat), dict(basin)


@router.post("/rating")
def rate(body: RatingIn, user: dict = Depends(get_current_user)):
    if not 1 <= body.rating <= 10:
        raise HTTPException(status_code=400, detail="评分范围 1-10")
    ok = db.update_rating(body.record_id, body.rating, body.feedback)
    if not ok:
        raise HTTPException(status_code=400, detail="更新评分失败（记录不存在？）")
    return {"ok": True, "message": "已保存评分"}


@router.get("/stats")
def stats(user: dict = Depends(get_current_user)):
    recent = db.list_extractions(limit=500)
    cat_dist, basin_dist = _distribution(recent)
    return {
        "ok": True,
        "user_stats": db.get_user_stats(),
        "recent": db.list_extractions(limit=20),
        "high_rated": db.get_high_rated_extractions(min_rating=8, limit=50),
        "category_distribution": cat_dist,
        "basin_distribution": basin_dist,
        "total_records": len(recent),
        "total_entries": sum(int(r.get("entry_count") or 0) for r in recent),
    }


@router.get("/messages")
def messages(user: dict = Depends(get_current_user)):
    return {"ok": True, "messages": db.get_messages(limit=50)}


@router.post("/messages")
def add_message(body: MessageIn, user: dict = Depends(get_current_user)):
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="留言不能为空")
    ok = db.add_message(user["id"], user.get("username", ""), content)
    if not ok:
        raise HTTPException(status_code=400, detail="留言失败")
    return {"ok": True, "message": "留言成功"}


@router.delete("/messages/{message_id}")
def delete_message(message_id: int, user: dict = Depends(get_current_user)):
    ok = db.delete_message(message_id, user["id"])
    if not ok:
        raise HTTPException(status_code=404, detail="留言不存在或无权删除")
    return {"ok": True, "message": "已删除"}
