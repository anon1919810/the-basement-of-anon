# -*- coding: utf-8 -*-
"""
文献文化要素提取工具 - 核心调度模块（v3.4 模块化重构）
====================================================
职责：缓存、拆分、API调用、多轮抽取、模式调度、并行处理。
各子模块：
  - prompts.py      提示词模板与结构检测（目录/子目/Few-shot）
  - ocr_engine.py   文本/OCR引擎（PDF文本层、Word、RapidOCR/Tesseract）
  - postprocess.py  后处理（JSON解析、空间补全、合并、标注、引文校验）
  - shared.py       共享工具（日志、字段、正则）
"""
import os
import re
import json
import glob
import time
import hashlib
import pickle
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd
from dotenv import load_dotenv

from config import (
    MODEL_NAME, TEMPERATURE, MAX_TEXT_LENGTH, API_TIMEOUT,
    DEFAULT_BOOK_NAME, OUTPUT_BASE_NAME, VERSION, APP_NAME,
    FEW_SHOT_EXAMPLES, ENABLE_CACHE, CACHE_EXPIRE_DAYS, CACHE_DIR,
    MAX_PARALLEL_WORKERS, ENABLE_SPLIT, CHUNK_OVERLAP,
    EXTRACTION_PASSES, ADAPTIVE_PASSES,
    LOW_YIELD_THRESHOLD, LOW_YIELD_MIN_CHARS, MAX_LOW_YIELD_RETRIES,
    API_URL, MAX_API_RETRIES, RETRY_BACKOFF_SECONDS, MAX_OUTPUT_TOKENS,
    PROMPT_TEMPLATE_VERSION, STRICT_EXTRACTION, STRUCTURE_MODE,
    MERGE_SIMILAR_ENTRIES, OCR_CORRECT, EXTRACT_MAX_ONLY, QUOTE_WITH_SOURCE,
    # 兼容导出（app.py 等可能直接引用）
    OCR_DPI, OCR_ENGINE, TESSERACT_PATH, ENABLE_OCR,
)
from ocr_corrections import correct_ocr_text

# 子模块（重构后从各模块导入函数）
from shared import *          # log_message 等
from prompts import *         # _build_prompt / _detect_toc / _detect_zimu 等
from ocr_engine import *      # _extract_text_with_flag / extract_text_from_pdf 等
from postprocess import *     # _normalize_entries / _merge_similar_entries 等

load_dotenv()
API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not API_KEY:
    print("[错误] 请在 .env 文件中设置 DEEPSEEK_API_KEY")

# 运行期可覆盖的API Key：用户登录后设置自己的Key时由app.py赋值，
# 未设置则回退到作者的API_KEY（每次处理前app.py都会显式重置，避免串用）
ACTIVE_API_KEY = None

# 最近一次批处理的源文本（供入库/生成回归基准；process_pdfs_parallel 开始时清空）
LAST_SOURCES = []

# 复用 HTTP 连接（避免每次请求重建握手）
_http = requests.Session()


def format_quote(quote, book_name):
    """历史文献标注来源：《书名》："引文"（仅输出展示时使用，内部引文保持纯净以便校验/合并）"""
    if not quote:
        return quote
    if QUOTE_WITH_SOURCE and book_name:
        return f"《{book_name}》：“{quote}”"
    return quote


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
def _prompt_signature(is_ocr=False, is_toc=False, extraction_passes=None, is_zimu=False):
    """计算提示词/配置签名：修改模板、Few-shot、模型参数后自动使旧缓存失效"""
    passes = extraction_passes or EXTRACTION_PASSES
    seed = "|".join([
        str(PROMPT_TEMPLATE_VERSION),
        str(MODEL_NAME), str(TEMPERATURE),
        str(MAX_TEXT_LENGTH), str(CHUNK_OVERLAP),
        str(STRICT_EXTRACTION),
        str(STRUCTURE_MODE),
        str(FEW_SHOT_EXAMPLES),
        str(passes),
        str(is_ocr), str(is_toc), str(is_zimu),
    ])
    return hashlib.md5(seed.encode("utf-8")).hexdigest()[:12]


