# -*- coding: utf-8 -*-
"""
提示词模块：所有Prompt模板与结构检测（目录/子目/Few-shot）
"""
import re

from config import (
    FEW_SHOT_EXAMPLES, CATEGORY_OPTIONS, BASIN_OPTIONS,
    STRICT_EXTRACTION, STRUCTURE_MODE,
)
from shared import _ZIMU_RE


def _parse_few_shot_examples():
    """将 config 中的 Few-shot 文本解析为结构化列表（与 app.py 编辑器的解析逻辑一致）"""
    examples = []
    current = {}
    # 匹配 "1. 示例1：" 或 "示例："（排除标题行"以下是一些...示例，..."）
    header_pattern = re.compile(r"^(?:\d+\.\s*)?示例\d*[：:]")
    for line in FEW_SHOT_EXAMPLES.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if header_pattern.match(line):
            if current.get("名称"):
                examples.append(current)
            current = {}
        elif line.startswith("- 名称："):
            current["名称"] = line[len("- 名称："):].strip()
        elif line.startswith("- 类别："):
            current["类别"] = line[len("- 类别："):].strip()
        elif line.startswith("- 原因："):
            current["原因"] = line[len("- 原因："):].strip()
    if current.get("名称"):
        examples.append(current)
    return examples


def _detect_toc(text):
    """检测目录/索引页：文本开头600字内出现"目录"字样（容忍OCR空格）"""
    head = text[:600].replace(" ", "").replace("\u3000", "")
    return "目录" in head


def _parse_zimu_blocks(text):
    """解析【】子目结构：返回 [(标题, 正文), ...]；少于2个返回空"""
    matches = list(_ZIMU_RE.finditer(text))
    if len(matches) < 2:
        return []
    blocks = []
    for i, m in enumerate(matches):
        title = m.group(1).strip().strip("（）() ")  # 清理OCR读【】时混入的括号
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end].strip()
        blocks.append((title, body))
    return blocks


def _detect_zimu(text):
    """检测子目结构：文本中【】子目数量>=3"""
    if STRUCTURE_MODE == "full":
        return False
    if STRUCTURE_MODE == "zimu":
        return True
    return len(_ZIMU_RE.findall(text)) >= 3


def _first_sentences(body, max_chars=120):
    """逐字摘录正文开头1-3个完整句子（确定性，保证100%忠实原文）"""
    from shared import _split_sentences
    sents = _split_sentences(body)
    out = ""
    for s in sents:
        s = s.strip()
        if not s:
            continue
        if out and len(out) + len(s) > max_chars:
            break
        out += s
        if len(out) >= max_chars:
            break
    # 折叠PDF换行（仅去换行符，保留空格与标点）
    return out.replace("\r", "").replace("\n", "").strip()


def _build_zimu_prompt(blocks, book_name, chunk_index, chunk_total):
    """子目模式提示词：模型只为每个子目填写元数据（名称/引文由代码确定）"""
    items = []
    for i, (title, body) in enumerate(blocks, 1):
        preview = re.sub(r"\s+", "", body)[:180]
        items.append(f"{i}. 标题【{title}】 正文：{preview}")
    block_list = "\n".join(items)

    category_enum = "、".join(CATEGORY_OPTIONS)
    basin_enum = "、".join(BASIN_OPTIONS)
    prompt = f"""你是严谨的文史档案整理专家。以下是从《{book_name}》中提取出的 {len(blocks)} 个【】子目（每个附正文开头预览）。

要求：
1. 为每个子目输出一条记录，"名称"必须等于【】中的标题原文，不得修改、不得补全。
2. 一个子目只输出一条，【严禁在子目内部再细分】。
3. 若某子目显然不是文化要素（如"凡例""后记""出版说明"等），跳过不输出。
4. 字段规则：
   - "类别"只能取：{category_enum}
   - "时间"：正文中的朝代/年代/年份，未说明填"不详"
   - "空间"：按"省市区"行政区划格式补全（如"重庆市大足区"），无法判断填"不详"
   - "流域"：只能取：{basin_enum}
   - "基础信息"：用简洁语言归纳该子目正文的信息，不超过80字，必须基于正文

只输出一个JSON对象：{{"entries": [{{"名称": "", "类别": "", "时间": "", "空间": "", "流域": "", "基础信息": ""}}]}}

子目列表（第{chunk_index}组，共{chunk_total}组）：
{block_list}"""
    return prompt


