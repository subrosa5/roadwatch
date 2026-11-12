FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY collector/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY collector/collector.py .
RUN useradd -m worker && mkdir /data && chown worker /data
USER worker
CMD ["python", "collector.py", "--config", "/config/collector.json"]
