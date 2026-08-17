# -*- coding: utf-8 -*-
"""卡尔特行政区地图 v3：国家集中在中央+左侧大陆与群岛，右侧大陆迷雾化为未探明新大陆"""
import json
from collections import deque
from PIL import Image, ImageDraw

JSON = "data/kalte_gridcells.json"
OUT = "kalte_admin.png"

with open(JSON, "r", encoding="utf-8") as f:
    data = json.load(f)
info = data["info"]
W, H = info["width"], info["height"]
cells = data["cells"]["cells"]
verts = data["cells"]["vertices"]
vxy = lambda i: (verts[i].get("p", [0, 0])[0], verts[i].get("p", [0, 0])[1])
cell_by_id = {c["i"]: c for c in cells}
land_ids = [c["i"] for c in cells if c.get("h", 0) >= 20]

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

prov_size = {p: len(cids) for p, cids in prov_cells.items()}

# 大陆块
prov_nbs = {}
for p, cids in prov_cells.items():
    nbs = set()
    for cid in cids:
        for nb in cell_by_id[cid].get("c", []):
            if nb in prov_of and prov_of[nb] != p:
                nbs.add(prov_of[nb])
    prov_nbs[p] = nbs

lm_of = {}
lm_id = 0
for p in prov_cells:
    if p in lm_of:
        continue
    q = deque([p])
    lm_of[p] = lm_id
    while q:
        cur = q.popleft()
        for nb in prov_nbs.get(cur, []):
            if nb not in lm_of:
                lm_of[nb] = lm_id
                q.append(nb)
    lm_id += 1

lm_provs = {}
for p, l in lm_of.items():
    lm_provs.setdefault(l, []).append(p)
lm_cent = {l: centroid([c for p in ps for c in prov_cells[p]]) for l, ps in lm_provs.items()}
lm_size = {l: sum(prov_size[p] for p in ps) for l, ps in lm_provs.items()}

print("大陆块数量:", lm_id)
for l, s in sorted(lm_size.items(), key=lambda x: -x[1]):
    cx, cy = lm_cent[l]
    print(f"  块{l}: {s}格 质心({cx:.0f},{cy:.0f}) 省份{len(lm_provs[l])}")

# ---- 国家分配：只在中央+左侧(x<0.6W)落国；右侧(x>=0.6W)为未探明新大陆 ----
NATIONS = [
    ("申斯戈维克帝国", (150, 40, 45)),
    ("北境诸部联盟", (120, 140, 170)),
    ("洛林共和国", (70, 110, 200)),
    ("伊尼亚斯王国", (200, 170, 60)),
    ("奥兰治亲王国", (230, 140, 40)),
    ("扎拉克诸邦", (90, 160, 90)),
    ("灰漠酋邦", (180, 150, 90)),
    ("南岭王国", (60, 150, 150)),
    ("诺曼尼亚帝国", (120, 30, 60)),
    ("盎格伦撒城邦", (140, 90, 180)),
    ("盐海城邦同盟", (100, 190, 210)),
    ("凯森自由港", (210, 210, 220)),
    ("海峡三城邦", (230, 120, 160)),
]
FOG = -1  # 未探明新大陆标记

lm_sorted = sorted(lm_size.items(), key=lambda x: -x[1])
assign = {}
for l, s in lm_sorted:
    cx, cy = lm_cent[l]
    if cx >= W * 0.6:
        assign[l] = FOG
        continue
    if l == lm_sorted[0][0] or s >= 120:
        assign[l] = 0  # 最大/最大之一 → 帝国
    elif cy < H * 0.32:
        assign[l] = 1
    elif cx < W * 0.42 and cy < H * 0.7:
        assign[l] = 2
    elif cx > W * 0.45 and cy < H * 0.72:
        assign[l] = 3
    elif cy > H * 0.72:
        assign[l] = 8
    elif cx < W * 0.5:
        assign[l] = 5
    elif s < 30:
        assign[l] = 9
    else:
        assign[l] = 6

prov_nation = {}
for p, l in lm_of.items():
    prov_nation[p] = assign.get(l, 5)

fog_provs = {p for p, l in lm_of.items() if assign.get(l) == FOG}
print(f"未探明新大陆省份数: {len(fog_provs)}，国家省份数: {len(prov_cells) - len(fog_provs)}")

# ---- 渲染 ----
img = Image.new("RGB", (W, H), (10, 22, 46))
d = ImageDraw.Draw(img)

for p, cids in prov_cells.items():
    if prov_nation[p] == FOG:
        col = (34, 44, 60)
    else:
        col = NATIONS[prov_nation[p]][1]
    for cid in cids:
        c = cell_by_id[cid]
        pts = [vxy(i) for i in c["v"]]
        if len(pts) < 3:
            continue
        d.polygon(pts, fill=col)
        d.line(pts + [pts[0]], fill=(255, 255, 255), width=1)

# 迷雾大陆：虚线描边 + 标签
for p in fog_provs:
    for cid in prov_cells[p]:
        c = cell_by_id[cid]
        pts = [vxy(i) for i in c["v"]]
        if len(pts) < 3:
            continue
        d.line(pts + [pts[0]], fill=(120, 140, 160), width=2)

# 国界加粗
for p, cids in prov_cells.items():
    if prov_nation[p] == FOG:
        continue
    for cid in cids:
        c = cell_by_id[cid]
        for nb in c.get("c", []):
            if nb in prov_of and prov_nation.get(prov_of[nb], 5) != prov_nation[p]:
                pts = [vxy(i) for i in c["v"]]
                d.line(pts + [pts[0]], fill=(20, 20, 20), width=3)

# 南方航线（向左/右？新大陆在右侧 → 航线自左下向东）
d.line([(int(W*0.25), H-90), (int(W*0.55), H-160), (int(W*0.78), H-220)], fill=(255, 230, 150), width=2)
d.text((int(W*0.25), H-120), "南方航线（信风带）", fill=(255, 230, 150))
d.text((int(W*0.72), 40), "新大陆（未探明）", fill=(170, 185, 205))
d.text((int(W*0.72), 58), "无人之地 · 等待发现", fill=(150, 165, 185))

# 图例
lx, ly = 12, 14
for i, (name, col) in enumerate(NATIONS):
    d.rectangle([lx, ly + i * 20, lx + 14, ly + i * 20 + 12], fill=col)
    d.text((lx + 18, ly + i * 20), name, fill=(230, 235, 240))
d.text((lx, ly + len(NATIONS) * 20 + 4), "右侧灰色大陆 = 未探明新大陆（无人国家）", fill=(170, 185, 205))

img.save(OUT)
print("已保存", OUT)

# ---- 省份图 ----
import colorsys
pimg = Image.new("RGB", (W, H), (10, 22, 46))
pd = ImageDraw.Draw(pimg)
pal = {}
def pcol(p):
    if p not in pal:
        hue = (p * 0.61803398875) % 1.0
        r, g, b = colorsys.hsv_to_rgb(hue, 0.55, 0.82)
        pal[p] = (int(r * 255), int(g * 255), int(b * 255))
    return pal[p]
for p, cids in prov_cells.items():
    col = (34, 44, 60) if prov_nation[p] == FOG else pcol(p)
    for cid in cids:
        c = cell_by_id[cid]
        pts = [vxy(i) for i in c["v"]]
        if len(pts) < 3:
            continue
        pd.polygon(pts, fill=col)
        pd.line(pts + [pts[0]], fill=(255, 255, 255), width=1)
pimg.save("kalte_provinces.png")
print("已保存 kalte_provinces.png（省份图）")
