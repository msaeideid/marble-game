# Build from the REPO ROOT (the server needs shared/ for heroes, abilities and levels):
#   docker build -f server/Dockerfile -t vanguard-server .
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /srv/server
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --no-dev --frozen
COPY server/app ./app
COPY shared /srv/shared
ENV VANGUARD_SHARED=/srv/shared
EXPOSE 8000
CMD ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
