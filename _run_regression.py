# -*- coding: utf-8 -*-
"""
回归测试：自动核对关键语料的提取质量（防止"改A坏B"）
=====================================================
设计原则：易管理 / 速度快 / 自动化
- 易管理：黄金标准集中在下方 CASES 列表，增删一条即可
- 速度快：复用结果缓存，不重复消耗API（扫描件除外，需重OCR）
- 自动化：一条命令 `python _run_regression.py`；全过退出码0，否则1（可接CI）

判据：
- 名称覆盖率：管线输出名称中，能匹配到黄金标准名称的比例（双向子串，容忍
  "合川区岩溪桥"vs"岩溪桥"类差异）
- 引文忠实率：管线引文中，逐字命中或子序列命中原文的比例（≥10字引文）

用法：
  python _run_regression.py           # 完整运行
  python _run_regression.py --quick   # 跳过扫描件（OCR耗时案例）
"""
import os
import re
import glob
import sys
import argparse

import extract_papers as ep
from ocr_corrections import correct_ocr_text

# ============ 黄金标准配置（按需增删） ============
SITE_NAMES = [
    "放鹰台遗址", "老人桥遗址", "马投潭遗址", "许家墩遗址", "棋子墩·后山遗址",
    "余家嘴遗址", "钥匙墩遗址", "盘龙城遗址", "纱帽山遗址", "郢州城遗迹",
    "武昌旧城", "汉阳旧城",
]

CASES = [
    {
        "file": "武汉市志 文物志 (武汉地方志编纂委员会) 遗址(z-library.sk, 1lib.sk, z-lib.pdf",
        "book": "武汉市志 文物志",
        "golden_names": SITE_NAMES,           # 文本层+子目模式：期望100%
        "min_coverage": 0.9,
        "min_fidelity": 0.9,
        "quick_ok": True,
    },
    {
        "file": "示例/重庆分册  上.docx",
        "book": "重庆分册 上",
        "golden_xlsx": "示例/重庆分册 文化要素提取结果.xlsx",
        "min_coverage": 0.5,                  # Word路线：259条 vs 人工270条
        "min_fidelity": 0.8,
        "quick_ok": True,
    },
    {
        "file": "示例/提取自江西省志*.docx",
        "book": "江西省志 文化艺术志",
        "golden_xlsx": "示例/江西_文化要素提取结果 (10).xlsx",
        "min_coverage": 0.5,                  # 最大子目模式：6/7（船歌为子项，按设计排除）
        "min_fidelity": 0.8,
        "quick_ok": True,
    },
    {
        "file": "示例/test(4).pdf",
        "book": "武汉市志 文物志",
        "golden_xlsx": "示例/武汉市志 文物志_文化要素提取结果 (9).xlsx",
        "min_coverage": 0.4,                  # 扫描件：OCR质量受限
        "min_fidelity": 0.5,
        "quick_ok": False,                    # 需重OCR，--quick时跳过
    },
]


def norm(s):
    return re.sub(r"\s+", "", str(s)).replace("·", "").replace("・", "")


def matched(golden, pipeline_names):
    """golden名称是否被某个管线名称命中：双向子串，或仅1字之差（如放虞台/放鹰台）"""
    from difflib import SequenceMatcher
    gn = norm(golden)
    if not gn:
        return False
    for p in pipeline_names:
        pn = norm(p)
        if not pn:
            continue
        if gn == pn or gn in pn or pn in gn:
            return True
        # 仅1字之差的变体（如放虞台/放鹰台、钥匙城/钥匙墩，5字名相似度0.8）
        if len(gn) >= 3 and len(pn) >= 3 and SequenceMatcher(None, gn, pn).ratio() >= 0.75:
            return True
    return False


def quote_fidelity(entries, source):
    S = re.sub(r"\s+", "", source or "")
    if not S:
        return 1.0
    ok = total = 0
    for e in entries:
        q = re.sub(r"\s+", "", e.get("历史文献", ""))
        if len(q) < 10:
            continue
        total += 1
        if q in S:
            ok += 1
            continue
        it = iter(S)
        if all(c in it for c in q):
            ok += 1
    return (ok / total) if total else 1.0


def get_source_text(file_path):
    """取得提取所用的源文本（与process_pdf_file一致，含OCR纠错）"""
    text, used = ep._extract_text_with_flag(file_path)
    if used and ep.OCR_CORRECT:
        text = correct_ocr_text(text)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true", help="跳过扫描件（OCR耗时案例）")
    args = parser.parse_args()

    results = []
    failed = 0
    for i, case in enumerate(CASES, 1):
        fp = case["file"]
        # 解析文件路径：支持glob通配符；不存在时按前缀在示例目录中模糊定位
        if "*" in fp or "?" in fp:
            cands = glob.glob(fp) or glob.glob(os.path.join(os.path.dirname(fp) or ".", os.path.basename(fp)))
            fp = cands[0] if cands else fp
        if not os.path.exists(fp):
            base = os.path.basename(fp)
            ext = "*.docx" if base.lower().endswith(".docx") else "*.pdf"
            cands = [p for p in glob.glob(os.path.join(os.path.dirname(fp) or ".", ext))
                     if base.split("(")[0][:6] in os.path.basename(p)]
            if cands:
                fp = cands[0]
            else:
                print(f"[{i}] 跳过（文件不存在）：{base}")
                continue
        if args.quick and not case.get("quick_ok", True):
            print(f"[{i}] 跳过（--quick）：{os.path.basename(fp)}")
            continue

        print(f"\n{'='*64}\n[{i}] {os.path.basename(fp)}")
        entries = ep.process_pdf_file(fp, case["book"])   # 缓存命中则零API

        # 黄金名称
        if case.get("golden_names"):
            golden = case["golden_names"]
        else:
            import pandas as pd
            df = pd.read_excel(case["golden_xlsx"])
            golden = [str(x) for x in df.iloc[:, 0]]
        pipe_names = [e.get("名称", "") for e in entries]
        coverage = sum(1 for g in golden if matched(g, pipe_names)) / len(golden)

        # 引文忠实
        source = get_source_text(fp)
        fidelity = quote_fidelity(entries, source)

        status = "✅ PASS" if (coverage >= case["min_coverage"] and fidelity >= case["min_fidelity"]) else "❌ FAIL"
        if status.startswith("❌"):
            failed += 1
        print(f"   条目: {len(entries)}  |  名称覆盖率: {coverage:.0%} (≥{case['min_coverage']:.0%})"
              f"  |  引文忠实率: {fidelity:.0%} (≥{case['min_fidelity']:.0%})  {status}")
        if coverage < case["min_coverage"]:
            miss = [g for g in golden if not matched(g, pipe_names)]
            print(f"   未覆盖名称示例: {miss[:8]}")
        results.append(status)

    print(f"\n{'='*64}\n回归结果: {results.count('✅ PASS')} 过 / {len(results)} 项")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
