"""T5+T6 提取 API：同步版 + SSE 进度流版。

与 Streamlit 版行为一致：
- 权限：resolve_key_source（用户Key > 管理员 > 邀请码），无权限且 REQUIRE_KEY_OR_INVITE 时 403
- 提取：process_pdf_file（文本层/OCR 自动判定、多轮并集、缓存、后处理全链路复用）
- 入库：save_extraction（表不存在时优雅返回 0）
- /stream：SSE 推送阶段进度（saving → extracting → done / error），供前端进度条
"""

import io
import json
import os
import queue
import shutil
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from openpyxl import Workbook
from pydantic import BaseModel

from .. import config as app_config
from .. import database as db
from .. import env
from .. import extract_papers as extract_mod
from .auth import get_current_user, resolve_key_source

router = APIRouter(prefix="/api/extract", tags=["extract"])

MAX_UPLOAD_MB = 10
ALLOWED_EXT = {".pdf", ".docx", ".doc"}
TEMP_ROOT = Path(__file__).resolve().parent.parent.parent / "temp_pdfs"


def _prepare(user: dict, book_name: str, extract_max_only: bool, filename: str, content: bytes):
    """校验 + 配置覆盖；返回 (save_path, tmpdir)。无权限/非法文件抛 HTTPException。"""
    source, user_key = resolve_key_source(user)
    if source is None and env.REQUIRE_KEY_OR_INVITE:
        raise HTTPException(status_code=403, detail="无 AI 使用权限：请设置自己的 Key 或填写邀请码")

    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail="仅支持 PDF / Word（.pdf .docx .doc）文件")
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"文件超过 {MAX_UPLOAD_MB}MB 限制")

    app_config.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.ACTIVE_API_KEY = user_key if source == "user" else None

    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="run_", dir=str(TEMP_ROOT))
    save_path = os.path.join(tmpdir, filename or ("upload" + ext))
    with open(save_path, "wb") as f:
        f.write(content)
    return save_path, tmpdir


def _finish(user: dict, book_name: str, filename: str, entries: list) -> int:
    """入库（不阻塞，失败只记日志）"""
    source_text = "\n".join(extract_mod.LAST_SOURCES[-1:])
    return db.save_extraction(
        user["id"], user.get("username", ""), book_name,
        filename, entries, source_text=source_text,
    )


@router.post("")
async def extract(
    book_name: str = Form(""),
    extract_max_only: bool = Form(True),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    filename = file.filename or ""
    content = await file.read()
    save_path, tmpdir = _prepare(user, book_name, extract_max_only, filename, content)
    try:
        entries = extract_mod.process_pdf_file(save_path, book_name or "未命名文献")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    record_id = _finish(user, book_name, filename, entries)
    return {"ok": True, "record_id": record_id, "entry_count": len(entries), "entries": entries}


@router.post("/stream")
async def extract_stream(
    book_name: str = Form(""),
    extract_max_only: bool = Form(True),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    filename = file.filename or ""
    content = await file.read()
    save_path, tmpdir = _prepare(user, book_name, extract_max_only, filename, content)

    q: "queue.Queue[dict]" = queue.Queue()
    done_holder = {}

    def _emit(evt: dict):
        q.put(evt)

    def worker():
        try:
            _emit({"type": "stage", "stage": "saving", "message": "文件已接收，开始读取"})
            entries = extract_mod.process_pdf_file(save_path, book_name or "未命名文献")
            _emit({"type": "stage", "stage": "extracting", "message": f"提取完成，共 {len(entries)} 条"})
            record_id = _finish(user, book_name, filename, entries)
            done_holder["result"] = {"record_id": record_id, "entry_count": len(entries), "entries": entries}
            _emit({"type": "done", "record_id": record_id, "entry_count": len(entries), "entries": entries})
        except Exception as e:
            _emit({"type": "error", "detail": str(e)})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    threading.Thread(target=worker, daemon=True).start()

    def gen():
        while True:
            try:
                evt = q.get(timeout=1.0)
            except queue.Empty:
                continue
            yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
            if evt.get("type") in ("done", "error"):
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ExportIn(BaseModel):
    book_name: str = ""
    entries: list[dict] = []


@router.post("/export")
def export_excel(body: ExportIn, user: dict = Depends(get_current_user)):
    """把条目导出为 Excel（openpyxl），前端直接下载。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "文化要素"
    ws.append(["名称", "类别", "时间", "空间", "流域", "基础信息", "历史文献"])
    for e in body.entries:
        ws.append([e.get("名称"), e.get("类别"), e.get("时间"), e.get("空间"),
                   e.get("流域"), e.get("基础信息"), e.get("历史文献")])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = (body.book_name or "文化要素提取结果") + ".xlsx"
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