def _build_prompt(sample, book_name, chunk_index, chunk_total, is_ocr=False, is_toc=False):
    """构建提取 Prompt（v3.4：防编造、严格枚举、输出Schema示例、页码诚实、目录感知）

    注意：不要在提示词中提及"OCR/扫描件/乱码"——实验证明任何此类提示
    都会显著抑制模型对噪声文本的提取召回（11条 -> 1条）。
    乱码清理改为提取后的确定性代码处理（postprocess._clean_quote_garbage）。
    """
    ex_lines = []
    for i, ex in enumerate(_parse_few_shot_examples(), 1):
        name = ex.get("名称", "")
        cat = ex.get("类别", "")
        reason = ex.get("原因", "")
        ex_lines.append(f'{i}. "{name}" → 类别：{cat}（{reason}）')
    few_shot_block = "\n".join(ex_lines) if ex_lines else "（无）"

    if STRICT_EXTRACTION:
        principle = "只提取原文中【明确出现】的内容；宁可少而准，也不要编造。"
    else:
        principle = "宁可多提取，也不要遗漏；但每条仍必须有原文依据，不得编造。"

    category_enum = "、".join(CATEGORY_OPTIONS)
    basin_enum = "、".join(BASIN_OPTIONS)

    toc_note = ""
    if is_toc:
        toc_note = """
【目录提示】本片段是书籍目录/索引，不是正文。
- 只提取其中【明确的实体名称】（如具体建筑、组织、节日、习俗、人物、遗址）；
- 不要提取章节标题、通用名词（如"居住""服饰""概况""分布""团体""性别结构"）、
  日期标记（如"正月""初六""十五日"）或页码数字。"""

    prompt = f"""你是一位严谨的文史档案整理专家。请仔细阅读以下地方志/档案文献片段（来源：《{book_name}》），提取其中所有具有研究价值的文化要素。

【提取范围（包括但不限于）】
- 考古遗址、历史建筑、古墓葬、碑刻、器物等物质遗存；
- 古代产业遗存：盐井、盐场、盐道、盐泉、窑址、矿冶遗址、水利工程等；
- 历史人物、重大事件、战争、自然灾害等史实；
- 民俗节庆、仪式活动、技艺、饮食、服饰等；
- 制度、职官、科举、赋税、乡约等；
- 信仰、宗教、思想、传说、民谚、心理观念等；
- 方言及语言文化现象（方言词汇、称谓、谚语、语法特征、行话等）。

【必须严格遵守】
1. 提取原则：{principle}
2. "历史文献"：从原文中【连续摘录】与该要素直接相关的句子（1-3句），必须【逐字照抄】：
   不得改写、不得加入省略号"……"、不得重组语序、不得补全或删减内容；
   原文是OCR且存在明显乱码串时可删除乱码，其余一律照抄；
   若要素所在句子因OCR/版面残缺无法完整逐字摘录，只摘录包含该要素名称的、
   能逐字抄出的最短片段（哪怕只有半句），【宁短勿改】，严禁为凑内容而改写或重组。
3. 具体名称必须单独提取：若文中先总括（如"重庆古桥包括岩溪桥、碑记桥、奈何桥……"），
   除总括条目外，其中的每个具体名称（每座桥、每座塔、每处窑址、每眼盐井、
   每处遗址、每座墓葬等）都必须【单独提取一条】，严禁只输出总括条目。
4. 不要提取统计表/列表中的单列项目（如"汉代盐井""清代池塘""民国木亭"这类
   分类统计行），除非该名称在正文中有独立描述。
5. 页码：仅当原文片段中确实出现页码信息时才可标注，否则省略，严禁猜测页码。
6. 同一要素在文中反复出现时只输出一条，名称统一使用原文中最完整的标准名称。
7. "基础信息"用简洁语言归纳该条目在原文中的信息，不超过80字，必须基于原文。
8. "类别"只能取以下五个值之一：{category_enum}
9. "流域"只能取以下三个值之一：{basin_enum}（无法判断填"不详"）
10. "时间"：使用原文中的朝代/年代/年份；原文未说明则填"不详"。
11. "空间"：禁止照抄原文的地理描述，必须按下面的行政区划格式补全。
12. 若原文中的名称疑似错别字或OCR误字，可在"名称"中按常识改正，但必须在"基础信息"末尾注明"原书作『××』"；若不确定则保持原文不变。{toc_note}

【空间格式规则】
1. 从原文提取地名，补全省、市、区/县三级，格式如"湖北省武汉市武昌区"。
2. 原文只提到区/县名（如"武昌"）→ 补全为"湖北省武汉市武昌区"。
3. 原文只提到市名（如"荆州"）→ 输出"湖北省荆州市"（区/县省略）。
4. 原文只提到省名（如"湖北"）→ 输出"湖北省"（市/区省略）。
5. 更细的乡镇/街道信息追加在区/县后，如"湖北省武汉市武昌区水果湖街道"。
6. 原文的方位描述（如"城郊""东湖西岸"）作为补充信息放在区/县后，如"湖北省武汉市武昌区东湖西岸"。
7. 完全无法判断所属省市 → 填"不详"。
8. 所有输出必须明确写出"省""市""区"等行政单位名称，不得省略。

【分类参考示例】
{few_shot_block}

【历史文献格式示例】
原文片段："……该桥始建于元代，清光绪时修长廊。为六孔石墩木梁桥，桥长58.2米，梁上铺石板，桥廊砖木结构。……"
正确摘录："该桥始建于元代，清光绪时修长廊。为六孔石墩木梁桥，桥长58.2米。"
（逐字连续摘录，不使用省略号，不改写）

【输出格式】
只输出一个 JSON 对象，不要输出任何其他文字或解释，结构如下：
{{"entries": [{{"名称": "", "类别": "", "时间": "", "空间": "", "流域": "", "基础信息": "", "历史文献": ""}}]}}
若该片段没有任何文化要素，输出：{{"entries": []}}

文献片段（第{chunk_index}部分，共{chunk_total}部分）：
{sample}"""
    return prompt


__all__ = [
    "_parse_few_shot_examples", "_detect_toc", "_parse_zimu_blocks",
    "_detect_zimu", "_first_sentences", "_build_zimu_prompt", "_build_prompt",
]
