#!/bin/sh
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
DATA_DIR="${DATA_DIR:-/data}"
BACKUPS_DIR="${BACKUPS_DIR:-/backups}"

umask "$UMASK"

mkdir -p "$DATA_DIR" "$BACKUPS_DIR"

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" keelgroup
  fi
  GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"

  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -D -H -u "$PUID" -G "$GROUP_NAME" keeluser
  fi
  USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"

  chown -R "$PUID:$PGID" "$DATA_DIR" "$BACKUPS_DIR" /app
  exec su-exec "$USER_NAME:$GROUP_NAME" "$@"
fi

exec "$@"
