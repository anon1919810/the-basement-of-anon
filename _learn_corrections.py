# -*- coding: utf-8 -*-
"""
轻量学习：从人工确认过的数据中自动挖掘OCR纠错对（易管理/速度快/自动化）
======================================================================
原理：人工摘录Excel中的"名称"是可信的正确写法。若某正确名称在源文本中
找不到，而源文本里存在"仅1字之差、且首尾字相同"的写法，即视为OCR错字，
记录 (错字 -> 正字) 纠错对并统计出现次数。

用法：
  python _learn_corrections.py --xlsx 示例/xx.xlsx --source results/xx_OCR.txt
      # 只报告挖掘到的纠错对（不修改代码）
  python _learn_corrections.py --xlsx 示例/xx.xlsx --source results/xx_OCR.txt --apply
      # 将出现>=2次且无冲突的纠错对自动写入 ocr_corrections.py 的 CHAR_CONFUSIONS

注意：仅当同一纠错对出现>=2次才建议应用，避免单条噪声。
"""
import os
import re
import sys
import argparse
from collections import Counter

from province_dict import PROVINCE_DICT

_SUFFIX_RE = re.compile(
    r"(遗址|遗存|墓群|墓地|崖墓|悬棺|盐场|盐井|盐泉|古道|纤道|题刻|摩崖造像|"
    r"文化|城|桥|塔|井|窑|场|墓|山|观|寺|庙|阁|楼|亭|堰|闸|堤|街|巷|门|"
    r"区|县|市|省)$"
)


def load_names(xlsx_path):
    import pandas as pd
    df = pd.read_excel(xlsx_path)
    col = df.columns[0]
    names = set()
    for v in df[col]:
        s = re.sub(r"\s+", "", str(v))
        if len(s) >= 2:
            names.add(s)
            b = _SUFFIX_RE.sub("", s)
            if len(b) >= 2:
                names.add(b)
    return names


def mine_pairs(names, source_text):
    """挖掘 (错字->正字) 对：正确名不在原文，但原文有同长度、首尾字相同的1字差异写法"""
    S = source_text
    pairs = Counter()
    for name in names:
        if name in S:
            continue
        for i in range(len(S) - len(name) + 1):
            window = S[i:i + len(name)]
            if window[0] != name[0] or window[-1] != name[-1]:
                continue
            diffs = [(a, b) for a, b in zip(window, name) if a != b]
            if len(diffs) == 1:
                pairs[diffs[0]] += 1
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True, help="人工确认的Excel（含名称列）")
    ap.add_argument("--source", required=True, help="提取所用的源文本文件")
    ap.add_argument("--apply", action="store_true", help="将>=2次的纠错对写入ocr_corrections.py")
    ap.add_argument("--min-count", type=int, default=2, help="应用的最低出现次数（默认2）")
    args = ap.parse_args()

    if not os.path.exists(args.xlsx):
        print(f"找不到Excel: {args.xlsx}")
        sys.exit(1)
    if not os.path.exists(args.source):
        print(f"找不到源文本: {args.source}")
        sys.exit(1)

    names = load_names(args.xlsx)
    with open(args.source, encoding="utf-8") as f:
        source = f.read()

    pairs = mine_pairs(names, source)
    print(f"从 {len(names)} 个名称中挖掘到 {len(pairs)} 个候选纠错对：")
    for (wrong, right), n in pairs.most_common():
        tag = "   ←建议" if n >= args.min_count else ""
        print(f"  {wrong!r} -> {right!r}  出现{n}次{tag}")

    # 排除已在字典中的对
    from ocr_corrections import CHAR_CONFUSIONS
    new_pairs = {k: v for k, v in pairs.items()
                 if v >= args.min_count and CHAR_CONFUSIONS.get(k) != v}

    if not args.apply:
        print(f"\n（未应用。加 --apply 可把 {len(new_pairs)} 个新纠错对写入 ocr_corrections.py）")
        return

    if not new_pairs:
        print("\n没有需要应用的新纠错对。")
        return

    # 写入 ocr_corrections.py 的 CHAR_CONFUSIONS 字典
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr_corrections.py")
    with open(path, encoding="utf-8") as f:
        code = f.read()
    lines = []
    inserted = 0
    for line in code.splitlines():
        lines.append(line)
        if '"潮": "湖"' in line and inserted == 0:  # 锚点：插到混淆表开头之后
            for wrong, right in sorted(new_pairs.items()):
                if wrong != right:
                    lines.append(f'    "{wrong}": "{right}",')
                    inserted += 1
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n✅ 已写入 {inserted} 个新纠错对到 ocr_corrections.py（下次提取自动生效）")


if __name__ == "__main__":
    main()
