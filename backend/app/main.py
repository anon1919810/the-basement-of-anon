"""FastAPI 应用入口（T1 骨架 → T2：接入配置常量与 Supabase 数据层）。

现状：/api/health（含真实数据库连通性自检）+ CORS + 环境变量加载 + 日志。
后续 ticket 依次挂载：auth / extract / chat / rating / stats / admin 路由。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, env
from .logger import get_logger
from .routers import auth, chat, extract

logger = get_logger("main")

app = FastAPI(
    title=f"{config.APP_NAME} API",
    version=config.VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.include_router(auth.router)
app.include_router(extract.router)
app.include_router(chat.router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=env.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"app": config.APP_NAME, "version": config.VERSION, "docs": "/api/docs"}


@app.get("/api/health")
def health():
    """健康检查：服务本身 + 数据库连通性（UptimeRobot 每10分钟ping此接口）。"""
    try:
        from .database import init_db
        db_ok, db_msg = init_db()
    except Exception as e:  # 任何异常都不应让健康检查崩溃
        db_ok, db_msg = False, f"db init error: {e}"
    return {
        "ok": True,
        "app": config.APP_NAME,
        "version": config.VERSION,
        "tag": config.VERSION_TAG,
        "db": "ok" if db_ok else db_msg,
        "session_configured": bool(env.SESSION_SECRET),
        "deepseek_configured": bool(env.DEEPSEEK_API_KEY),
    }


logger.info(f"{config.APP_NAME} v{config.VERSION} {config.VERSION_TAG} 启动（T2：配置/数据层就绪）")
