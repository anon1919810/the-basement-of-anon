# 撷菁轩后端 · Koyeb / Render 通用镜像
# 用法：Koyeb 选 Docker builder，Build Context 填 backend/
FROM python:3.13-slim

WORKDIR /app

# 系统依赖：OCR 兜底（Tesseract 中文 + poppler；RapidOCR 走 pip，无需系统包）
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
