# Build context: repository root
FROM python:3.12-slim

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY scientific-engine /srv/scientific-engine
RUN pip install --no-cache-dir /srv/scientific-engine

COPY backend/requirements.txt /srv/backend/requirements.txt
RUN pip install --no-cache-dir -r /srv/backend/requirements.txt

COPY backend /srv/backend
WORKDIR /srv/backend

EXPOSE 8000
# Cloud hosts (Render, Railway, Fly) pass the port in $PORT; default 8000 locally
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
