# -*- coding: utf-8 -*-
"""
共享工具：日志、字段定义、子目正则、文本工具（供各模块复用）
"""
import os
import re
import time
from pathlib import Path

# 标准字段
REQUIRED_FIELDS = ["名称", "类别", "时间", "空间", "流域", "基础信息", "历史文献"]

# 【】子目正则
_ZIMU_RE = re.compile(r"【([^】\n]{1,60})】")


def log_message(msg, level="INFO"):
    """写入运行日志并打印（后端副本：日志写在仓库根目录）"""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_path = Path(__file__).resolve().parent.parent.parent / "运行日志.log"
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{level}] {msg}\n")
    print(f"[{level}] {msg}", flush=True)


def _norm_sentence(s):
    """归一化句子用于比较：去空白、统一间隔号等标点变体（如 1. 75 vs 1.75、· vs ・）"""
    s = re.sub(r"\s+", "", s)
    s = s.replace("・", "·").replace("‧", "·").replace("•", "·")
    return s


def _split_sentences(text):
    """按句末标点切句（保留标点），用于摘抄去重"""
    return [s for s in re.split(r"(?<=[。；!?！？])", text) if s and s.strip()]


__all__ = ["REQUIRED_FIELDS", "_ZIMU_RE", "log_message", "_norm_sentence", "_split_sentences"]
