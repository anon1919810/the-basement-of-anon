# -*- coding: utf-8 -*-
"""渲染《卡尔特》v0.5 新行政图：省份按国着色 + 省界白细线 + 国界深色加粗 + 海峡要道标注。

数据来源：game/scripts/admin_v05.json（由 game/scripts/export_admin.ts 导出，
单一数据源 = src/game/map.ts 的归属逻辑，与游戏内完全一致，避免 Python 侧逻辑漂移）。
输出：kalte_admin_v05.png（仓库根目录，与 v0.4 的 kalte_admin.png 并列）。
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根（tools/ 上一级）
JSON = os.path.join(ROOT, "game", "scripts", "admin_v05.json")
OUT = os.path.join(ROOT, "kalte_admin_v05.png")

# 与 src/game/nations.ts 配色保持一致（修改需同步）
COLORS = {
    "empire": (150, 40, 45),
    "lorraine": (70, 110, 200),
    "ianys": (200, 170, 60),
    "orange": (230, 140, 40),
    "zalakN": (90, 160, 90),
    "zalakS": (60, 140, 140),
    "angland": (140, 90, 180),
    "normandy": (120, 30, 60),
    "undiscovered": (34, 44, 60),
}
NAMES = {
    "empire": "申斯戈维克帝国",
    "lorraine": "洛林共和国",
    "ianys": "伊尼亚斯王国",
    "orange": "奥兰治亲王国",
    "zalakN": "北扎拉克选帝侯国",
    "zalakS": "南扎拉克选帝侯国",
    "angland": "盎格伦撒自由城邦",
    "normandy": "诺曼尼亚帝国",
    "undiscovered": "未探明新大陆",
}

with open(JSON, "r", encoding="utf-8") as f:
    data = json.load(f)
W, H = data["width"], data["height"]

img = Image.new("RGB", (W, H), (10, 22, 46))
d = ImageDraw.Draw(img)

# 1) 省份填充（属国色；迷雾深灰）
for prov in data["provinces"]:
    col = COLORS.get(prov["owner"], (34, 44, 60))
    for c in prov["cells"]:
        poly = c["poly"]
        if len(poly) >= 3:
            d.polygon(poly, fill=col)

# 2) 省界白细线（非迷雾）
for prov in data["provinces"]:
    if prov["owner"] == "undiscovered":
        continue
    for c in prov["cells"]:
        poly = c["poly"]
        if len(poly) >= 3 and c["provinceBorder"]:
            d.line(poly + [poly[0]], fill=(255, 255, 255), width=1)

# 3) 国界深色加粗
for prov in data["provinces"]:
    if prov["owner"] == "undiscovered":
        continue
    for c in prov["cells"]:
        poly = c["poly"]
        if len(poly) >= 3 and c["nationalBorder"]:
            d.line(poly + [poly[0]], fill=(18, 18, 20), width=3)

# 4) 迷雾新大陆：虚线描边（PIL 无原生虚线，用短线段逼近）
for prov in data["provinces"]:
    if prov["owner"] != "undiscovered":
        continue
    for c in prov["cells"]:
        poly = c["poly"]
        if len(poly) < 3:
            continue
        pts = poly + [poly[0]]
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            seg = 6
            total = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
            n = max(1, int(total / seg))
            for k in range(n):
                if k % 2 == 0:
                    a = k / n
                    b = min(1.0, (k + 0.6) / n)
                    d.line([(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a),
                            (x1 + (x2 - x1) * b, y1 + (y2 - y1) * b)],
                           fill=(140, 155, 175), width=2)

# 5) 海峡要道标注（金色星标 + 标签）
for prov in data["provinces"]:
    if prov["strait"]:
        cx, cy = prov["centroid"]
        r = 7
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 200, 60), outline=(20, 20, 20))
        d.text((cx + 9, cy - 6), "海峡", fill=(255, 200, 60))

# 6) 标题 / 迷雾标签
d.text((14, 12), "《卡尔特》v0.5 行政图（省份按国着色 · 白细线=省界 · 深色=国界 · 金星=海峡要道）", fill=(235, 240, 245))
d.text((int(W * 0.70), 40), "新大陆（未探明）", fill=(170, 185, 205))

# 7) 图例
lx, ly = 14, 34
try:
    font = ImageFont.truetype("msyh.ttc", 16)
except Exception:
    font = ImageFont.load_default()
for i, (key, col) in enumerate(COLORS.items()):
    d.rectangle([lx, ly + i * 22, lx + 16, ly + i * 22 + 12], fill=col)
    d.text((lx + 22, ly + i * 22), NAMES[key], fill=(230, 235, 240), font=font)
d.text((lx, ly + len(COLORS) * 22 + 6), "帝国=北大陆北+西 · 奥兰治/盎格伦撒=海峡两侧 · 迷雾不变", fill=(170, 185, 205))

img.save(OUT)
print("已保存", OUT)
