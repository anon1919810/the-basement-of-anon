# -*- coding: utf-8 -*-
"""
文献文化要素提取工具 - 核心处理模块
v2.5.0 重构：
  - Prompt 全面优化（防编造、输出Schema示例、严格枚举、页码诚实原则）
  - JSON 输出规范化（兼容代码围栏/包装对象/多余文字）
  - API 自动重试（网络错误/429/5xx，指数退避）
  - 结果字段校验（类别/流域枚举校验、缺字段补全）
  - 缓存键升级（全文哈希 + 配置签名，修改模板/Few-shot 自动失效旧缓存）
  - 超长段落硬切、正文阅读顺序优化、真实进度回调
"""

import os
import re
import json
import glob
import time
import hashlib
import pickle
from difflib import SequenceMatcher
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd
import pymupdf as fitz  # PyMuPDF 新命名空间（fitz 旧命名已弃用）
from dotenv import load_dotenv

from config import (
    MODEL_NAME, TEMPERATURE, MAX_TEXT_LENGTH, API_TIMEOUT,
    DEFAULT_BOOK_NAME, OUTPUT_BASE_NAME, VERSION, APP_NAME,
    FEW_SHOT_EXAMPLES, ENABLE_CACHE, CACHE_EXPIRE_DAYS, CACHE_DIR,
    MAX_PARALLEL_WORKERS, ENABLE_OCR, TESSERACT_PATH, OCR_DPI,
    ENABLE_SPLIT, CHUNK_OVERLAP,
    API_URL, MAX_API_RETRIES, RETRY_BACKOFF_SECONDS, MAX_OUTPUT_TOKENS,
    CATEGORY_OPTIONS, BASIN_OPTIONS, PROMPT_TEMPLATE_VERSION,
    STRICT_EXTRACTION, MERGE_SIMILAR_ENTRIES,
)
from province_dict import PROVINCE_DICT

load_dotenv()
API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not API_KEY:
    print("[错误] 请在 .env 文件中设置 DEEPSEEK_API_KEY")

REQUIRED_FIELDS = ["名称", "类别", "时间", "空间", "流域", "基础信息", "历史文献"]

# 复用 HTTP 连接（避免每次请求重建握手）
_http = requests.Session()
_headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

# ---------- OCR 模块 ----------
def _clean_ocr_text(text):
    """过滤OCR噪音行：丢弃纯乱码/边注行（非中文占比过高的行），保留正文"""
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        cjk = sum(1 for ch in s if '\u4e00' <= ch <= '\u9fff')
        # 至少2个汉字，或含1个汉字且中文占比>=30%才保留
        if cjk >= 2 or (cjk >= 1 and cjk / len(s) >= 0.3):
            lines.append(s)
    return "\n".join(lines)

def ocr_pdf(pdf_path):
    """使用Tesseract OCR识别扫描版PDF（灰度化 + 分批转换防内存溢出 + 噪音过滤 + 进度输出）"""
    try:
        from pdf2image import convert_from_path
        import pytesseract

        if TESSERACT_PATH and os.path.exists(TESSERACT_PATH):
            pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH

        with fitz.open(pdf_path) as doc:
            n_pages = doc.page_count

        full_text = ""
        batch = 10  # 每批最多10页，防止大PDF一次性载入过多图片
        for start in range(1, n_pages + 1, batch):
            end = min(start + batch - 1, n_pages)
            images = convert_from_path(pdf_path, dpi=OCR_DPI,
                                       first_page=start, last_page=end)
            for img in images:
                gray = img.convert("L")  # 灰度化提升识别率
                text = pytesseract.image_to_string(gray, lang='chi_sim+eng')
                full_text += text + "\n"
            print(f"  [OCR] 进度 {end}/{n_pages} 页", flush=True)
        return _clean_ocr_text(full_text)
    except ImportError:
        print("[警告] 未安装pdf2image或pytesseract，OCR功能不可用")
        return ""
    except Exception as e:
        print(f"[警告] OCR识别失败：{e}")
        return ""

# ---------- 文本提取（带OCR后备） ----------
def extract_text_from_pdf(pdf_path):
    """从PDF提取文本（对外接口，返回文本字符串）"""
    text, _ = _extract_text_with_flag(pdf_path)
    return text

def _extract_text_with_flag(pdf_path):
    """提取文本，返回 (text, used_ocr)"""
    used_ocr = False
    try:
        doc = fitz.open(pdf_path)
        full_text = ""
        for page in doc:
            # sort=True 按阅读顺序排序，改善多栏/表格版面
            page_text = page.get_text("text", sort=True)
            full_text += page_text + "\n\n"
        doc.close()

        # 文本量极少但PDF有内容，启用OCR
        if len(full_text.strip()) < 100 and ENABLE_OCR:
            print(f"  [提示] {os.path.basename(pdf_path)} 疑似扫描件，启动OCR...")
            full_text = ocr_pdf(pdf_path)
            used_ocr = True

        return full_text, used_ocr
    except Exception as e:
        print(f"  [警告] 读取PDF失败：{e}")
        return "", False

