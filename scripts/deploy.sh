#!/usr/bin/env bash
# Build the site and push dist/ to the gh-pages branch.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=$(git remote get-url origin)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "Building…"
npm run build

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -r dist/. "$TMP"/

echo "Publishing to gh-pages…"
cd "$TMP"
git init -q
git checkout -q -b gh-pages
git add -A
git commit -qm "deploy: ${BRANCH} $(date -u +%Y-%m-%dT%H:%MZ)"
git remote add origin "$REMOTE"
git push -qf origin gh-pages

echo "Done: https://mode777.github.io/normalmapped-terrain/"
