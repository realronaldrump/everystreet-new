FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
ENV UVICORN_CMD_ARGS="--proxy-headers --forwarded-allow-ips=*"

# Install system dependencies (cached unless base image changes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libexpat1 \
    libexpat1-dev \
    git \
    curl \
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (static binary - much faster than apt)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-26.1.4.tgz \
    | tar xz -C /usr/local/bin --strip-components=1 docker/docker

WORKDIR /app

# Copy ONLY requirements first for layer caching
COPY requirements.txt ./

# Install Python dependencies (cached unless requirements.txt changes)
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . ./

# Generate version.json with git info at build time
RUN echo "{\"commit_count\": \"$(git rev-list --count HEAD 2>/dev/null || echo Unknown)\", \
\"commit_hash\": \"$(git rev-parse --short HEAD 2>/dev/null || echo Unknown)\", \
\"last_updated\": \"$(git log -1 --format=%cI 2>/dev/null || echo Unknown)\"}" > version.json

CMD ["sh", "-c", "gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers 1"]