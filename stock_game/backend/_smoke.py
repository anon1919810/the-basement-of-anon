"""冒烟测试：断言 /api/health 与 /api/news。

- /api/news 会真实调用一次 DeepSeek（极小成本）；即使失败也必须有模板兜底返回。
- 退出码 0 表示全部通过。
运行：cd stock_game/backend && C:\\Users\\杨睿\\Desktop\\pdf_extractor\\.venv\\Scripts\\python.exe _smoke.py
"""
import sys

from fastapi.testclient import TestClient

from app.main import app


def main() -> int:
    client = TestClient(app)

    # 1) 健康检查
    r = client.get("/api/health")
    assert r.status_code == 200, f"health status {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("ok") is True, body
    assert body.get("app") == "覆巢之下", body
    assert body.get("version") == "0.0.0", body
    print("[smoke] GET /api/health ->", body)

    # 2) 新闻接口（真实调用一次 DeepSeek，失败也必须返回模板）
    r2 = client.post("/api/news", json={"day": 1, "market": "测试：星辰科技走强，能源板块回调"})
    assert r2.status_code == 200, f"news status {r2.status_code}: {r2.text}"
    data = r2.json()
    news = data.get("news") or []
    assert news, data
    for n in news:
        assert n.get("title"), n
        assert n.get("impact_stock"), n
        assert n.get("impact_range"), n
    print(f"[smoke] POST /api/news -> {len(news)} 条新闻")
    for n in news[:3]:
        print(f"    - {n['title']}  [{n['impact_stock']} {n['impact_range']} 持续{n['duration']}天]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[smoke] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
