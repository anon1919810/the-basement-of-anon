# -*- coding: utf-8 -*-
"""
后处理模块：JSON解析、字段规范化、空间补全、合并去重、标注、引文校验
"""
import re
import json
from difflib import SequenceMatcher

from .config import CATEGORY_OPTIONS, BASIN_OPTIONS
from .shared import log_message, REQUIRED_FIELDS, _norm_sentence, _split_sentences
from .province_dict import PROVINCE_DICT


# ---------- 空间字段规范化（省域字典） ----------
def _build_space_index(province_dict):
    """从省域字典建立检索索引：区县名(含去后缀) -> (省, 市)；市名(含去后缀) -> (省, 市)"""
    dist_index, dist_base_index = {}, {}
    city_index, city_base_index = {}, {}
    for prov, cities in province_dict.items():
        for city, districts in cities.items():
            city_index[city] = (prov, city)
            cb = re.sub(r"[市州地区]$", "", city)
            if len(cb) >= 2:
                city_base_index.setdefault(cb, (prov, city))
            for d in districts:
                dist_index[d] = (prov, city)
                db = re.sub(r"[区县市]$", "", d)
                if len(db) >= 2:
                    dist_base_index.setdefault(db, (prov, city))
    return dist_index, dist_base_index, city_index, city_base_index


_DIST_INDEX, _DIST_BASE_INDEX, _CITY_INDEX, _CITY_BASE_INDEX = _build_space_index(PROVINCE_DICT)
_DIRECT_PROVINCES = ("重庆市", "上海市")


def _normalize_space(space):
    """用省域字典规范化"空间"字段：补全省/市两级（保守策略，无法确认则原样返回）

    处理示例:
      "武汉市武昌区"             -> "湖北省武汉市武昌区"
      "湖北省武昌区东湖西岸"      -> "湖北省武汉市武昌区东湖西岸"
      "武昌区"                   -> "湖北省武汉市武昌区"
      "荆州市"                   -> "湖北省荆州市"
      "渝中区"                   -> "重庆市渝中区"
      "仙桃市"                   -> "湖北省仙桃市"
    """
    space = (space or "").strip()
    if not space or space == "不详":
        return space
    # 直辖市完整形式（如"重庆市渝中区"）视为完整
    for prov in _DIRECT_PROVINCES:
        if space.startswith(prov):
            return space

    hit_prov = hit_city = None
    # 1) 区县名优先（先全名后去后缀，均按长度降序防短名误配）
    for idx in (_DIST_INDEX, _DIST_BASE_INDEX):
        for key in sorted(idx, key=len, reverse=True):
            if len(key) >= 2 and key in space:
                hit_prov, hit_city = idx[key]
                break
        if hit_prov:
            break
    # 2) 市名匹配
    if not hit_prov:
        for idx in (_CITY_INDEX, _CITY_BASE_INDEX):
            for key in sorted(idx, key=len, reverse=True):
                if len(key) >= 2 and key in space:
                    hit_prov, hit_city = idx[key]
                    break
            if hit_prov:
                break
    if not hit_prov:
        return space

    result = space
    # 直辖市（省==市）：只需保证市名在前
    if hit_prov in _DIRECT_PROVINCES:
        if hit_prov not in result:
            result = hit_prov + result
        return result
    # 已有省：只补市；若命中省与已有省不符，则不干预（保守）
    if "省" in result:
        if hit_prov not in result:
            return space
        if hit_city and hit_city not in result:
            result = result.replace(hit_prov, hit_prov + hit_city, 1)
        return result
    # 无省：补省 + 市
    if hit_prov not in result:
        result = hit_prov + result
    if hit_city and hit_city != hit_prov and hit_city not in result:
        result = result.replace(hit_prov, hit_prov + hit_city, 1)
    return result


# ---------- JSON 解析与规范化 ----------
# OCR乱码串模式：连续的拉丁字母（可含空格/标点分隔），如 "ALT PRM E"、"BWM BARRE'"
_GARBAGE_RE = re.compile(r"[A-Za-z]{2,}(?:[ \t,.;:'\"()\-]*[A-Za-z]{2,})*")


def _clean_quote_garbage(text):
    """删除历史文献摘抄中的OCR乱码串（仅用于OCR来源的摘抄，确定性处理）"""
    if not text:
        return text
    cleaned = _GARBAGE_RE.sub("", text)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)          # 合并多余空格
    cleaned = re.sub(r",\s*,", ",", cleaned)              # 清理", ,"残留
    return cleaned.strip(" ,；;")


