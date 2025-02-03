FROM python:3.12

ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    libexpat1 \
    libexpat1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN pip install -r requirements.txt

COPY . ./

CMD exec uvicorn app:app --host 0.0.0.0 --port "$PORT"
