# -*- coding: utf-8 -*-
"""把 Azgaar 三维地形 OBJ 渲染成等高线底图（hillshade + 分带配色 + 经纬网格）"""
import sys
import numpy as np
from PIL import Image

OBJ = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\杨睿\Desktop\给soyorin看的\Kalte 2026-08-17-17-46.obj"
OUT = sys.argv[2] if len(sys.argv) > 2 else "data/kalte_relief.png"
W, H = 1920, 1080

print("解析 OBJ（147MB，稍等）...")
hmap = np.full((H, W), np.nan, dtype=np.float32)
n = 0
with open(OBJ, "r", encoding="utf-8", errors="ignore") as f:
    for line in f:
        if line.startswith("v "):
            parts = line.split()
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            px, py = int(x + W / 2), int(z + H / 2)
            if 0 <= px < W and 0 <= py < H:
                hmap[py, px] = y
                n += 1
print(f"顶点落图: {n}")

# 填充空洞（迭代平均，最多 60 轮）
print("填充空洞...")
for _ in range(60):
    mask = np.isnan(hmap)
    if not mask.any():
        break
    filled = ~mask
    up = np.roll(filled, 1, 0); down = np.roll(filled, -1, 0)
    left = np.roll(filled, 1, 1); right = np.roll(filled, -1, 1)
    neigh = (up.astype(int) + down.astype(int) + left.astype(int) + right.astype(int)) >= 1
    todo = mask & neigh
    if not todo.any():
        break
    vals = np.zeros_like(hmap)
    cnt = np.zeros((H, W), dtype=np.float32)
    for shift in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        s = np.roll(hmap, shift, axis=(0, 1))
        ok = ~np.isnan(s)
        vals += np.where(ok, s, 0)
        cnt += ok.astype(np.float32)
    avg = np.where(cnt > 0, vals / np.maximum(cnt, 1), 0)
    hmap[todo] = avg[todo]

hmap = np.where(np.isnan(hmap), -5.0, hmap)  # 未填处当海床
lo, hi = np.nanmin(hmap), np.nanmax(hmap)
print(f"高度范围: {lo:.2f} ~ {hi:.2f}")

# 分带配色（等高线带效果；OBJ 高度：海床≈0.6，陆地≈10~50）
BANDS = [
    (-999, 2.0, (10, 26, 58)),    # 深海
    (2.0, 5.0, (14, 40, 78)),     # 浅海
    (5.0, 8.0, (20, 54, 92)),     # 近岸
    (8.0, 10.5, (150, 150, 130)), # 海岸滩涂
    (10.5, 15.0, (66, 120, 74)),  # 低地绿
    (15.0, 22.0, (96, 140, 80)),  # 丘陵
    (22.0, 30.0, (150, 140, 90)), # 山地
    (30.0, 38.0, (160, 120, 90)), # 高山
    (38.0, 999, (210, 210, 205)), # 雪线
]
img = np.zeros((H, W, 3), dtype=np.uint8)
for lo_b, hi_b, col in BANDS:
    m = (hmap >= lo_b) & (hmap < hi_b)
    img[m] = col

# 山体阴影（NW 光源）
gy, gx = np.gradient(hmap)
shade = np.clip(0.55 + 0.45 * (( -gx - gy) / (np.hypot(gx, gy) + 1e-6)), 0.2, 1.0)
shade = shade[:, :, None]
img = (img.astype(np.float32) * shade).astype(np.uint8)

pil = Image.fromarray(img, "RGB")
d = ImageDraw = __import__("PIL.ImageDraw", fromlist=["ImageDraw"]).Draw(pil)

# 经纬网格线（每 10% 一条）+ 标注
for i in range(1, 10):
    x = int(W * i / 10)
    d.line([(x, 0), (x, H)], fill=(200, 210, 220), width=1)
    d.line([(0, int(H * i / 10)), (W, int(H * i / 10))], fill=(200, 210, 220), width=1)
d.text((8, 8), "KALTE 地形底图（等高线分带 + 山体阴影 + 经纬网格）", fill=(255, 255, 255))
for i in range(1, 10):
    x = int(W * i / 10)
    d.text((x - 8, 2), f"{i * 10}E", fill=(255, 255, 255))
    y = int(H * i / 10)
    d.text((2, y - 6), f"{10 - i * 10}N", fill=(255, 255, 255))

pil.save(OUT)
print("已保存", OUT)
