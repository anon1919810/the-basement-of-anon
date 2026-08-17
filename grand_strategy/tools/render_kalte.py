# -*- coding: utf-8 -*-
"""把 Azgaar GridCells 数据渲染成地图 PNG，验证可用性"""
import json
import sys
from PIL import Image, ImageDraw

path = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "kalte_preview.png"

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

info = data["info"]
W, H = info["width"], info["height"]
cells = data["cells"]["cells"]
verts = data["cells"]["vertices"]

# 顶点坐标格式探测（Azgaar 顶点: {i, p:[x,y], v, c}）
def vxy(i):
    v = verts[i]
    p = v.get("p") if isinstance(v, dict) else None
    if p:
        return p[0], p[1]
    return (v[0], v[1]) if isinstance(v, list) else (0, 0)

img = Image.new("RGB", (W, H), (10, 20, 40))
d = ImageDraw.Draw(img)

# 找到陆地阈值：h>0 且 t>0 视为陆地（先按 t 试探，再用 h 上色）
sea_max_h = max((c.get("h", 0) for c in cells if c.get("t", 0) <= 0), default=0)
print(f"海洋最大 h={sea_max_h}（陆地阈值参考）")

land = sea = 0
for c in cells:
    t = c.get("t", 0)
    h = c.get("h", 0)
    temp = c.get("temp", 0)
    pts = [vxy(i) for i in c.get("v", [])]
    if len(pts) < 3:
        continue
    if t > 0 or h > sea_max_h:
        land += 1
        # 海拔上色：低=绿，中=黄褐，高=棕白
        if h > 60:
            col = (200, 200, 200)
        elif h > 35:
            col = (140, 110, 80)
        elif h > 18:
            col = (160, 160, 90)
        elif temp < -10:
            col = (150, 170, 180)  # 寒冷
        else:
            col = (90, 160, 90)
    else:
        sea += 1
        col = (30, 60, 110) if h > 3 else (15, 35, 80)
    d.polygon(pts, fill=col)

img.save(out)
print(f"已渲染 {out}: {W}x{H}，陆地 {land} 格，海洋 {sea} 格")
