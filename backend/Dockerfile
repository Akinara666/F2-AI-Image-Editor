FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-ci.txt ./requirements-ci.txt
COPY requirements.txt ./requirements.txt
COPY requirements-optional.txt ./requirements-optional.txt

RUN pip install --upgrade pip \
    && pip install -r requirements-ci.txt

ARG INSTALL_AI_RUNTIME=false
ARG INSTALL_OPTIONAL_RUNTIME=false
# Оставь пустым для CPU-сборки (torch с обычного PyPI).
# Для GPU-хоста передай CUDA-индекс, например: https://download.pytorch.org/whl/cu121
# cu-колёса torch self-contained (cudart/cudnn/cublas внутри); хосту нужен только
# NVIDIA-драйвер + nvidia-container-toolkit. Ставим torch первым, чтобы requirements.txt
# увидел его уже удовлетворённым и не подтянул CPU-сборку поверх.
ARG TORCH_INDEX_URL=""

RUN if [ "$INSTALL_AI_RUNTIME" = "true" ] && [ -n "$TORCH_INDEX_URL" ]; then \
        pip install torch --index-url "$TORCH_INDEX_URL"; \
    fi
RUN if [ "$INSTALL_AI_RUNTIME" = "true" ]; then pip install -r requirements.txt; fi
RUN if [ "$INSTALL_OPTIONAL_RUNTIME" = "true" ]; then pip install -r requirements-optional.txt; fi

COPY . .

RUN mkdir -p /app/static/outputs /app/models/Stable-diffusion /app/models/llm

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
