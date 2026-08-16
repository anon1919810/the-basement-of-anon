# -*- coding: utf-8 -*-
"""让そよ"看见"图片：调用本地 Ollama 视觉模型（qwen2.5vl）。

用法：
    python _see.py <图片路径> [提问，可选]

示例：
    python _see.py C:\\Users\\杨睿\\Desktop\\截图.png
    python _see.py 截图.png "图里有哪些文字？"
"""
import base64
import json
import sys
import urllib.request

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
MODEL = "qwen2.5vl:7b"


def see(path, prompt="请详细描述这张图片的内容，包括其中的文字信息。"):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "images": [b64],
        "stream": False,
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read().decode())
    return (data.get("response") or "").strip()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python _see.py <图片路径> [提问]")
        sys.exit(1)
    prompt = sys.argv[2] if len(sys.argv) > 2 else "请详细描述这张图片的内容，包括其中的文字信息。"
    print(see(sys.argv[1], prompt))
