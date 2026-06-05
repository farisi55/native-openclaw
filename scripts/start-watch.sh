#!/usr/bin/env sh
set -u

restart_code=42

while true; do
  node dist/index.js
  exit_code=$?

  if [ "$exit_code" -ne "$restart_code" ]; then
    exit "$exit_code"
  fi

  echo "smooth requested restart with exit code 42."
  echo "Restarting now..."
  sleep 1
done
