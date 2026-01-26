FROM python:3.12-slim

# Build arguments for multi-platform support
ARG TARGETPLATFORM
ARG TARGETARCH

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
    osmium-tool \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (static binary - much faster than apt)
# Uses TARGETARCH from buildx for proper multi-platform support
RUN set -eux; \
    case "${TARGETARCH:-$(uname -m)}" in \
        amd64|x86_64) DOC_ARCH='x86_64' ;; \
        arm64|aarch64) DOC_ARCH='aarch64' ;; \
        *) echo >&2 "error: unsupported architecture '${TARGETARCH}'"; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DOC_ARCH}/docker-26.1.4.tgz" \
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

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:${PORT:-8080}/api/status/health || exit 1

CMD ["sh", "-c", "gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers 1"]
