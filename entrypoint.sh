#!/bin/sh
# Fix bind-mount permissions untuk self-healing agar bisa write ke /app/src
# Ini diperlukan karena ./src, ./test, dll di-mount dari host dengan host UID
chown -R openclaw:openclaw \
  /app/src \
  /app/test \
  /app/tools \
  /app/scripts \
  /app/docs \
  /app/package.json \
  /app/package-lock.json \
  /app/tsconfig.json \
  2>/dev/null || true

# Repair npm cache ownership defensively. This handles older image layers and
# bind-mounted home directories that may contain root-owned npm cache files.
mkdir -p /home/openclaw/.npm/_logs
chown -R openclaw:openclaw /home/openclaw/.npm 2>/dev/null || true

# Drop ke openclaw dan jalankan app
exec su-exec openclaw node --enable-source-maps dist/index.js
