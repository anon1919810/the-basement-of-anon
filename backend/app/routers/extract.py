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


async def _prepare_many(user: dict, book_name: str, extract_max_only: bool, files: list[UploadFile]):
    """校验 + 配置覆盖；返回 (save_paths, tmpdir)。支持多文件。"""
    source, user_key = resolve_key_source(user)
    if source is None and env.REQUIRE_KEY_OR_INVITE:
        raise HTTPException(status_code=403, detail="无 AI 使用权限：请设置自己的 Key 或填写邀请码")

    app_config.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.ACTIVE_API_KEY = user_key if source == "user" else None

    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="run_", dir=str(TEMP_ROOT))
    save_paths = []
    try:
        for f in files:
            filename = f.filename or ""
            ext = Path(filename).suffix.lower()
            if ext not in ALLOWED_EXT:
                raise HTTPException(status_code=400,
                                    detail=f"不支持的文件类型：{filename}（仅支持 PDF / Word）")
            content = await f.read()
            if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(status_code=413,
                                    detail=f"文件超过 {MAX_UPLOAD_MB}MB 限制：{filename}")
            save_path = os.path.join(tmpdir, filename or ("upload" + ext))
            with open(save_path, "wb") as fp:
                fp.write(content)
            save_paths.append(save_path)
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    if not save_paths:
        raise HTTPException(status_code=400, detail="没有收到文件")
    return save_paths, tmpdir


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
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
):
    save_paths, tmpdir = await _prepare_many(user, book_name, extract_max_only, files)
    try:
        all_entries = []
        for sp in save_paths:
            all_entries.extend(extract_mod.process_pdf_file(sp, book_name or "未命名文献"))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    # 历史文献标注来源：《书名》："引文"（与命令行导出格式一致）
    for _e in all_entries:
        _q = _e.get("历史文献")
        if _q:
            _e["历史文献"] = extract_mod.format_quote(_q, book_name)
    record_id = _finish(user, book_name, ", ".join(os.path.basename(p) for p in save_paths), all_entries)
    return {"ok": True, "record_id": record_id, "entry_count": len(all_entries), "entries": all_entries}


@router.post("/stream")
async def extract_stream(
    book_name: str = Form(""),
    extract_max_only: bool = Form(True),
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
):
    save_paths, tmpdir = await _prepare_many(user, book_name, extract_max_only, files)

    q: "queue.Queue[dict]" = queue.Queue()

    def _emit(evt: dict):
        q.put(evt)

    def worker():
        try:
            all_entries = []
            total = len(save_paths)
            for idx, sp in enumerate(save_paths, start=1):
                name = os.path.basename(sp)
                _emit({"type": "stage", "stage": "extracting",
                       "message": f"处理 {idx}/{total}：{name}"})
                entries = extract_mod.process_pdf_file(sp, book_name or "未命名文献")
                all_entries.extend(entries)
            # 历史文献标注来源：《书名》："引文"
            for _e in all_entries:
                _q = _e.get("历史文献")
                if _q:
                    _e["历史文献"] = extract_mod.format_quote(_q, book_name)
            _emit({"type": "stage", "stage": "merging",
                   "message": f"合并完成，共 {len(all_entries)} 条"})
            record_id = _finish(user, book_name,
                                ", ".join(os.path.basename(p) for p in save_paths), all_entries)
            _emit({"type": "done", "record_id": record_id,
                   "entry_count": len(all_entries), "entries": all_entries})
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


# ---------- 提取记录历史（本人） ----------
@router.get("/history")
def history(user: dict = Depends(get_current_user)):
    rows = db.list_extractions(limit=100, user_id=user["id"])
    items = [
        {
            "id": r.get("id"),
            "book_name": r.get("book_name"),
            "file_name": r.get("file_name"),
            "entry_count": r.get("entry_count"),
            "rating": r.get("rating"),
            "created_at": r.get("created_at"),
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.get("/history/{record_id}")
def history_detail(record_id: int, user: dict = Depends(get_current_user)):
    row = db.get_extraction_by_id(record_id)
    if not row or str(row.get("user_id")) != str(user["id"]):
        raise HTTPException(status_code=404, detail="记录不存在")
    try:
        entries = json.loads(row.get("result_json") or "[]")
    except Exception:
        entries = []
    return {"ok": True, "book_name": row.get("book_name"),
            "created_at": row.get("created_at"), "entries": entries}


@router.delete("/history/{record_id}")
def history_delete(record_id: int, user: dict = Depends(get_current_user)):
    ok = db.delete_own_extraction(record_id, user["id"])
    if not ok:
        raise HTTPException(status_code=404, detail="记录不存在或无权删除")
    return {"ok": True, "message": "已删除"}


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
