# -*- coding: utf-8 -*-
"""
OCR 常见错字纠正模块（轻量规则 + 字典，无需训练模型）

原理：志书扫描件的OCR错字高度集中在"形近字替换"（潮/湖、漂/潭、雁/鹰……）。
纠正策略（双层安全网）：
1. 全局安全替换：几乎不可能合法出现的错字（如"圉"→"图"）
2. 专名模糊修正：把文本与"省域字典 + 已知专名清单"比对，
   仅当某处文字与已知专名【只差1个字、且该错字是已知混淆对】时才替换。
   绝不做无依据的替换，避免误伤正确文字（如"浪潮""本届"不受影响）。
"""
import re
import os
import glob

from province_dict import PROVINCE_DICT

# 高置信度形近字混淆对：错字 -> 正字（仅用于专名比对，不全局替换）
CHAR_CONFUSIONS = {
    "潮": "湖", "胡": "湖", "沏": "湖",
    "漂": "潭", "帕": "帽", "雁": "鹰", "迪": "遗", "让": "遗",
    "此": "匙", "据": "掘", "评": "凿", "竹": "斧",
    "届": "屈", "密": "窑", "窗": "窑", "窖": "窑",
    "监": "盐", "十": "古", "舟": "稻",
}

# 全局安全替换：这些错字几乎不会合法出现在志书正文中
GLOBAL_SAFE = {
    "圉": "图",   # "圉1,见第38页" -> "图1,见第38页"
}

# 已知专名清单（仅收录人工校验过的正确写法！不要从人工摘录Excel自动导入——
# 那些Excel本身含OCR错字，导入会把错字当正确字，反而阻止纠正）
KNOWN_ENTITIES = [
    # 武汉·遗址
    "放鹰台遗址", "老人桥遗址", "马投潭遗址", "许家墩遗址", "棋子墩·后山遗址",
    "余家嘴遗址", "钥匙墩遗址", "盘龙城遗址", "纱帽山遗址", "郢州城遗迹",
    "武昌旧城", "汉阳旧城", "夏口城", "武昌城", "汉阳城", "鲁山城", "鄂州城",
    "起义门", "通湘门", "天完国", "天完国宫殿",
    # 武汉·建筑
    "黄鹤楼", "晴川阁", "古琴台", "岳飞亭", "禹稷行宫", "石榴花塔", "归元寺",
    "古德寺", "卓刀泉", "柏泉古井", "长虹桥", "白杨桥", "保寿桥", "武泰闸",
    "汉江楼", "护城石堤", "凤栖山", "胜像宝塔", "妙缘寺桥", "正德桥",
    # 考古文化
    "屈家岭文化", "石家河文化", "石器时代", "古文化遗址", "古城", "青龙泉遗址",
    "哨棚嘴文化", "铜梁文化", "老关庙文化", "巴文化", "大溪文化",
    # 重庆·盐业/窑/悬棺/桥/塔/题刻
    "白鹤梁题刻", "涂山窑", "涂山窑址", "清溪窑址群", "窑址群", "金凤窑", "炉堆子窑址",
    "风洞子古道", "巫溪宁厂盐场", "云安盐场", "云安盐场遗址", "郁山盐场",
    "白兔井", "浣泉井", "云阳盐井", "大足北山摩崖造像", "涪陵小田溪墓群",
    "云阳李家坝巴人墓地", "开县余家坝巴人墓地", "大宁河栈道", "江门峡纤道",
    "转底器", "尖底杯", "卤水槽", "五眼连膛灶", "青铜柳叶剑", "花边口圈底陶釜",
    "重庆古塔", "重庆古桥", "文峰塔", "字库塔", "三宝塔", "多宝塔",
    "岩溪桥", "碑记桥", "奈何桥", "桂兰桥", "双滩子桥", "客寨桥", "双河桥", "跳墩桥",
]

# 专名后缀剥离（生成基础形，如"马投潭遗址"->"马投潭"）
_SUFFIX_RE = re.compile(
    r"(遗址|遗存|墓群|墓地|崖墓|悬棺|盐场|盐井|盐泉|古道|纤道|题刻|摩崖造像|"
    r"文化|城|桥|塔|井|窑|场|墓|山|观|寺|庙|阁|楼|亭|堰|闸|堤|街|巷|门|"
    r"区|县|市|省)$"
)


def _load_example_names():
    """从示例/人工摘录Excel补充已知专名（若存在）"""
    try:
        import pandas as pd
        names = []
        base = os.path.dirname(os.path.abspath(__file__))
        for xl in glob.glob(os.path.join(base, "示例", "*.xlsx")):
            try:
                df = pd.read_excel(xl)
                col = df.columns[0]
                names.extend(str(v).strip() for v in df[col] if str(v).strip())
            except Exception:
                continue
        return names
    except Exception:
        return []


def _build_name_index():
    """建立专名索引：全名集合 + (首字,长度)/(尾字,长度) 双索引（仅用人工校验过的干净专名）"""
    names = set(KNOWN_ENTITIES)
    for prov, cities in PROVINCE_DICT.items():
        names.add(prov)
        for city, dists in cities.items():
            names.add(city)
            names.update(dists)
    # 生成基础形（如"马投潭遗址"->"马投潭"）
    base_forms = set()
    for n in list(names):
        n = n.strip()
        if len(n) < 2:
            continue
        base = _SUFFIX_RE.sub("", n)
        if len(base) >= 2:
            base_forms.add(base)
    names |= base_forms

    name_set = set()
    index_first = {}
    index_last = {}
    for n in names:
        n = n.strip()
        if len(n) < 2:
            continue
        name_set.add(n)
        index_first.setdefault((n[0], len(n)), set()).add(n)
        index_last.setdefault((n[-1], len(n)), set()).add(n)
    return name_set, index_first, index_last


_NAME_SET, _INDEX_FIRST, _INDEX_LAST = _build_name_index()


def _can_replace(window, name):
    """窗口与专名只差<=1个字，且错字是已知混淆对"""
    if len(window) != len(name) or window == name:
        return False
    diff = 0
    for a, b in zip(window, name):
        if a != b:
            diff += 1
            if diff > 1 or CHAR_CONFUSIONS.get(a) != b:
                return False
    return True


def correct_ocr_text(text):
    """纠正OCR文本中的常见错字；返回纠正后的文本"""
    if not text:
        return text

    # 1) 全局安全替换
    for wrong, right in GLOBAL_SAFE.items():
        text = text.replace(wrong, right)

    # 2) 专名模糊修正（双索引覆盖首字错/尾字错两种情形）
    chars = list(text)
    n = len(chars)
    for i in range(n):
        for L in range(2, 9):
            if i + L > n:
                break
            window = "".join(chars[i:i + L])
            if window in _NAME_SET:
                continue
            cands = _INDEX_FIRST.get((chars[i], L), set()) | _INDEX_LAST.get((chars[i + L - 1], L), set())
            if not cands:
                continue
            for name in cands:
                if _can_replace(window, name):
                    chars[i:i + L] = list(name)
                    break
    return "".join(chars)