def _parse_json_content(content):
    """从模型输出中解析 JSON（兼容代码围栏、前后多余文字、嵌套结构）。

    策略：遍历所有 '{' 与 '[' 起始位置尝试 raw_decode，
    取"消耗内容最多"的候选（即最外层 JSON），避免误匹配嵌套数组。
    """
    if not content:
        return None
    content = content.strip()
    # 去除 markdown 代码围栏
    content = re.sub(r"^```[a-zA-Z]*\s*", "", content)
    content = re.sub(r"\s*```$", "", content)

    decoder = json.JSONDecoder()
    candidates = []  # (消耗字符数, 解析对象)
    for ch in ("{", "["):
        start = 0
        while True:
            idx = content.find(ch, start)
            if idx == -1:
                break
            try:
                obj, end = decoder.raw_decode(content[idx:])
                candidates.append((end, obj))
            except json.JSONDecodeError:
                pass
            start = idx + 1

    if not candidates:
        return None
    # 取最外层 JSON（消耗内容最多者）
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _normalize_entries(data, is_ocr=False):
    """将模型输出规范化为标准条目列表（补全缺字段、校验类别/流域枚举、清理OCR乱码）"""
    if isinstance(data, dict):
        # 兼容 {"entries": [...]} 等包装对象
        for key in ("entries", "条目", "数据", "results", "items", "result"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            # 整个对象本身可能是一条要素
            data = [data]

    if not isinstance(data, list):
        log_message("  模型输出不是列表，已忽略", "WARNING")
        return []

    entries = []
    invalid_cat = 0
    invalid_basin = 0
    for raw in data:
        if not isinstance(raw, dict):
            continue
        entry = {field: str(raw.get(field, "")).strip() for field in REQUIRED_FIELDS}
        if not entry["名称"]:
            continue  # 无名称的无效条目
        entry["名称"] = re.sub(r"\s+", "", entry["名称"])  # 名称去空白（OCR常见"黄鹤 楼"）
        entry["空间"] = _normalize_space(entry["空间"])     # 省域字典补全省市
        if is_ocr:
            entry["历史文献"] = _clean_quote_garbage(entry["历史文献"])
        if entry["类别"] not in CATEGORY_OPTIONS:
            entry["类别"] = ""  # 置空，交由用户在线编辑修正
            invalid_cat += 1
        if entry["流域"] not in BASIN_OPTIONS:
            entry["流域"] = "不详"
            invalid_basin += 1
        entries.append(entry)

    if invalid_cat:
        log_message(f"  [校验] {invalid_cat} 条类别不在允许范围内，已置空待修正", "WARNING")
    if invalid_basin:
        log_message(f"  [校验] {invalid_basin} 条流域不在允许范围内，已置为'不详'", "WARNING")
    return entries


# ---------- 跨块近似重复合并 ----------
def _names_similar(a, b):
    """名称判定：完全相同，或短名为长名子串（长度比>=0.5）

    不再使用模糊相似度（如"佛教协会/道教协会"相似度0.86但实为不同实体），
    同实体的近似变体由"摘抄句级重叠"（_quotes_overlap）兜底判定。
    保护规则：一方含"碑记"而另一方不含时视为不同实体（建筑 vs 碑刻）。
    """
    if a == b:
        return True
    if ("碑记" in a) != ("碑记" in b):
        return False
    longer, shorter = (a, b) if len(a) >= len(b) else (b, a)
    if len(shorter) < 2:
        return False
    return shorter in longer and len(shorter) / len(longer) >= 0.5


def _quotes_overlap(qa, qb, min_sentences=2):
    """摘抄句级重叠：两条历史文献共享>=2个句子（归一化后）视为同一实体

    覆盖跨块重复的核心场景（重叠区内容必然出现在相邻块的摘抄中），
    如"汉阳旧城"与"汉阳城"的摘抄共享护城石堤等段落。
    """
    if not qa or not qb:
        return False
    sa = {_norm_sentence(s) for s in _split_sentences(qa) if len(s) >= 4}
    sb = [_norm_sentence(s) for s in _split_sentences(qb) if len(s) >= 4]
    if len(sb) < min_sentences:
        return False
    return sum(1 for s in sb if s in sa) >= min_sentences


def _spaces_compatible(a, b):
    """空间兼容：完全相同 / 互相包含 / 有一方为空或不详"""
    if a == b:
        return True
    if not a or not b or a == "不详" or b == "不详":
        return True
    return a in b or b in a


def _join_quotes(a, b):
    """拼接两条历史文献摘抄：若一条已包含另一条则保留较长者；
    否则按"句"去重（归一化后比较），只追加 b 中新增的句子"""
    if not b:
        return a
    if not a:
        return b
    if a in b or b in a:
        return a if len(a) >= len(b) else b
    seen = {_norm_sentence(s) for s in _split_sentences(a)}
    extra = "".join(s for s in _split_sentences(b) if _norm_sentence(s) not in seen)
    return a + extra


def _merge_similar_entries(entries):
    """合并跨块产生的近似重复条目（类别相同、名称近似、空间兼容，如"汉阳旧城/汉阳城"）"""
    merged = []
    for entry in entries:
        target = None
        for m in merged:
            if (entry["类别"] == m["类别"]
                    and _spaces_compatible(entry["空间"], m["空间"])
                    and (_names_similar(entry["名称"], m["名称"])
                         or _quotes_overlap(entry["历史文献"], m["历史文献"]))):
                target = m
                break
        if target is None:
            merged.append(dict(entry))
            continue
        # 名称与摘抄：优先保留"历史文献"更完整的那条
        if len(entry["历史文献"]) > len(target["历史文献"]):
            target["名称"] = entry["名称"]
        target["历史文献"] = _join_quotes(target["历史文献"], entry["历史文献"])
        for f in ("时间", "基础信息"):
            if not target[f] and entry[f]:
                target[f] = entry[f]
        # 两条基础信息都非空且内容不同（如跨文件的不同侧面描述）-> 拼接
        if (entry.get("基础信息") and target.get("基础信息")
                and entry["基础信息"] != target["基础信息"]
                and len(target["基础信息"]) + len(entry["基础信息"]) <= 160):
            target["基础信息"] = target["基础信息"] + "；" + entry["基础信息"]
    return merged


def _annotate_name_corrections(entries, source_text):
    """名称与原文用字不一致时（模型按常识改正了错字/OCR误字），
    在"基础信息"末尾注明"原书作『××』"，保证学术可追溯。

    确定性实现：当名称不在原文中、但原文存在同长度高相似串（>=0.8）时，
    视为"改正了原文用字"，追加标注。仅相差约1个字的修正才会触发。
    """
    for entry in entries:
        name = entry.get("名称", "")
        if not name or name in source_text:
            continue
        info = entry.get("基础信息", "")
        if "原书作" in info:  # 模型已自行标注则跳过
            continue
        best, best_score = None, 0.0
        first = name[0]
        idx = 0
        while True:
            idx = source_text.find(first, idx)
            if idx == -1:
                break
            cand = source_text[idx:idx + len(name)]
            if len(cand) == len(name) and cand != name:
                score = SequenceMatcher(None, name, cand).ratio()
                if score > best_score:
                    best, best_score = cand, score
                if best_score >= 0.85:
                    break
            idx += 1
        if best and best_score >= 0.8:
            if _norm_sentence(name) == _norm_sentence(best):
                continue  # 仅标点/空白变体差异（如· vs ・），不标注
            note = f"原书作『{best}』"
            if note not in info:
                entry["基础信息"] = (info + "；" + note) if info else note


def _verify_quotes(entries, source_text):
    """引文忠实度校验：逐字命中原文（允许OCR乱码删除的子序列）即通过；
    否则在"基础信息"末尾追加"⚠引文待核对"标记，返回标记条数。

    注意：子目模式的引文为确定性摘录，必然通过；此标记主要捕捉
    "全文模式"下模型对OCR乱码段落的改写/拼接。
    """
    S = re.sub(r"\s+", "", source_text or "")
    if not S:
        return 0
    flagged = 0
    for entry in entries:
        q = re.sub(r"\s+", "", entry.get("历史文献", ""))
        if len(q) < 10:
            continue  # 过短碎片不判定（子目模式的短句也不误报）
        if q in S:
            continue
        # 子序列检查：允许引文删除了原文中的乱码串
        it = iter(S)
        if all(c in it for c in q):
            continue
        info = entry.get("基础信息", "")
        marker = "⚠引文待核对"
        if marker not in info:
            entry["基础信息"] = (info + "；" + marker) if info else marker
        flagged += 1
    return flagged


__all__ = [
    "_normalize_space", "_clean_quote_garbage", "_parse_json_content",
    "_normalize_entries", "_names_similar", "_quotes_overlap", "_spaces_compatible",
    "_join_quotes", "_merge_similar_entries", "_annotate_name_corrections", "_verify_quotes",
]
