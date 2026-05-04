#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# package.sh — Build and package native-openclaw for distribution.
#
# Usage:
#   bash package.sh              # build + zip
#   bash package.sh --skip-build # zip only (dist must already exist)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_NAME="native-openclaw"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
OUT_ZIP="${PROJECT_NAME}-v${VERSION}.zip"

SKIP_BUILD=false
for arg in "$@"; do
  [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true
done

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  native-openclaw  packager  v${VERSION}      │"
echo "  └─────────────────────────────────────────┘"
echo ""

# ── 1. Build TypeScript ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "  [1/4] Building TypeScript…"
  npm run build
  echo "        ✓ dist/ generated"
else
  echo "  [1/4] Skipping build (--skip-build)"
fi

# ── 2. Verify dist/ exists ────────────────────────────────────────────────────
if [[ ! -d "dist" ]]; then
  echo "  ERROR: dist/ directory not found. Run 'npm run build' first." >&2
  exit 1
fi

# ── 3. Clean previous zip ─────────────────────────────────────────────────────
echo "  [2/4] Cleaning previous archives…"
rm -f "${PROJECT_NAME}"-*.zip
echo "        ✓ done"

# ── 4. Create zip ────────────────────────────────────────────────────────────
echo "  [3/4] Creating ${OUT_ZIP}…"

zip -r "${OUT_ZIP}" \
  dist/ \
  src/ \
  skills/ \
  package.json \
  package-lock.json \
  tsconfig.json \
  Dockerfile \
  docker-compose.yml \
  .env.example \
  README.md \
  .gitignore \
  --exclude '*.test.ts' \
  --exclude '*.spec.ts' \
  --exclude 'dist/*.map' \
  2>/dev/null

echo "        ✓ ${OUT_ZIP} created"

# ── 5. Summary ───────────────────────────────────────────────────────────────
SIZE=$(du -sh "${OUT_ZIP}" | cut -f1)
echo "  [4/4] Done."
echo ""
echo "  Archive : ${OUT_ZIP}"
echo "  Size    : ${SIZE}"
echo ""
echo "  Install:"
echo "    unzip ${OUT_ZIP} -d ${PROJECT_NAME}"
echo "    cd ${PROJECT_NAME}"
echo "    cp .env.example .env && \$EDITOR .env"
echo "    npm start"
echo ""
