# -*- coding: utf-8 -*-
"""
文献文化要素提取工具 - 核心处理模块
v2.2.0 新增：智能拆分、结果缓存、并行处理、OCR集成
"""

import os
import json
import glob
import time
import hashlib
import pickle
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import pandas as pd
import fitz  # PyMuPDF
from dotenv import load_dotenv
from config import (
    MODEL_NAME, TEMPERATURE, MAX_TEXT_LENGTH, API_TIMEOUT,
    DEFAULT_BOOK_NAME, OUTPUT_BASE_NAME, VERSION,
    FEW_SHOT_EXAMPLES, ENABLE_CACHE, CACHE_EXPIRE_DAYS,
    MAX_PARALLEL_WORKERS, ENABLE_OCR, TESSERACT_PATH,
    ENABLE_SPLIT, CHUNK_OVERLAP
)

load_dotenv()
API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not API_KEY:
    print("[错误] 请在 .env 文件中设置 DEEPSEEK_API_KEY")

# ---------- OCR 模块 ----------
def ocr_pdf(pdf_path):
    """使用Tesseract OCR识别扫描版PDF"""
    try:
        from pdf2image import convert_from_path
        import pytesseract
        
        if TESSERACT_PATH and os.path.exists(TESSERACT_PATH):
            pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH
        
        images = convert_from_path(pdf_path, dpi=150)
        full_text = ""
        for i, img in enumerate(images):
            text = pytesseract.image_to_string(img, lang='chi_sim+eng')
            full_text += text + "\n"
        return full_text
    except ImportError:
        print("[警告] 未安装pdf2image或pytesseract，OCR功能不可用")
        return ""
    except Exception as e:
        print(f"[警告] OCR识别失败：{e}")
        return ""

# ---------- 文本提取（带OCR后备） ----------
def extract_text_from_pdf(pdf_path):
    """从PDF提取文本（暂时禁用表格过滤，确保正文可提取）"""
    try:
        doc = fitz.open(pdf_path)
        full_text = ""
        
        for page in doc:
            # 直接用 get_text() 提取所有文本
            page_text = page.get_text()
            full_text += page_text + "\n\n"
        
        doc.close()
        
        # 如果提取出的文本量很少但PDF有内容，启用OCR
        if len(full_text.strip()) < 100 and ENABLE_OCR:
            print(f"  [提示] {os.path.basename(pdf_path)} 疑似扫描件，启动OCR...")
            full_text = ocr_pdf(pdf_path)
        
        return full_text
        
    except Exception as e:
        print(f"  [警告] 读取PDF失败：{e}")
        return ""

# ---------- 智能拆分 ----------
def split_text_into_chunks(text, max_length=MAX_TEXT_LENGTH, overlap=CHUNK_OVERLAP):
    """将长文本按段落智能拆分为多个块"""
    if len(text) <= max_length:
        return [text]
    
    # 按段落分割
    paragraphs = text.split('\n\n')
    chunks = []
    current_chunk = ""
    
    for para in paragraphs:
        if len(current_chunk) + len(para) <= max_length:
            current_chunk += para + "\n\n"
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            # 保留重叠部分（防止信息断裂）
            if overlap > 0 and current_chunk:
                overlap_text = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
                current_chunk = overlap_text + para + "\n\n"
            else:
                current_chunk = para + "\n\n"
    
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    return chunks

# ---------- 缓存工具 ----------
def get_cache_key(text, book_name):
    """生成缓存键（基于文本哈希）"""
    content = (text[:10000] + str(len(text)) + book_name).encode('utf-8')
    return hashlib.md5(content).hexdigest()

def load_from_cache(cache_key):
    """从缓存加载结果"""
    if not ENABLE_CACHE:
        return None
    cache_file = f"cache/{cache_key}.pkl"
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
    os.makedirs("cache", exist_ok=True)
    cache_file = f"cache/{cache_key}.pkl"
    with open(cache_file, 'wb') as f:
        pickle.dump(data, f)

# ---------- 日志工具 ----------
def log_message(msg, level="INFO"):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open("运行日志.log", "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{level}] {msg}\n")
    print(f"[{level}] {msg}")

# ---------- 核心提取函数（支持拆分+缓存） ----------
def extract_cultural_elements(text, book_name):
    """从文本提取文化要素（支持拆分和缓存）"""
    # 检查缓存
    cache_key = get_cache_key(text, book_name)
    cached = load_from_cache(cache_key)
    if cached is not None:
        log_message(f"  [缓存命中] 直接返回缓存结果 ({len(cached)} 条)", "INFO")
        return cached
    
    # 智能拆分
    if ENABLE_SPLIT and len(text) > MAX_TEXT_LENGTH:
        chunks = split_text_into_chunks(text)
        log_message(f"  [拆分] 文本较长，拆分为 {len(chunks)} 个块", "INFO")
    else:
        chunks = [text[:MAX_TEXT_LENGTH]]
    
    # 逐块提取
    all_entries = []
    seen_names = set()
    for idx, chunk in enumerate(chunks):
        entries = _extract_single_chunk(chunk, book_name, chunk_index=idx+1)
        for entry in entries:
            name = entry.get("名称", "")
            if name and name not in seen_names:
                seen_names.add(name)
                all_entries.append(entry)
    
    # 保存缓存
    save_to_cache(cache_key, all_entries)
    log_message(f"  [缓存] 已保存 {len(all_entries)} 条到缓存", "INFO")
    return all_entries

