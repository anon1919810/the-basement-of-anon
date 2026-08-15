# 一次性移植脚本：把根目录核心模块复制进 backend/app 并改写为相对导入
# 用法：python _port_backend.py（在仓库根目录运行）
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DST = ROOT / "backend" / "app"

SRC_FILES = ["prompts.py", "postprocess.py", "ocr_engine.py", "shared.py", "extract_papers.py"]

RULES = [
    (r"^from config import", "from .config import"),
    (r"^from shared import", "from .shared import"),
    (r"^from prompts import", "from .prompts import"),
    (r"^from ocr_engine import", "from .ocr_engine import"),
    (r"^from postprocess import", "from .postprocess import"),
    (r"^from ocr_corrections import", "from .ocr_corrections import"),
    (r"^from province_dict import", "from .province_dict import"),
    (r"^import config$", "from . import config"),
]

for name in SRC_FILES:
    src = ROOT / name
    dst = DST / name
    text = src.read_text(encoding="utf-8")
    for pat, repl in RULES:
        text = re.sub(pat, repl, text, flags=re.M)
    dst.write_text(text, encoding="utf-8")
    print("ported:", name)
print("done")
