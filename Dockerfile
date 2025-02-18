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

CMD ["gunicorn", "app:app", "-k", "uvicorn.workers.UvicornWorker", "--bind", "0.0.0.0:8080", "--workers", "4"]