def _extract_single_chunk(text, book_name, chunk_index=1):
    """提取单个文本块（内部函数）"""
    sample = text[:MAX_TEXT_LENGTH]
    prompt = f"""
你是一位专业的文史档案整理专家。请仔细阅读以下地方志/档案文献片段（来源：《{book_name}》），提取其中所有有研究价值的文化要素。

**文化要素包括**：考古遗址、历史建筑、古迹、历史人物/事件、民俗习俗、精神文化现象等。

**输出要求（严格遵守）**：
- 输出格式：严格的JSON数组，每个对象包含以下字段：名称、类别、时间、空间、流域、基础信息、历史文献。
- 每个字段的内容规则：
  - "名称"：要素名称
  - "类别"：从以下五选一——物质文化、精神文化、制度文化、行为文化、心理文化
  - "时间"：年代或时期，不确定则填"不详"
  - "空间"：地点，**禁止直接抄袭原文的地理描述**。必须按照"XX省XX市XX区/县"的行政区划格式输出。规则如下：
    1. 从原文中提取地名信息，推断其所属的省、市、区/县三级。
    2. 格式必须为"XX省XX市XX区/县"，如"湖北省武汉市武昌区"。
    3. 如果原文只提到区/县名（如"武昌"），则补全省市为"湖北省武汉市武昌区"。
    4. 如果原文只提到市名（如"荆州"），则输出为"湖北省荆州市"（区/县部分省略）。
    5. 如果原文只提到省名（如"湖北"），则输出为"湖北省"（市/区部分省略）。
    6. 如果有更细的乡镇/街道信息，追加在后面，如"湖北省武汉市武昌区水果湖街道"。
    7. 原文中的"城郊""城外""东湖西岸"等描述，作为补充信息放在区/县后面，如"湖北省武汉市武昌区东湖西岸"。
    8. 如果完全无法判断所属省市，则填"不详"。
    注意：所有输出必须明确写出"省""市""区"等行政单位名称，不得省略。
  - "流域"：填"长江流域"或"汉江流域"，无法判断则填"不详"
  - "基础信息"：**请用简洁的语言归纳总结（不超过50字）**
  - "历史文献"：**必须摘抄原文完整段落**，格式为《{book_name}》："原文摘抄"，并尽量标注页码。

**分类参考示例（请严格参照此逻辑）**：
{FEW_SHOT_EXAMPLES}

**重要原则**：宁可多提取，也不要遗漏。如果文献中没有文化要素，返回空数组 []。

文献片段如下（第{chunk_index}部分）：
{sample}
"""
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": TEMPERATURE,
        "response_format": {"type": "json_object"}
    }
    try:
        response = requests.post(
            "https://api.deepseek.com/chat/completions",
            headers=headers,
            json=payload,
            timeout=API_TIMEOUT
        )
        if response.status_code == 200:
            result = response.json()
            content = result["choices"][0]["message"]["content"]
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            return json.loads(content.strip())
        else:
            log_message(f"  API调用失败：{response.status_code}", "ERROR")
            return []
    except Exception as e:
        log_message(f"  API请求出错：{e}", "ERROR")
        return []

# ---------- 并行处理函数 ----------
def process_pdf_file(file_path, book_name, progress_callback=None):
    """处理单个PDF文件（供并行调用）"""
    log_message(f"处理：{os.path.basename(file_path)}", "INFO")
    raw_text = extract_text_from_pdf(file_path)
    if len(raw_text) < 50:
        log_message(f"  -> 文本过短，跳过", "WARNING")
        return []
    entries = extract_cultural_elements(raw_text, book_name)
    if entries:
        log_message(f"  -> 提取 {len(entries)} 条", "INFO")
    else:
        log_message(f"  -> 无要素", "WARNING")
    return entries

def process_pdfs_parallel(pdf_paths, book_name, max_workers=MAX_PARALLEL_WORKERS):
    """并行处理多个PDF文件"""
    all_entries = []
    total = len(pdf_paths)
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(process_pdf_file, path, book_name): path
            for path in pdf_paths
        }
        for idx, future in enumerate(as_completed(futures), 1):
            entries = future.result()
            all_entries.extend(entries)
            print(f"  [进度] {idx}/{total} 完成")
    
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