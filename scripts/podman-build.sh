#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-localhost/crom-discord-bot:latest}"

cd "$PROJECT_ROOT"

echo "Building image: $IMAGE_NAME"
podman build -t "$IMAGE_NAME" -f Containerfile .

echo "Build complete: $IMAGE_NAME"