# ---------- 智能拆分 ----------
def split_text_into_chunks(text, max_length=MAX_TEXT_LENGTH, overlap=CHUNK_OVERLAP):
    """将长文本按段落智能拆分为多个块（含超长段落硬切 + 上下文重叠）"""
    if len(text) <= max_length:
        return [text]

    paragraphs = [p for p in text.split('\n\n') if p.strip()]
    chunks = []
    current = ""

    for para in paragraphs:
        # 1) 单段超过上限：直接硬切（避免整段丢弃或超长调用）
        while len(para) > max_length:
            if current:
                chunks.append(current.strip())
                current = ""
            chunks.append(para[:max_length])
            para = para[max_length:]

        # 2) 正常段落：能放就放，放不下则落块并带上重叠尾巴
        if not current:
            current = para
        elif len(current) + len(para) + 2 <= max_length:
            current += "\n\n" + para
        else:
            chunks.append(current.strip())
            if overlap > 0:
                overlap_text = current[-overlap:] if len(current) > overlap else current
                current = overlap_text + "\n\n" + para
            else:
                current = para

    if current.strip():
        chunks.append(current.strip())

    return chunks

# ---------- 缓存工具 ----------
def _prompt_signature(is_ocr=False, is_toc=False):
    """计算提示词/配置签名：修改模板、Few-shot、模型参数后自动使旧缓存失效"""
    seed = "|".join([
        str(PROMPT_TEMPLATE_VERSION),
        str(MODEL_NAME), str(TEMPERATURE),
        str(MAX_TEXT_LENGTH), str(CHUNK_OVERLAP),
        str(STRICT_EXTRACTION),
        str(FEW_SHOT_EXAMPLES),
        str(is_ocr), str(is_toc),
    ])
    return hashlib.md5(seed.encode("utf-8")).hexdigest()[:12]

def get_cache_key(text, book_name, is_ocr=False, is_toc=False):
    """生成缓存键（全文哈希 + 文献名 + 配置签名 + OCR/目录标志）"""
    text_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
    raw = f"{text_hash}|{book_name}|{_prompt_signature(is_ocr, is_toc)}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()

def load_from_cache(cache_key):
    """从缓存加载结果"""
    if not ENABLE_CACHE:
        return None
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.pkl")
    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        if time.time() - mtime < CACHE_EXPIRE_DAYS * 86400:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)
    return None

def save_to_cache(cache_key, data):
    """保存结果到缓存"""
    if not ENABLE_CACHE:
        return
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.pkl")
    with open(cache_file, 'wb') as f:
        pickle.dump(data, f)

# ---------- 日志工具 ----------
def log_message(msg, level="INFO"):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open("运行日志.log", "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{level}] {msg}\n")
    print(f"[{level}] {msg}", flush=True)

# ---------- Prompt 构建 ----------
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

def _build_prompt(sample, book_name, chunk_index, chunk_total, is_ocr=False, is_toc=False):
    """构建提取 Prompt（v3.4：防编造、严格枚举、输出Schema示例、页码诚实、目录感知）

    注意：不要在提示词中提及"OCR/扫描件/乱码"——实验证明任何此类提示
    都会显著抑制模型对噪声文本的提取召回（11条 -> 1条）。
    乱码清理改为提取后的确定性代码处理（_clean_quote_garbage）。
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
- 历史人物、重大事件、战争、自然灾害等史实；
- 民俗节庆、仪式活动、技艺、饮食、服饰等；
- 制度、职官、科举、赋税、乡约等；
- 信仰、宗教、思想、传说、民谚、心理观念等；
- 方言及语言文化现象（方言词汇、称谓、谚语、语法特征、行话等）。

【必须严格遵守】
1. {principle}
2. "历史文献"字段必须【完整摘抄原文原句】，不得改写、拼接或编造；不要添加原文没有的内容。
3. 页码：仅当原文片段中确实出现页码信息时才可标注，否则省略，严禁猜测页码。
4. 同一要素在文中反复出现时只输出一条，名称统一使用原文中最完整的标准名称。
5. "基础信息"用简洁语言归纳该条目在原文中的信息，不超过80字，必须基于原文。
6. "类别"只能取以下五个值之一：{category_enum}
7. "流域"只能取以下三个值之一：{basin_enum}（无法判断填"不详"）
8. "时间"：使用原文中的朝代/年代/年份；原文未说明则填"不详"。
9. "空间"：禁止照抄原文的地理描述，必须按下面的行政区划格式补全。
10. 若原文中的名称疑似错别字或OCR误字，可在"名称"中按常识改正，但必须在"基础信息"末尾注明"原书作『××』"；若不确定则保持原文不变。{toc_note}

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

【输出格式】
只输出一个 JSON 对象，不要输出任何其他文字或解释，结构如下：
{{"entries": [{{"名称": "", "类别": "", "时间": "", "空间": "", "流域": "", "基础信息": "", "历史文献": ""}}]}}
若该片段没有任何文化要素，输出：{{"entries": []}}

文献片段（第{chunk_index}部分，共{chunk_total}部分）：
{sample}"""
    return prompt

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

