"""FastAPI 应用入口（T1：骨架）。

现状：/api/health 健康检查 + CORS + 环境变量加载 + 日志。
后续 ticket 依次挂载：auth / extract / chat / rating / stats / admin 路由。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .logger import get_logger

logger = get_logger("main")

app = FastAPI(
    title=f"{config.APP_NAME} API",
    version=config.VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"app": config.APP_NAME, "version": config.VERSION, "docs": "/api/docs"}


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "app": config.APP_NAME,
        "version": config.VERSION,
        "tag": config.VERSION_TAG,
        # T2 接入 database.py 后改为真实连通性探测
        "db": "ok" if (config.SUPABASE_URL and config.SUPABASE_KEY) else "missing",
        "session_configured": bool(config.SESSION_SECRET),
        "deepseek_configured": bool(config.DEEPSEEK_API_KEY),
    }


logger.info(f"{config.APP_NAME} v{config.VERSION} {config.VERSION_TAG} 启动（T1 骨架）")
