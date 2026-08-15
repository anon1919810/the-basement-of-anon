"""T8+T9 测试：评分/统计/留言板 + 管理后台权限。

读操作用真实 Supabase 数据（无写入），写操作打桩。
"""

from fastapi.testclient import TestClient

from app import database as real_db
from app import env
from app.main import app
from app.routers import admin as admin_router
from app.routers import auth
from app.routers import social as social_router

client = TestClient(app)

fake_user = {"id": "123", "username": "test_user", "api_key": None}
auth.db.get_user_by_id = lambda uid: dict(fake_user) if str(uid) == "123" else None
auth.db.get_api_key = lambda uid: None
auth.db.get_invite = lambda uid: False
env.REQUIRE_KEY_OR_INVITE = False
token = real_db.create_session_token("123")
headers = {"Authorization": f"Bearer {token}"}

# ---------- T8 读接口（真实数据） ----------
r = client.get("/api/stats", headers=headers)
assert r.status_code == 200, r.text
d = r.json()
assert d["ok"] and "user_stats" in d and "category_distribution" in d
print("统计看板 OK：总记录", d["total_records"], "总条目", d["total_entries"], "| 类别分布:", d["category_distribution"])

r = client.get("/api/messages", headers=headers)
assert r.status_code == 200
print("留言板读取 OK：", len(r.json()["messages"]), "条留言")

# ---------- T8 写接口（打桩） ----------
social_router.db.update_rating = lambda *a, **k: True
r = client.post("/api/rating", headers=headers, json={"record_id": 1, "rating": 9, "feedback": "很好"})
assert r.status_code == 200, r.text

social_router.db.add_message = lambda *a, **k: True
r = client.post("/api/messages", headers=headers, json={"content": "测试留言"})
assert r.status_code == 200

social_router.db.delete_message = lambda *a, **k: False
r = client.delete("/api/messages/1", headers=headers)
assert r.status_code == 404, "无权删除应 404"
print("[PASS] T8 评分/统计/留言板 OK")

# ---------- T9 管理后台 ----------
admin_router.db.save_invite = lambda *a, **k: True
admin_router.db.clear_api_key = lambda *a, **k: True

# 非管理员 -> 403
r = client.get("/api/admin/users", headers=headers)
assert r.status_code == 403, "非管理员应 403"
r = client.post("/api/admin/users/1/grant-invite", headers=headers)
assert r.status_code == 403
print("[PASS] T9 非管理员全部 403")

# 管理员 -> 通过（读真实数据）
admin_user = {"id": "999", "username": "失败主义谋士千早爱音", "api_key": None}
auth.db.get_user_by_id = lambda uid: dict(admin_user) if str(uid) == "999" else None
admin_token = real_db.create_session_token("999")
admin_headers = {"Authorization": f"Bearer {admin_token}"}

r = client.get("/api/admin/users", headers=admin_headers)
assert r.status_code == 200, r.text
print("管理员用户列表 OK：", len(r.json()["key_users"]), "个已设Key用户")
r = client.post("/api/admin/users/123/grant-invite", headers=admin_headers)
assert r.status_code == 200
r = client.delete("/api/admin/extractions/1", headers=admin_headers)
assert r.status_code in (200, 404), "删除不存在记录应 404（或已删 200）"
print("[PASS] T9 管理员接口 OK")

print("\nALL SOCIAL+ADMIN TESTS PASS")
