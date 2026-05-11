#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-crom-discord-bot}"

podman logs -f "$CONTAINER_NAME"
