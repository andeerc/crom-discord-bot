#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-crom-discord-bot}"

if ! podman container exists "$CONTAINER_NAME"; then
  echo "Container not found: $CONTAINER_NAME"
  exit 0
fi

podman stop "$CONTAINER_NAME" >/dev/null || true
podman rm "$CONTAINER_NAME" >/dev/null

echo "Container removed: $CONTAINER_NAME"
