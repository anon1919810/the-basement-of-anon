"""T3 认证 API 测试。

原则：不污染生产数据库。
- 负路径（无令牌/坏令牌）：在触库前就被拒，不产生任何写操作
- 正路径（登录→me→key-status→登出）：把 auth 模块的数据库函数替换为假实现
"""

from fastapi.testclient import TestClient

from app import database as real_db
from app.main import app
from app.routers import auth

client = TestClient(app)

# ---------- 负路径（不触网 / 不写库） ----------
assert client.get("/api/auth/me").status_code == 401, "无令牌应 401"
assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401
assert client.get("/api/auth/key-status", headers={"Authorization": "Bearer x.y.z"}).status_code == 401
r = client.post("/api/auth/login", json={"username": "no_such_user_xyz", "password": "p"})
assert r.status_code == 401, f"错误凭据应 401，实际 {r.status_code}"
assert client.post("/api/auth/register", json={"username": "x", "password": "123"}).status_code == 400
print("[PASS] 负路径：无令牌/坏令牌/错误凭据/短用户名 全部正确拒绝")

# ---------- 正路径（mock 数据库函数，模拟真实用户） ----------
fake_user = {"id": "123", "username": "test_user", "email": "", "qq": "", "api_key": None}


def fake_login(u, p):
    return dict(fake_user) if (u == "test_user" and p == "pass1234") else None


def fake_get_user(uid):
    return dict(fake_user) if str(uid) == "123" else None


auth.db.login_user = fake_login
auth.db.get_user_by_id = fake_get_user
auth.db.get_api_key = lambda uid: None
auth.db.get_invite = lambda uid: False

r = client.post("/api/auth/login", json={"username": "test_user", "password": "pass1234"})
assert r.status_code == 200, r.text
data = r.json()
assert data["ok"] and data["token"], "登录应返回令牌"
assert data["user"]["username"] == "test_user"
token = data["token"]

# 令牌本身是真实有效的 HMAC 令牌（校验不触网）
assert real_db.validate_session_token(token) == "123", "令牌应能通过 HMAC 校验"

headers = {"Authorization": f"Bearer {token}"}
r = client.get("/api/auth/me", headers=headers)
assert r.status_code == 200 and r.json()["user"]["username"] == "test_user"
r = client.get("/api/auth/key-status", headers=headers)
assert r.status_code == 200
assert r.json()["allowed"] is False and r.json()["source"] is None, "无Key无邀请时应无权限"
r = client.post("/api/auth/logout")
assert r.status_code == 200 and r.json()["ok"]
print("[PASS] 正路径：登录→令牌校验→me→key-status→登出 全通")

print("\nALL AUTH TESTS PASS")
