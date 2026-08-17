# -*- coding: utf-8 -*-
"""探针 v3：读 cells.cells 列表，统计自然地理分布"""
import json
import sys
from collections import Counter

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

info = data["info"]
print(f"地图: {info['mapName']}  尺寸: {info['width']}x{info['height']}  种子: {info['seed']}")

cells = data["cells"]["cells"]
print("单元格总数:", len(cells))

t = Counter(c.get("t") for c in cells)
b = Counter(c.get("b") for c in cells)
f = Counter(c.get("f") for c in cells)
hs = [c.get("h", 0) for c in cells]
temps = [c.get("temp", 0) for c in cells]
precs = [c.get("prec", 0) for c in cells]

print("地形 t 分布 (0=海?):", t.most_common(15))
print("生物群系 b 分布:", b.most_common(15))
print("植被 f 分布:", f.most_common(10))
print(f"海拔 h: min={min(hs)} max={max(hs)} 非零比例={sum(1 for x in hs if x>0)/len(hs):.2%}")
print(f"温度 temp: min={min(temps)} max={max(temps)}")
print(f"降水 prec: min={min(precs)} max={max(precs)}")

# 采样一个陆地单元格（非海洋）看完整字段
land = next((c for c in cells if c.get("t") != 0), None)
if land:
    print("陆地采样:", json.dumps(land, ensure_ascii=False)[:400])
