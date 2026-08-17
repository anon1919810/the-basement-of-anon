"""《覆巢之下》后端服务：健康检查 + AI 新闻生成（DeepSeek，任何异常自动兜底内置模板）。

运行：cd stock_game/backend && python -m uvicorn app.main:app --port 8000
"""
from __future__ import annotations

import json
import os
import random
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

APP_NAME = "覆巢之下"
APP_VERSION = "0.0.0"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"
DEEPSEEK_TIMEOUT = 20

# 仓库根目录的 .env：stock_game/backend/app/main.py 上溯 4 级
ENV_PATH = Path(__file__).resolve().parent.parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

# 内置模板新闻（后端兜底 / 纯离线可用）
TEMPLATE_NEWS = [
    {
        "title": "行业景气度回升，科技板块走强",
        "summary": "下游需求回暖叠加政策支持，机构上调科技板块盈利预期，资金加速流入。",
        "impact_stock": "科技",
        "impact_range": "+4%~+7%",
        "duration": 2,
        "sector": "科技",
    },
    {
        "title": "消费复苏加速，食品饮料迎旺季",
        "summary": "社零数据超预期，消费板块景气度上行，龙头公司订单饱满。",
        "impact_stock": "FOOD",
        "impact_range": "+3%~+6%",
        "duration": 2,
        "sector": "消费",
    },
    {
        "title": "国际油价波动，能源板块承压",
        "summary": "供给端扰动缓解，原油价格短期回落，能源股短期承压。",
        "impact_stock": "ENE",
        "impact_range": "-5%~-2%",
        "duration": 2,
        "sector": "能源",
    },
    {
        "title": "新药获批，医药板块迎来利好",
        "summary": "重磅新药临床数据亮眼，市场情绪高涨，医药估值有望修复。",
        "impact_stock": "MED",
        "impact_range": "+6%~+9%",
        "duration": 2,
        "sector": "医药",
    },
    {
        "title": "央行释放流动性，金融板块回暖",
        "summary": "货币政策边际宽松，银行股估值修复行情启动。",
        "impact_stock": "BANK",
        "impact_range": "+3%~+5%",
        "duration": 3,
        "sector": "金融",
    },
    {
        "title": "钢铁限产落地，原材料供给收缩",
        "summary": "行业减产预期强化，原材料价格获得支撑，周期板块活跃。",
        "impact_stock": "IRON",
        "impact_range": "+4%~+8%",
        "duration": 2,
        "sector": "原材料",
    },
    {
        "title": "区域供水提价，公用事业稳健",
        "summary": "公用事业防御属性凸显，低波动资金持续流入。",
        "impact_stock": "WAT",
        "impact_range": "+2%~+4%",
        "duration": 3,
        "sector": "公用事业",
    },
    {
        "title": "海外科技股回调，风险偏好下降",
        "summary": "海外市场波动加剧，成长板块短期承压，注意控制仓位。",
        "impact_stock": "科技",
        "impact_range": "-4%~-1%",
        "duration": 2,
        "sector": "科技",
    },
    {
        "title": "大宗商品反弹，周期股全线走强",
        "summary": "美元走弱提振大宗商品，周期板块迎来反弹窗口。",
        "impact_stock": "ALL",
        "impact_range": "+2%~+5%",
        "duration": 2,
    },
    {
        "title": "市场情绪谨慎，大盘缩量调整",
        "summary": "成交萎缩、资金观望情绪浓，短线操作宜谨慎。",
        "impact_stock": "ALL",
        "impact_range": "-2%~0%",
        "duration": 1,
    },
]

app = FastAPI(title=APP_NAME, version=APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NewsRequest(BaseModel):
    day: int = 1
    market: str = ""


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "app": APP_NAME, "version": APP_VERSION}


def _builtin_news(count: int = 3) -> list[dict]:
    items = random.sample(TEMPLATE_NEWS, k=min(count, len(TEMPLATE_NEWS)))
    return [{k: v for k, v in item.items()} for item in items]


def _clean_news(raw: object) -> list[dict]:
    """把 DeepSeek 返回的内容清洗成标准新闻字段，任何异常直接抛出让上层兜底。"""
    if not isinstance(raw, dict):
        raise ValueError("news response is not an object")
    items = raw.get("news")
    if not isinstance(items, list) or not items:
        raise ValueError("news list empty")
    cleaned: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()[:60]
        summary = str(it.get("summary") or "").strip()[:200]
        impact_stock = str(it.get("impact_stock") or "").strip().upper()
        impact_range = str(it.get("impact_range") or "").strip()[:16]
        try:
            duration = max(1, min(5, int(it.get("duration") or 1)))
        except (TypeError, ValueError):
            duration = 1
        if not title or not impact_stock or not impact_range:
            continue
        item = {
            "title": title,
            "summary": summary,
            "impact_stock": impact_stock,
            "impact_range": impact_range,
            "duration": duration,
        }
        sector = it.get("sector")
        if sector:
            item["sector"] = str(sector).strip()[:16]
        cleaned.append(item)
    if not cleaned:
        raise ValueError("no valid news items")
    return cleaned


def _call_deepseek(day: int, market: str) -> list[dict]:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY not set")
    system = (
        "你是《覆巢之下》股市模拟游戏的新闻编辑。请根据给定市场概况生成 1-3 条符合中文财经新闻风格的短新闻。\n"
        "严格只输出一个 JSON 对象（不要 markdown、不要任何解释文字）：\n"
        '{"news":[{"title":"标题","summary":"一句话摘要","impact_stock":"代码","impact_range":"+5%~+8%","duration":2}]}\n'
        "规则：impact_stock 必须是股票代码 STK/CLD/FOOD/ENE/MED/BANK/IRON/WAT 之一，或行业名"
        " 科技/消费/能源/医药/金融/原材料/公用事业 之一，或 ALL（全市场）；"
        "impact_range 是涨跌幅百分比区间字符串（利好用 + 开头如 +5%~+8%，利空用 - 开头如 -4%~-2%）；"
        "duration 是影响持续交易日数，取值 1-3；impact_stock 为个股代码时影响更大。"
    )
    user = f"当前是第 {day} 个交易日。市场概况：{market}"
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.8,
        "max_tokens": 900,
        "response_format": {"type": "json_object"},
    }
    resp = requests.post(
        DEEPSEEK_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=DEEPSEEK_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    obj = json.loads(content)
    return _clean_news(obj)


@app.post("/api/news")
def gen_news(req: NewsRequest) -> dict:
    try:
        news = _call_deepseek(req.day, req.market)
    except Exception:
        # 无 Key / 网络错误 / 解析失败……一律用内置模板兜底，保证永远能响应
        news = _builtin_news(3)
    return {"news": news}
