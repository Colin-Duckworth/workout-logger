#!/usr/bin/env bash
# Release the app: bump the service-worker version (so phones fetch the new files), commit, and push.
# GitHub Pages redeploys automatically.
set -euo pipefail
cd "$(dirname "$0")"

message="${1:-Update app}"
version="$(date +%Y%m%d-%H%M%S)"

sed -i "s/^const VERSION = '.*';/const VERSION = '${version}';/" sw.js
sed -i "s/^const APP_VERSION = '.*';/const APP_VERSION = '${version}';/" app.js
git add -A
git commit -m "${message}"
git push

echo "Released ${version}. Pages updates in about a minute; reopen the app to get it."
