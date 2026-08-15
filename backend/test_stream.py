"""T6 SSE 进度流测试：验证流式事件（saving → extracting → done）。

会调用一次 DeepSeek API（极小成本）。不污染生产库（save_extraction 打桩）。
"""

import io
import json

from docx import Document
from fastapi.testclient import TestClient

from app import database as real_db
from app import env
from app.main import app
from app.routers import auth
from app.routers import extract as extract_router

client = TestClient(app)

fake_user = {"id": "123", "username": "test_user", "api_key": None}
auth.db.get_user_by_id = lambda uid: dict(fake_user) if str(uid) == "123" else None
auth.db.get_api_key = lambda uid: None
auth.db.get_invite = lambda uid: False
env.REQUIRE_KEY_OR_INVITE = False
extract_router.db.save_extraction = lambda *a, **k: 999
token = real_db.create_session_token("123")
headers = {"Authorization": f"Bearer {token}"}

doc = Document()
doc.add_paragraph(
    "黄鹤楼位于湖北省武汉市长江南岸的蛇山之巅，始建于三国时期吴黄武二年。"
    "武昌鱼是湖北名菜。汉剧是湖北地方戏曲剧种之一。"
)
buf = io.BytesIO()
doc.save(buf)
buf.seek(0)

r = client.post(
    "/api/extract/stream",
    headers=headers,
    files={"file": ("测试文献.docx", buf,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    data={"book_name": "测试文献"},
)
assert r.status_code == 200, r.text
events = []
for line in r.text.splitlines():
    if line.startswith("data: "):
        events.append(json.loads(line[6:]))

stages = [e.get("stage") for e in events if e.get("type") == "stage"]
assert "saving" in stages and "extracting" in stages, f"应有阶段事件，实际 {stages}"
done = [e for e in events if e.get("type") == "done"]
assert done, "应有 done 事件"
assert done[0]["entry_count"] >= 1, "应至少提取1条"
print("SSE 事件序列:", [e.get("type") + (":" + str(e.get("stage", ""))) for e in events])
print("[PASS] T6 SSE：saving→extracting→done 全通，条数 =", done[0]["entry_count"])

print("\nALL STREAM TESTS PASS")
