"""T4 提取管线冒烟：极小文本 + 单轮，验证 移植模块→DeepSeek→后处理 全链路。

会调用一次 DeepSeek API（极小成本）。失败时退出码非 0。
"""
from app import extract_papers as ep

text = (
    "黄鹤楼位于湖北省武汉市长江南岸的蛇山之巅，始建于三国时期吴黄武二年，"
    "历代屡毁屡建。黄鹤楼与岳阳楼、滕王阁并称江南三大名楼，崔颢曾题《黄鹤楼》诗。"
    "武昌鱼是湖北名菜，因毛泽东诗句而闻名。汉剧是湖北地方戏曲剧种之一。"
)
entries = ep.extract_cultural_elements(text, "武汉市志 文物志", is_ocr=False, extraction_passes=1)
print("条目数:", len(entries))
for e in entries[:6]:
    print(" -", e.get("名称"), "|", e.get("类别"))
assert len(entries) > 0, "应有提取结果"
print("T4 SMOKE OK")
