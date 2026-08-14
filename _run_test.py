# -*- coding: utf-8 -*-
"""快速回归测试：自动挑选"体积最小的PDF"跑完整管线（避免误选124页社会志触发全量OCR）"""
import glob
import os
import pymupdf as fitz
import extract_papers as ep

# 排除大扫描件（如124页社会志），选页数最少的PDF
candidates = []
for pdf in glob.glob("*.pdf"):
    try:
        with fitz.open(pdf) as doc:
            if doc.page_count <= 30:  # 只测小文件
                candidates.append((doc.page_count, pdf))
    except Exception as e:
        print(f"跳过 {pdf}: {e}")
if not candidates:
    print("没有合适的小PDF，请传入具体文件名")
    raise SystemExit(1)
candidates.sort()
_, pdf = candidates[0]
print(f">>> 回归测试文件: {pdf}")

entries = ep.process_pdf_file(pdf, "武汉市志 文物志")
print(f">>> 提取 {len(entries)} 条")
for e in entries:
    print(f"    - {e['名称']} | {e['类别']} | {e['空间']}")