def get_cache_key(text, book_name, is_ocr=False, is_toc=False, extraction_passes=None, is_zimu=False):
    """生成缓存键（全文哈希 + 文献名 + 配置签名 + 模式标志）"""
    text_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
    raw = f"{text_hash}|{book_name}|{_prompt_signature(is_ocr, is_toc, extraction_passes, is_zimu)}"
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


# ---------- API 调用（带重试） ----------
def _sleep_backoff(attempt):
    time.sleep(RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))


def _call_deepseek(prompt):
    """调用 DeepSeek API，返回解析后的 JSON（失败自动重试）。

    使用当前有效Key：用户自带Key（ACTIVE_API_KEY）优先，否则用作者的默认Key。
    """
    key = ACTIVE_API_KEY or API_KEY
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "response_format": {"type": "json_object"},
    }

    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            resp = _http.post(API_URL, headers=headers, json=payload, timeout=API_TIMEOUT)
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


def chat_completion(messages, max_tokens=2048, temperature=0.3):
    """通用对话调用（供AI工作台补充基础信息/自由问答使用）。

    使用当前有效Key（用户自带 Key > 管理员/邀请码的作者 Key）。
    返回回复文本；失败返回 None。
    """
    key = ACTIVE_API_KEY or API_KEY
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        resp = _http.post(API_URL, headers=headers, json=payload, timeout=API_TIMEOUT)
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"]
        log_message(f"  对话调用失败：{resp.status_code} {resp.text[:150]}", "ERROR")
        return None
    except Exception as e:
        log_message(f"  对话调用异常：{e}", "ERROR")
        return None


def chat_completion_stream(messages, max_tokens=2048, temperature=0.3):
    """流式对话调用（SSE）：逐段 yield 文本（用于打字机效果）。

    使用当前有效Key；调用失败时 yield None 一次后结束。
    """
    key = ACTIVE_API_KEY or API_KEY
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    try:
        resp = _http.post(API_URL, headers=headers, json=payload, timeout=API_TIMEOUT, stream=True)
        if resp.status_code != 200:
            log_message(f"  流式对话调用失败：{resp.status_code} {resp.text[:150]}", "ERROR")
            yield None
            return
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                delta = json.loads(data)["choices"][0]["delta"].get("content", "")
            except Exception:
                continue
            if delta:
                yield delta
    except Exception as e:
        log_message(f"  流式对话异常：{e}", "ERROR")
        yield None


# ---------- 核心提取函数（支持拆分+缓存） ----------
def _extract_single_chunk(text, book_name, chunk_index=1, chunk_total=1, is_ocr=False, is_toc=False,
                          extraction_passes=None):
    """提取单个文本块。

    策略：多轮抽取取并集（默认EXTRACTION_PASSES）——实测模型对同一块
    多次调用的输出在 1条~45条 间波动且子集互不相同，轮次并集可显著提升召回；
    单轮模式（EXTRACTION_PASSES=1）下保留低产出重试兜底。
    """
    sample = text[:MAX_TEXT_LENGTH * 2 + CHUNK_OVERLAP + 50]
    prompt = _build_prompt(sample, book_name, chunk_index, chunk_total, is_ocr=is_ocr, is_toc=is_toc)

    passes = max(1, extraction_passes or EXTRACTION_PASSES)
    all_entries = []
    seen_names = set()
    for p in range(passes):
        prev_count = len(all_entries)
        data = _call_deepseek(prompt)
        entries = _normalize_entries(data, is_ocr=is_ocr) if data is not None else []
        for e in entries:
            name = e.get("名称", "").strip()
            if name and name not in seen_names:
                seen_names.add(name)
                all_entries.append(e)
        # 自适应收敛：第2轮起，若新增条数不足前一轮的25%则提前结束（省Token）
        if (ADAPTIVE_PASSES and p >= 1 and prev_count >= 8
                and len(all_entries) - prev_count < max(2, prev_count * 0.25)):
            log_message(f"  [收敛] 块{chunk_index} 第{p + 1}轮新增不足，提前结束（共{len(all_entries)}条）", "INFO")
            break

    # 单轮模式：低产出重试（模型偶发"只给1条"的失败模式）
    if passes == 1 and len(all_entries) < LOW_YIELD_THRESHOLD and len(text) > LOW_YIELD_MIN_CHARS:
        for attempt in range(1, MAX_LOW_YIELD_RETRIES + 1):
            log_message(f"  [低产出重试 {attempt}/{MAX_LOW_YIELD_RETRIES}] "
                        f"块{chunk_index} 仅{len(all_entries)}条，重新提取", "WARNING")
            data2 = _call_deepseek(prompt)
            entries2 = _normalize_entries(data2, is_ocr=is_ocr) if data2 is not None else []
            for e in entries2:
                name = e.get("名称", "").strip()
                if name and name not in seen_names:
                    seen_names.add(name)
                    all_entries.append(e)
            if len(all_entries) >= LOW_YIELD_THRESHOLD:
                break

    if passes > 1:
        log_message(f"  [块{chunk_index}/{chunk_total}] {passes}轮并集: {len(all_entries)} 条", "INFO")
    # 块内合并近似重复（跨轮次的同名变体）
    merged = _merge_similar_entries(all_entries) if len(all_entries) > 1 else all_entries
    if len(merged) < len(all_entries):
        log_message(f"  [块内合并] 合并 {len(all_entries) - len(merged)} 条", "INFO")
    return merged


