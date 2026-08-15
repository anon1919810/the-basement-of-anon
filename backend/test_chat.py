"""T7 对话/补充 API 测试（两次极小 API 调用）。不污染生产库。"""

import json

from fastapi.testclient import TestClient

from app import database as real_db
from app import env
from app.main import app
from app.routers import auth

client = TestClient(app)

fake_user = {"id": "123", "username": "test_user", "api_key": None}
auth.db.get_user_by_id = lambda uid: dict(fake_user) if str(uid) == "123" else None
auth.db.get_api_key = lambda uid: None
auth.db.get_invite = lambda uid: False
env.REQUIRE_KEY_OR_INVITE = False
token = real_db.create_session_token("123")
headers = {"Authorization": f"Bearer {token}"}

# ---------- 负路径 ----------
assert client.post("/api/chat", json={"messages": []}).status_code == 401
assert client.post("/api/chat/supplement", json={"name": "x"}).status_code == 401

# ---------- 条目补充 ----------
r = client.post("/api/chat/supplement", headers=headers, json={
    "name": "黄鹤楼", "category": "物质文化", "time": "三国吴黄武二年",
    "space": "武汉市武昌区蛇山", "info": "江南三大名楼之一",
    "quote": "崔颢《黄鹤楼》诗",
})
assert r.status_code == 200, r.text
reply = r.json()["reply"]
assert isinstance(reply, str) and len(reply) > 5, "补充内容应非空"
print("补充结果:", reply[:40], "...")
print("[PASS] 条目补充 OK")

# ---------- 自由对话（SSE 流式） ----------
r = client.post("/api/chat", headers=headers, json={
    "messages": [{"role": "user", "content": "用一句话介绍盘龙城遗址"}]
})
assert r.status_code == 200, r.text
events = []
for line in r.text.splitlines():
    if line.startswith("data: "):
        events.append(json.loads(line[6:]))
deltas = "".join(e.get("content", "") for e in events if e.get("type") == "delta")
assert any(e.get("type") == "done" for e in events), "应有 done 事件"
assert len(deltas) > 0, "应有流式内容"
print("流式回复:", deltas[:40], "...")
print("[PASS] 自由对话 SSE OK")

print("\nALL CHAT TESTS PASS")
