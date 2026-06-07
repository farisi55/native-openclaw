#!/bin/sh
# Fix bind-mount permissions untuk self-healing agar bisa write ke /app/src
# Ini diperlukan karena ./src, ./test, dll di-mount dari host dengan host UID
chown -R openclaw:openclaw /app/src /app/test /app/tools /app/scripts /app/docs 2>/dev/null || true

# Drop ke openclaw dan jalankan app
exec su-exec openclaw node --enable-source-maps dist/index.js