def _extract_zimu_entries(text, book_name, is_ocr=False, blocks=None):
    """子目模式提取：名称/引文确定性取自原文，元数据由模型批量填写"""
    if blocks is None:
        blocks = _parse_zimu_blocks(text) or _parse_colon_entries(text)
    if not blocks:
        return []
    log_message(f"  [子目模式] 识别 {len(blocks)} 个【】子目", "INFO")

    # 按提示词体积分组（每组的正文预览总长不超过 ~6000 字）
    groups, cur, cur_len = [], [], 0
    for title, body in blocks:
        size = len(title) + min(len(body), 200)
        if cur and cur_len + size > 6000:
            groups.append(cur)
            cur, cur_len = [], 0
        cur.append((title, body))
        cur_len += size
    if cur:
        groups.append(cur)

    entries = []
    for gi, group in enumerate(groups, 1):
        data = _call_deepseek(_build_zimu_prompt(group, book_name, gi, len(groups)))
        meta = {}
        if isinstance(data, dict):
            for key in ("entries", "条目", "数据", "results"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
        if isinstance(data, list):
            for raw in data:
                if isinstance(raw, dict) and raw.get("名称"):
                    meta[re.sub(r"\s+", "", str(raw["名称"]))] = raw
        for title, body in group:
            norm_title = re.sub(r"\s+", "", title)
            m = meta.get(norm_title, {})
            entry = {
                "名称": title,
                "类别": str(m.get("类别", "")).strip(),
                "时间": str(m.get("时间", "")).strip(),
                "空间": str(m.get("空间", "")).strip(),
                "流域": str(m.get("流域", "")).strip(),
                "基础信息": str(m.get("基础信息", "")).strip(),
                "历史文献": _first_sentences(body),
            }
            entries.append(entry)

    # 统一规范化（校验类别/流域、空间补全、OCR乱码清理）
    normalized = _normalize_entries({"entries": entries}, is_ocr=is_ocr)
    if len(normalized) < len(entries):
        log_message(f"  [校验] 剔除 {len(entries) - len(normalized)} 条无效子目", "WARNING")
    return normalized


def extract_cultural_elements(text, book_name, is_ocr=False, extraction_passes=None):
    """从文本提取文化要素（支持拆分、缓存、去重、OCR感知、目录感知、子目模式）"""
    # 检查缓存
    is_toc = _detect_toc(text)
    # 子目模式判定：【】子目，或（开启"仅提取最大子目"时）"名称：正文"式条目
    is_zimu = (not is_toc) and (
        _detect_zimu(text)
        or (EXTRACT_MAX_ONLY and len(_parse_colon_entries(text)) >= 2)
    )
    cache_key = get_cache_key(text, book_name, is_ocr=is_ocr, is_toc=is_toc,
                              extraction_passes=extraction_passes, is_zimu=is_zimu)
    cached = load_from_cache(cache_key)
    if cached is not None:
        log_message(f"  [缓存命中] 直接返回缓存结果 ({len(cached)} 条)", "INFO")
        return cached

    if is_toc:
        log_message("  [识别] 目录/索引页，仅提取明确实体", "INFO")

    # 子目模式：每个子目一条（名称/引文确定性取自原文，不在子目内细分）
    if is_zimu:
        all_entries = _extract_zimu_entries(text, book_name, is_ocr=is_ocr)
        save_to_cache(cache_key, all_entries)
        log_message(f"  [缓存] 已保存 {len(all_entries)} 条到缓存", "INFO")
        return all_entries

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
                                        chunk_total=len(chunks), is_ocr=is_ocr, is_toc=is_toc,
                                        extraction_passes=extraction_passes)
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

    # 引文忠实度校验：不逐字命中原文的条目自动标记（"⚠引文待核对"）
    flagged = _verify_quotes(all_entries, text)
    if flagged:
        log_message(f"  [校验] {flagged} 条引文未逐字命中原文，已标记待核对", "WARNING")

    # 保存缓存
    save_to_cache(cache_key, all_entries)
    log_message(f"  [缓存] 已保存 {len(all_entries)} 条到缓存", "INFO")
    return all_entries