# ---------- API 调用（带重试） ----------
def _sleep_backoff(attempt):
    time.sleep(RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))

def _call_deepseek(prompt):
    """调用 DeepSeek API，返回解析后的 JSON（失败自动重试）"""
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "response_format": {"type": "json_object"},
    }

    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            resp = _http.post(API_URL, headers=_headers, json=payload, timeout=API_TIMEOUT)
        except requests.RequestException as e:
            log_message(f"  [重试 {attempt}/{MAX_API_RETRIES}] 网络异常：{e}", "WARNING")
            if attempt < MAX_API_RETRIES:
                _sleep_backoff(attempt)
            continue

        if resp.status_code == 200:
            try:
                content = resp.json()["choices"][0]["message"]["content"]
            except (KeyError, IndexError, ValueError) as e:
                log_message(f"  响应结构解析失败：{e}", "ERROR")
                return None
            parsed = _parse_json_content(content)
            if parsed is None:
                log_message(f"  [重试 {attempt}/{MAX_API_RETRIES}] JSON解析失败", "WARNING")
                if attempt < MAX_API_RETRIES:
                    _sleep_backoff(attempt)
                continue
            return parsed
        elif resp.status_code in (429, 500, 502, 503, 504):
            # 限流/服务端错误：可重试
            log_message(f"  [重试 {attempt}/{MAX_API_RETRIES}] 服务端错误 {resp.status_code}", "WARNING")
            if attempt < MAX_API_RETRIES:
                _sleep_backoff(attempt)
        else:
            # 4xx 等确定性错误：重试无意义
            log_message(f"  API调用失败：{resp.status_code} {resp.text[:300]}", "ERROR")
            return None

    log_message(f"  API 调用 {MAX_API_RETRIES} 次均失败，跳过该块", "ERROR")
    return None

# ---------- 核心提取函数（支持拆分+缓存） ----------
def _extract_single_chunk(text, book_name, chunk_index=1, chunk_total=1, is_ocr=False, is_toc=False):
    # 安全上限：覆盖"尾部重叠块"可能达到的最大长度（max_length+overlap+最长段），
    # 避免长段落在块边界被从中间截断导致"历史文献"摘抄不完整
    sample = text[:MAX_TEXT_LENGTH * 2 + CHUNK_OVERLAP + 50]
    prompt = _build_prompt(sample, book_name, chunk_index, chunk_total, is_ocr=is_ocr, is_toc=is_toc)
    data = _call_deepseek(prompt)
    if data is None:
        return []
    return _normalize_entries(data, is_ocr=is_ocr)

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

def _norm_sentence(s):
    """归一化句子用于比较：去空白、统一间隔号等标点变体（如 1. 75 vs 1.75、· vs ・）"""
    s = re.sub(r"\s+", "", s)
    s = s.replace("・", "·").replace("‧", "·").replace("•", "·")
    return s

def _split_sentences(text):
    """按句末标点切句（保留标点），用于摘抄去重"""
    return [s for s in re.split(r"(?<=[。；!?！？])", text) if s and s.strip()]

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

