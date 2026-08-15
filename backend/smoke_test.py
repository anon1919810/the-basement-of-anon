"""T1 冒烟测试：本地跑 `python smoke_test.py`，全过则骨架可用。"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

r = client.get("/")
assert r.status_code == 200, r.text
assert r.json()["app"]

r = client.get("/api/health")
assert r.status_code == 200, r.text
data = r.json()
assert data["ok"] is True
assert data["version"]

print("SMOKE OK:", data)
