"""T7 AI 对话与条目补充 API。

与 app.py 的 AI 工作台逻辑一致：
- 权限：resolve_key_source（_ai_ready 同款）
- 自由对话：SSE 流式（chat_completion_stream，取最近8条）
- 条目补充：chat_completion 单次调用，输出不超过150字的补充后基础信息
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import env
from .. import extract_papers as extract_mod
from .auth import get_current_user, resolve_key_source

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMsg(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: list[ChatMsg]


class SupplementIn(BaseModel):
    name: str
    category: str = ""
    time: str = ""
    space: str = ""
    info: str = ""
    quote: str = ""


def _ai_ready(user: dict) -> tuple:
    """AI 权限检查 + 设置本次调用的 Key（与 app.py _ai_ready 一致）"""
    source, key = resolve_key_source(user)
    if source is None and env.REQUIRE_KEY_OR_INVITE:
        return False, "无 AI 使用权限：请设置自己的 Key 或填写邀请码"
    extract_mod.ACTIVE_API_KEY = key if source == "user" else None
    return True, ""


@router.post("")
async def chat(body: ChatIn, user: dict = Depends(get_current_user)):
    ok, tip = _ai_ready(user)
    if not ok:
        raise HTTPException(status_code=403, detail=tip)
    msgs = [{"role": m.role, "content": m.content} for m in body.messages]

    def gen():
        for delta in extract_mod.chat_completion_stream(msgs[-8:]):
            if delta is None:
                yield f"data: {json.dumps({'type': 'error', 'detail': 'AI 调用失败（请检查 Key 是否有效/有余额）'}, ensure_ascii=False)}\n\n"
                return
            yield f"data: {json.dumps({'type': 'delta', 'content': delta}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/supplement")
def supplement(body: SupplementIn, user: dict = Depends(get_current_user)):
    ok, tip = _ai_ready(user)
    if not ok:
        raise HTTPException(status_code=403, detail=tip)
    ctx = (
        f"名称：{body.name}\n类别：{body.category}\n时间：{body.time}\n"
        f"空间：{body.space}\n基础信息：{body.info}\n"
        f"历史文献：{body.quote[:200]}"
    )
    msgs = [
        {"role": "system", "content": "你是文史研究助手。请基于条目信息和你的知识，"
                                      "补充更详实的基础信息（史实、背景、意义等），"
                                      "用简洁中文，不超过150字，只输出补充后的基础信息全文。"},
        {"role": "user", "content": ctx},
    ]
    reply = extract_mod.chat_completion(msgs)
    if not reply:
        raise HTTPException(status_code=502, detail="AI 调用失败（请检查 Key 是否有效/有余额）")
    return {"ok": True, "reply": reply}
