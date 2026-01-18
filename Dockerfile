FROM python:3.12
ENV PYTHONUNBUFFERED=1
ENV UVICORN_CMD_ARGS="--proxy-headers --forwarded-allow-ips=*"
RUN apt-get update && apt-get install -y \
    libexpat1 \
    libexpat1-dev \
    git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . ./
# Generate version.json with git info at build time
RUN echo "{\"commit_count\": \"$(git rev-list --count HEAD 2>/dev/null || echo Unknown)\", \
\"commit_hash\": \"$(git rev-parse --short HEAD 2>/dev/null || echo Unknown)\", \
\"last_updated\": \"$(git log -1 --format=%cI 2>/dev/null || echo Unknown)\"}" > version.json
RUN pip install -r requirements.txt
CMD ["sh", "-c", "gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers 1"]