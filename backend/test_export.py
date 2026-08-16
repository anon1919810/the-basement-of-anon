"""P1-7 导出 Excel 测试 + P1-5 stats 省域分布验证。不污染生产库。"""

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

# ---------- 导出 Excel ----------
r = client.post("/api/extract/export", headers=headers, json={
    "book_name": "测试文献",
    "entries": [
        {"名称": "黄鹤楼", "类别": "物质文化", "时间": "三国", "空间": "湖北省武汉市",
         "流域": "长江流域", "基础信息": "江南三大名楼之一", "历史文献": "《黄鹤楼》诗"},
        {"名称": "汉剧", "类别": "精神文化", "空间": "湖北省", "流域": "长江流域"},
    ],
})
assert r.status_code == 200, r.text
assert "spreadsheetml" in r.headers.get("content-type", ""), r.headers
assert r.content[:2] == b"PK", "xlsx 应以 PK 开头"
cd = r.headers.get("content-disposition", "")
assert "filename*=UTF-8''" in cd and ".xlsx" in cd, cd
print("[PASS] 导出 Excel：200 + xlsx 内容 + RFC5987 文件名正确，大小", len(r.content), "字节")

# ---------- stats 省域分布 ----------
r = client.get("/api/stats", headers=headers)
assert r.status_code == 200, r.text
d = r.json()
assert "province_distribution" in d, "stats 应包含省域分布"
print("[PASS] stats 省域分布:", d["province_distribution"])

print("\nALL EXPORT/STATS TESTS PASS")