def extract_cultural_elements(text, book_name, is_ocr=False):
    """从文本提取文化要素（支持拆分、缓存、去重、OCR感知、目录感知）"""
    # 检查缓存
    is_toc = _detect_toc(text)
    cache_key = get_cache_key(text, book_name, is_ocr=is_ocr, is_toc=is_toc)
    cached = load_from_cache(cache_key)
    if cached is not None:
        log_message(f"  [缓存命中] 直接返回缓存结果 ({len(cached)} 条)", "INFO")
        return cached

    if is_toc:
        log_message("  [识别] 目录/索引页，仅提取明确实体", "INFO")

    # 智能拆分
    if ENABLE_SPLIT and len(text) > MAX_TEXT_LENGTH:
        chunks = split_text_into_chunks(text)
        log_message(f"  [拆分] 文本较长，拆分为 {len(chunks)} 个块", "INFO")
    else:
        chunks = [text[:MAX_TEXT_LENGTH]]

    # 逐块提取（按名称去重）
    all_entries = []
    seen_names = set()
    for idx, chunk in enumerate(chunks):
        entries = _extract_single_chunk(chunk, book_name, chunk_index=idx + 1,
                                        chunk_total=len(chunks), is_ocr=is_ocr, is_toc=is_toc)
        if not entries and len(chunk) > 1500:
            log_message(f"  [警告] 第{idx + 1}块内容较多但提取为0条，请关注是否异常", "WARNING")
        log_message(f"  [块{idx + 1}/{len(chunks)}] 提取 {len(entries)} 条", "INFO")
        for entry in entries:
            name = entry.get("名称", "").strip()
            if name and name not in seen_names:
                seen_names.add(name)
                all_entries.append(entry)

    # 合并跨块产生的近似重复条目（如"汉阳旧城"与"汉阳城"）
    if MERGE_SIMILAR_ENTRIES:
        merged = _merge_similar_entries(all_entries)
        if len(merged) < len(all_entries):
            log_message(f"  [合并] 合并 {len(all_entries) - len(merged)} 条近似重复条目", "INFO")
        all_entries = merged

    # 名称修正标注：原文作"放虞台"被改为"放鹰台"等情形，注明原书用字
    annotated = _annotate_name_corrections(all_entries, text)
    if annotated:
        log_message(f"  [标注] {annotated} 条名称与原文用字不同，已注明'原书作'", "INFO")

    # 保存缓存
    save_to_cache(cache_key, all_entries)
    log_message(f"  [缓存] 已保存 {len(all_entries)} 条到缓存", "INFO")
    return all_entries

# ---------- 并行处理函数 ----------
def process_pdf_file(file_path, book_name):
    """处理单个PDF文件（供并行调用）"""
    log_message(f"处理：{os.path.basename(file_path)}", "INFO")
    raw_text, used_ocr = _extract_text_with_flag(file_path)
    if len(raw_text.strip()) < 50:
        log_message(f"  -> 文本过短，跳过", "WARNING")
        return []
    if used_ocr:
        log_message(f"  [来源] OCR识别文本（{len(raw_text)}字符）", "INFO")
    entries = extract_cultural_elements(raw_text, book_name, is_ocr=used_ocr)
    if entries:
        log_message(f"  -> 提取 {len(entries)} 条", "INFO")
    else:
        log_message(f"  -> 无要素", "WARNING")
    return entries

def process_pdfs_parallel(pdf_paths, book_name, max_workers=MAX_PARALLEL_WORKERS,
                          progress_callback=None):
    """并行处理多个PDF文件。

    progress_callback(done, total)：在主线程按完成顺序回调，可直接驱动 st.progress。
    """
    total = len(pdf_paths)
    if total == 0:
        return []

    results = [None] * total
    done = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(process_pdf_file, path, book_name): i
            for i, path in enumerate(pdf_paths)
        }
        for future in as_completed(future_map):
            idx = future_map[future]
            try:
                results[idx] = future.result()
            except Exception as e:
                log_message(f"  文件处理异常：{e}", "ERROR")
                results[idx] = []
            done += 1
            if progress_callback:
                try:
                    progress_callback(done, total)
                except Exception as e:
                    log_message(f"  进度回调异常（不影响处理）：{e}", "WARNING")

    # 按上传顺序汇总
    all_entries = []
    for entries in results:
        if entries:
            all_entries.extend(entries)

    # 跨文件合并近似重复条目（同一批文件视为同一部文献的分册/分页，
    # 如"石榴花塔/晴川阁"在不同页码文件中各出现一次 -> 合并为一条完整记录）
    if MERGE_SIMILAR_ENTRIES and len(all_entries) > 1:
        merged = _merge_similar_entries(all_entries)
        if len(merged) < len(all_entries):
            log_message(f"  [跨文件合并] 合并 {len(all_entries) - len(merged)} 条近似重复条目", "INFO")
        all_entries = merged
    return all_entries

# ---------- 独立运行入口 ----------
def main():
    log_message(f"=== {APP_NAME} v{VERSION} 启动 ===")
    pdf_files = glob.glob("*.pdf")
    if not pdf_files:
        log_message("当前文件夹没有找到PDF文件", "ERROR")
        return
    log_message(f"找到 {len(pdf_files)} 个PDF文件，使用 {MAX_PARALLEL_WORKERS} 个并行线程")

    all_entries = process_pdfs_parallel(pdf_files, DEFAULT_BOOK_NAME)

    if all_entries:
        df = pd.DataFrame(all_entries)
        output_file = f"{OUTPUT_BASE_NAME}.xlsx"
        df.to_excel(output_file, index=False, engine='openpyxl')
        log_message(f"完成！共提取 {len(all_entries)} 条，保存至 {output_file}", "INFO")
    else:
        log_message("未提取到任何数据", "ERROR")

if __name__ == "__main__":
    main()
