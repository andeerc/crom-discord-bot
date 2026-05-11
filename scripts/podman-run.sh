#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-localhost/crom-discord-bot:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-crom-discord-bot}"
HOST_PORT="${HOST_PORT:-3000}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
DATA_DIR="${DATA_DIR:-$PROJECT_ROOT/data}"

mkdir -p "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if podman container exists "$CONTAINER_NAME"; then
  echo "Container already exists: $CONTAINER_NAME" >&2
  echo "Use scripts/podman-stop.sh first or change CONTAINER_NAME." >&2
  exit 1
fi

podman run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -e SQLITE_PATH=/app/data/summaries.sqlite \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "$DATA_DIR:/app/data:Z" \
  --restart unless-stopped \
  "$IMAGE_NAME"

echo "Container started: $CONTAINER_NAME"
echo "Image: $IMAGE_NAME"
echo "Port: http://127.0.0.1:${HOST_PORT}"
echo "Data: $DATA_DIR"