# ---------- 并行处理函数 ----------
def process_pdf_file(file_path, book_name, extraction_passes=None):
    """处理单个PDF/Word文件（供并行调用）"""
    log_message(f"处理：{os.path.basename(file_path)}", "INFO")
    raw_text, used_ocr = _extract_text_with_flag(file_path)
    if len(raw_text.strip()) < 50:
        log_message(f"  -> 文本过短，跳过", "WARNING")
        return []
    if used_ocr:
        log_message(f"  [来源] OCR识别文本（{len(raw_text)}字符）", "INFO")
        if OCR_CORRECT:
            corrected = correct_ocr_text(raw_text)
            fixed = sum(1 for a, b in zip(raw_text, corrected) if a != b) + abs(len(raw_text) - len(corrected))
            if corrected != raw_text:
                log_message(f"  [纠错] OCR错字纠正完成（约{fixed}处字符变化）", "INFO")
                raw_text = corrected
    entries = extract_cultural_elements(raw_text, book_name, is_ocr=used_ocr,
                                        extraction_passes=extraction_passes)
    LAST_SOURCES.append(raw_text)  # 记录源文本（供入库/生成回归基准）
    if entries:
        log_message(f"  -> 提取 {len(entries)} 条", "INFO")
    else:
        log_message(f"  -> 无要素", "WARNING")
    return entries


def process_pdfs_parallel(pdf_paths, book_name, max_workers=MAX_PARALLEL_WORKERS,
                          progress_callback=None, extraction_passes=None):
    """并行处理多个PDF/Word文件。

    progress_callback(done, total)：在主线程按完成顺序回调，可直接驱动 st.progress。
    extraction_passes：每块抽取轮数（None=用config默认值）。
    """
    total = len(pdf_paths)
    if total == 0:
        return []
    LAST_SOURCES.clear()  # 新一批处理开始时清空源文本记录

    results = [None] * total
    done = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(process_pdf_file, path, book_name,
                            extraction_passes=extraction_passes): i
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
        df["历史文献"] = df["历史文献"].map(lambda q: format_quote(q, DEFAULT_BOOK_NAME))
        output_file = f"{OUTPUT_BASE_NAME}.xlsx"
        df.to_excel(output_file, index=False, engine='openpyxl')
        log_message(f"完成！共提取 {len(all_entries)} 条，保存至 {output_file}", "INFO")
    else:
        log_message("未提取到任何数据", "ERROR")


if __name__ == "__main__":
    main()
