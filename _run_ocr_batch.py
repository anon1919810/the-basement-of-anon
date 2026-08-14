# -*- coding: utf-8 -*-
"""批量处理两份扫描版《武汉市志·文物志》（76-90页 / 91-105页），验证跨文件合并"""
import os
import json
import extract_papers as ep

TARGETS = [
    "武汉市志 文物志76-90.pdf",
    "武汉市志 文物志 sk,91-105.pdf",
]
BOOK_NAME = "武汉市志 文物志"
os.makedirs("results", exist_ok=True)

print(f"开始并行处理 {len(TARGETS)} 份扫描件...", flush=True)
all_entries = ep.process_pdfs_parallel(TARGETS, BOOK_NAME, max_workers=2)

out = os.path.join("results", "文物志76-105_合并.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(all_entries, f, ensure_ascii=False, indent=2)

cats = {}
for e in all_entries:
    cats[e.get("类别", "")] = cats.get(e.get("类别", ""), 0) + 1
print(f"合并后共 {len(all_entries)} 条 -> {out}", flush=True)
print(f"类别分布: {cats}", flush=True)
print(f"名称列表: {[e['名称'] for e in all_entries]}", flush=True)
