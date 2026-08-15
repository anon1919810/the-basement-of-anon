"""T5 提取 API（同步版）：上传 PDF/Word → AI 提取 → 入库。

与 Streamlit 版行为一致：
- 权限：resolve_key_source（用户Key > 管理员 > 邀请码），无权限且 REQUIRE_KEY_OR_INVITE 时 403
- 提取：process_pdf_file（文本层/OCR 自动判定、多轮并集、缓存、后处理全链路复用）
- 入库：save_extraction（表不存在时优雅返回 0）
"""

import os
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .. import config as app_config
from .. import database as db
from .. import env
from .. import extract_papers as extract_mod
from .auth import get_current_user, resolve_key_source

router = APIRouter(prefix="/api/extract", tags=["extract"])

MAX_UPLOAD_MB = 10
ALLOWED_EXT = {".pdf", ".docx", ".doc"}
TEMP_ROOT = Path(__file__).resolve().parent.parent.parent / "temp_pdfs"


@router.post("")
async def extract(
    book_name: str = Form(""),
    extract_max_only: bool = Form(True),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    # 1) 权限判定（与 app.py 一致）
    source, user_key = resolve_key_source(user)
    if source is None and env.REQUIRE_KEY_OR_INVITE:
        raise HTTPException(status_code=403, detail="无 AI 使用权限：请设置自己的 Key 或填写邀请码")

    # 2) 文件校验
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail="仅支持 PDF / Word（.pdf .docx .doc）文件")
    content = await file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"文件超过 {MAX_UPLOAD_MB}MB 限制")

    # 3) 运行期配置覆盖（与 app.py 的全局+模块双写一致）
    app_config.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.EXTRACT_MAX_ONLY = extract_max_only
    extract_mod.ACTIVE_API_KEY = user_key if source == "user" else None

    # 4) 独立临时目录 → 提取 → 清理
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="run_", dir=str(TEMP_ROOT))
    try:
        save_path = os.path.join(tmpdir, filename or ("upload" + ext))
        with open(save_path, "wb") as f:
            f.write(content)
        entries = extract_mod.process_pdf_file(save_path, book_name or "未命名文献")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # 5) 入库（不阻塞：失败只记日志，仍返回结果）
    source_text = "\n".join(extract_mod.LAST_SOURCES[-1:])
    record_id = db.save_extraction(
        user["id"], user.get("username", ""), book_name,
        filename, entries, source_text=source_text,
    )

    return {
        "ok": True,
        "record_id": record_id,
        "entry_count": len(entries),
        "entries": entries,
    }
