# 撷菁轩后端 · 仓库根 Dockerfile
# 用途：给"只从仓库根目录找 Dockerfile"的平台用（如 Koyeb 默认构建）。
# 内容与 backend/Dockerfile 保持一致，改动时两边同步。
FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
