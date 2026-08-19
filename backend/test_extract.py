"""T5 提取 API 测试。

原则：不污染生产数据库（save_extraction 打桩为 999）。
会调用一次 DeepSeek API（极小成本）验证全链路。
"""

import io

from docx import Document
from fastapi.testclient import TestClient

from app import database as real_db
from app import env
from app.main import app
from app.routers import auth
from app.routers import extract as extract_router

client = TestClient(app)

# ---------- 负路径 ----------
assert client.post("/api/extract").status_code == 401, "未登录应 401"

# ---------- 准备 mock 用户 + 有效令牌 ----------
fake_user = {"id": "123", "username": "test_user", "api_key": None}
auth.db.get_user_by_id = lambda uid: dict(fake_user) if str(uid) == "123" else None
auth.db.get_api_key = lambda uid: None
auth.db.get_invite = lambda uid: False
env.REQUIRE_KEY_OR_INVITE = False  # 测试用作者Key，无需权限
extract_router.db.save_extraction = lambda *a, **k: 999  # 不打生产库
token = real_db.create_session_token("123")
headers = {"Authorization": f"Bearer {token}"}

# ---------- 文件类型校验 ----------
r = client.post("/api/extract", headers=headers,
                files=[("files", ("a.txt", io.BytesIO(b"hello"), "text/plain"))],
                data={"book_name": "测试"})
assert r.status_code == 400, f"非 PDF/Word 应 400，实际 {r.status_code}"

# ---------- 迷你 docx 全链路提取 ----------
doc = Document()
doc.add_paragraph(
    "黄鹤楼位于湖北省武汉市长江南岸的蛇山之巅，始建于三国时期吴黄武二年。"
    "武昌鱼是湖北名菜，因毛泽东诗句而闻名。汉剧是湖北地方戏曲剧种之一。"
)
buf = io.BytesIO()
doc.save(buf)
buf.seek(0)

r = client.post(
    "/api/extract",
    headers=headers,
    files=[("files", ("测试文献.docx", buf,
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    data={"book_name": "测试文献", "extract_max_only": "true"},
)
assert r.status_code == 200, r.text
data = r.json()
assert data["ok"] is True, data
assert data["entry_count"] >= 1, "应至少提取1条"
assert data["record_id"] == 999, "应走打桩的入库"
names = [e.get("名称") for e in data["entries"]]
print("提取到:", names[:6])
assert any("黄鹤楼" in n for n in names), "应包含黄鹤楼"
# 引文格式：《书名》："引文"
for e in data["entries"]:
    q = e.get("历史文献") or ""
    if q:
        assert q.startswith("《测试文献》：“"), f"引文应带书名格式，实际：{q[:30]}"
print("[PASS] T5 提取 API：鉴权→类型校验→docx提取→入库桩→引文《书名》格式 全通")

print("\nALL EXTRACT TESTS PASS")
