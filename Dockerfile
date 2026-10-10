# Update this digest through the weekly Dependabot PR, not on every code push.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

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


# Copy ONLY dependency files first for layer caching
COPY build-constraints.txt requirements.runtime.txt ./

# Install Python dependencies (cached unless runtime requirements or constraints change)
RUN python -m pip install --upgrade "pip>=25.3,<27" \
    && python -m pip install --no-cache-dir --build-constraint build-constraints.txt -r requirements.runtime.txt \
    && python -m pip check

# CI generates version.json before this copy; Git history stays out of the image.
COPY . ./

# Build the pinned navigation bundle into the image; browsers use our own origin.
RUN python scripts/build_swup_assets.py

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf -H "Host: www.everystreet.me" http://localhost:${PORT:-8080}/api/status/live || exit 1

CMD ["sh", "-c", "gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8080} --workers ${WEB_CONCURRENCY:-1}"]
