# -*- coding: utf-8 -*-
"""卡尔特地图资源映射：山脉→矿藏，沿海→渔获，低地→农业；输出 resources.json + 资源分布图"""
import json
import random
from collections import deque
from PIL import Image, ImageDraw

JSON = "data/kalte_gridcells.json"
OUT_IMG = "kalte_resources.png"
OUT_JSON = "data/resources.json"
SEED = 1023  # 确定性资源种子

with open(JSON, "r", encoding="utf-8") as f:
    data = json.load(f)
info = data["info"]
W, H = info["width"], info["height"]
cells = data["cells"]["cells"]
verts = data["cells"]["vertices"]
vxy = lambda i: (verts[i].get("p", [0, 0])[0], verts[i].get("p", [0, 0])[1])
cell_by_id = {c["i"]: c for c in cells}
land_ids = [c["i"] for c in cells if c.get("h", 0) >= 20]
sea_ids = {c["i"] for c in cells if c.get("h", 0) < 20}

# 省份聚簇
prov_of = {}
pid = 0
for s in land_ids:
    if s in prov_of:
        continue
    q = deque([s])
    prov_of[s] = pid
    while q:
        cur = q.popleft()
        for nb in cell_by_id[cur].get("c", []):
            if nb in cell_by_id and nb in land_ids and nb not in prov_of:
                prov_of[nb] = pid
                q.append(nb)
    pid += 1

prov_cells = {}
for cid in land_ids:
    prov_cells.setdefault(prov_of[cid], []).append(cid)

def centroid(cids):
    xs, ys = [], []
    for cid in cids:
        pts = [vxy(i) for i in cell_by_id[cid]["v"]]
        xs.append(sum(p[0] for p in pts) / len(pts))
        ys.append(sum(p[1] for p in pts) / len(pts))
    return sum(xs) / len(xs), sum(ys) / len(ys)

rng = random.Random(SEED)

RESOURCES = {
    "coal": ("煤矿", (30, 30, 30)),
    "iron": ("铁矿", (120, 120, 130)),
    "copper": ("铜矿", (200, 120, 40)),
    "tin": ("锡矿", (190, 190, 200)),
    "gold": ("金矿", (230, 200, 60)),
    "salt": ("盐", (240, 240, 245)),
    "sulfur": ("硫磺", (220, 200, 60)),
    "gems": ("宝石", (180, 80, 220)),
    "fish": ("渔场", (90, 160, 230)),
    "farmland": ("沃土", (120, 190, 90)),
    "timber": ("林场", (70, 130, 70)),
    "cotton": ("棉田", (235, 235, 210)),
}

prov_res = {}
for p, cids in prov_cells.items():
    hs = [cell_by_id[cid].get("h", 0) for cid in cids]
    temps = [cell_by_id[cid].get("temp", 0) for cid in cids]
    precs = [cell_by_id[cid].get("prec", 0) for cid in cids]
    avg_h = sum(hs) / len(hs)
    max_h = max(hs)
    avg_t = sum(temps) / len(temps)
    avg_p = sum(precs) / len(precs)
    # 沿海判定：任一格邻接海域
    coastal = any(any(nb in sea_ids for nb in cell_by_id[cid].get("c", [])) for cid in cids)
    res = []
    if max_h >= 30 or avg_h >= 28:
        # 山地：矿藏（确定性加权随机）
        roll = rng.random()
        res.append(rng.choice(["coal", "coal", "iron", "iron", "copper", "tin", "gold", "sulfur", "gems"]))
        if rng.random() < 0.4 and "coal" not in res:
            res.append("coal")
        if avg_h < 45 and rng.random() < 0.4:
            res.append("timber")
    else:
        # 低地：农业
        if avg_t > -5 and avg_p >= 15:
            res.append("cotton" if avg_t > 10 and avg_p > 30 else "farmland")
        elif avg_t > -10:
            res.append("farmland")
        else:
            res.append("timber")
        if avg_p >= 25 and avg_t > -8 and rng.random() < 0.5:
            res.append("timber")
    if coastal:
        res.append("fish")
        if "salt" not in res and rng.random() < 0.3:
            res.append("salt")
    if not res:
        res.append("farmland")
    prov_res[p] = {"cells": len(cids), "elev": round(avg_h, 1), "temp": round(avg_t, 1),
                   "prec": round(avg_p, 1), "coastal": coastal, "resources": res}

# 保存 JSON
with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump({str(k): v for k, v in prov_res.items()}, f, ensure_ascii=False, indent=1)
print(f"已保存 {OUT_JSON}（{len(prov_res)} 省）")

# 渲染资源分布图
img = Image.new("RGB", (W, H), (12, 30, 60))
d = ImageDraw.Draw(img)
for cid in land_ids:
    c = cell_by_id[cid]
    h = c.get("h", 0)
    col = (46, 66, 46) if h < 35 else (80, 78, 70) if h < 50 else (110, 96, 84)
    pts = [vxy(i) for i in c["v"]]
    if len(pts) >= 3:
        d.polygon(pts, fill=col)
        d.line(pts + [pts[0]], fill=(30, 40, 50), width=1)

for p, info2 in prov_res.items():
    cx, cy = centroid(prov_cells[p])
    for i, r in enumerate(info2["resources"][:3]):
        name, col = RESOURCES[r]
        ox = -14 + i * 14
        d.ellipse([cx + ox - 5, cy - 5, cx + ox + 5, cy + 5], fill=col, outline=(255, 255, 255))

# 图例
lx, ly = 12, 14
for i, (k, (name, col)) in enumerate(RESOURCES.items()):
    d.rectangle([lx, ly + i * 20, lx + 14, ly + i * 20 + 12], fill=col, outline=(255, 255, 255))
    d.text((lx + 18, ly + i * 20), name, fill=(230, 235, 240))
d.text((lx, ly + len(RESOURCES) * 20 + 4), "深色陆地=山地(矿藏) 浅绿=低地 海蓝=渔场/盐", fill=(170, 185, 205))

img.save(OUT_IMG)
print(f"已保存 {OUT_IMG}")

# 统计
from collections import Counter
c = Counter()
for info2 in prov_res.values():
    for r in info2["resources"]:
        c[r] += 1
print("资源省份数:", dict(c))
