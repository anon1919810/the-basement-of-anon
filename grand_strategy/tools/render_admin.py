# -*- coding: utf-8 -*-
"""卡尔特行政区地图 v2：省份→大陆块→国家，13国配色 + 西侧未探明新大陆"""
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
vxy = (lambda i: (verts[i].get("p", [0, 0])[0], verts[i].get("p", [0, 0])[1]))
cell_by_id = {c["i"]: c for c in cells}
land_ids = [c["i"] for c in cells if c.get("h", 0) >= 20]  # 陆地判定：海拔 h>=20

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

# 省份质心 + 单元格列表
prov_cells = {}
for cid in land_ids:
    prov_cells.setdefault(prov_of[cid], []).append(cid)

def centroid(cids):
    xs, ys = [], []
    for cid in cids:
        c = cell_by_id[cid]
        pts = [vxy(i) for i in c["v"]]
        xs.append(sum(p[0] for p in pts) / len(pts))
        ys.append(sum(p[1] for p in pts) / len(pts))
    return sum(xs) / len(xs), sum(ys) / len(ys)

prov_cent = {p: centroid(cids) for p, cids in prov_cells.items()}
prov_size = {p: len(cids) for p, cids in prov_cells.items()}

# 大陆块 = 省份邻接组件
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

# ---- 国家分配（启发式）----
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
lm_sorted = sorted(lm_size.items(), key=lambda x: -x[1])
assign = {}
used = set()
if lm_sorted:
    assign[lm_sorted[0][0]] = 0
    used.add(lm_sorted[0][0])
for l, s in lm_sorted[1:]:
    cx, cy = lm_cent[l]
    if cy < H * 0.32:
        n = 1
    elif cx < W * 0.42 and cy < H * 0.7:
        n = 2
    elif cx > W * 0.6 and cy < H * 0.72:
        n = 3
    elif cy > H * 0.72:
        n = 8
    elif cx < W * 0.5:
        n = 5
    elif s < 30:
        n = 9
    else:
        n = 6
    assign[l] = n

prov_nation = {}
for p, l in lm_of.items():
    prov_nation[p] = assign.get(l, 5)

# 渲染（西侧扩展画新大陆）
MARGIN = 620
cw = W + MARGIN
img = Image.new("RGB", (cw, H), (10, 22, 46))
d = ImageDraw.Draw(img)

def shift(pts):
    return [(x + MARGIN, y) for x, y in pts]

for p, cids in prov_cells.items():
    col = NATIONS[prov_nation[p]][1]
    for cid in cids:
        c = cell_by_id[cid]
        pts = shift([vxy(i) for i in c["v"]])
        if len(pts) < 3:
            continue
        d.polygon(pts, fill=col)
        d.line(pts + [pts[0]], fill=(255, 255, 255), width=1)

# 国界加粗
for p, cids in prov_cells.items():
    for cid in cids:
        c = cell_by_id[cid]
        for nb in c.get("c", []):
            if nb in prov_of and prov_nation[prov_of[nb]] != prov_nation[p]:
                pts = shift([vxy(i) for i in c["v"]])
                d.line(pts + [pts[0]], fill=(20, 20, 20), width=3)

# 未探明新大陆（西侧，迷雾样式）
fog = [(30, 420), (240, 380), (420, 470), (500, 640), (390, 830), (170, 860), (20, 720)]
d.polygon(fog, fill=(40, 52, 68))
d.line(fog + [fog[0]], fill=(160, 180, 200), width=2)
for i in range(len(fog)):
    a, b = fog[i], fog[(i + 1) % len(fog)]
    n = 12
    for k in range(1, n, 2):
        t = k / n
        d.ellipse([a[0] + (b[0]-a[0])*t - 3, a[1] + (b[1]-a[1])*t - 3,
                   a[0] + (b[0]-a[0])*t + 3, a[1] + (b[1]-a[1])*t + 3], fill=(120, 140, 160))
d.text((60, 620), "新大陆", fill=(220, 230, 240))
d.text((40, 645), "（未探明）", fill=(180, 195, 210))
d.line([(MARGIN + 100, H - 120), (MARGIN - 80, H - 300), (40, H - 380)], fill=(255, 230, 150), width=2)
d.text((MARGIN + 110, H - 150), "南方航线（信风带）", fill=(255, 230, 150))

# 图例
lx, ly = 12, 14
for i, (name, col) in enumerate(NATIONS):
    d.rectangle([lx, ly + i * 20, lx + 14, ly + i * 20 + 12], fill=col)
    d.text((lx + 18, ly + i * 20), name, fill=(230, 235, 240))
d.text((lx, ly + len(NATIONS) * 20 + 4), "新大陆（未探明）· 不属任何国家", fill=(170, 185, 205))

img.save(OUT)
print("已保存", OUT)

# ---- 省份图（每省一色，不含新大陆边距）----
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
    col = pcol(p)
    for cid in cids:
        c = cell_by_id[cid]
        pts = [vxy(i) for i in c["v"]]
        if len(pts) < 3:
            continue
        pd.polygon(pts, fill=col)
        pd.line(pts + [pts[0]], fill=(255, 255, 255), width=1)
pimg.save("kalte_provinces.png")
print("已保存 kalte_provinces.png（省份图）")
