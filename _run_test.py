# -*- coding: utf-8 -*-
"""真实管线测试：用《武汉市志·文物志》PDF 跑完整提取流程"""
import json
import glob
import extract_papers as ep

pdf_path = glob.glob("*.pdf")[0]
book_name = "武汉市志 文物志"

print(">>> 开始提取...", flush=True)
entries = ep.process_pdf_file(pdf_path, book_name)
print(f">>> 完成，共 {len(entries)} 条", flush=True)

print(json.dumps(entries, ensure_ascii=False, indent=2))
