#!/usr/bin/env bash
#
# Deploy the Event Automation web app WITHOUT breaking the bookmarked URL.
#
# The bookmarked /exec URL is tied to a fixed *deployment ID*. Running
# `clasp deploy` would mint a NEW deployment ID and break the bookmark, so this
# script instead pushes the code, cuts a new immutable version, and *redeploys*
# the existing deployment to that version.
#
# Bookmarked URL (do not change the deployment ID below without updating it):
#   https://script.google.com/a/macros/atxveg.org/s/AKfycbx_zs0uCLGSxxB3btHhF3ehvdM_3CL2BHK_P0SuCYyRh2FJ61dv21snaSwisHDCb7Fe/exec
#
# Usage:
#   ./deploy.sh ["deploy description"]
#
set -euo pipefail

DEPLOYMENT_ID="AKfycbx_zs0uCLGSxxB3btHhF3ehvdM_3CL2BHK_P0SuCYyRh2FJ61dv21snaSwisHDCb7Fe"
DESC="${1:-Deploy $(date '+%Y-%m-%d %H:%M')}"

cd "$(dirname "$0")"

echo "→ Pushing src/ to Apps Script..."
clasp push -f

echo "→ Creating immutable version..."
VERSION_OUTPUT="$(clasp create-version "$DESC")"
echo "  $VERSION_OUTPUT"
VERSION="$(printf '%s' "$VERSION_OUTPUT" | grep -oE '[0-9]+' | tail -1)"
if [ -z "${VERSION:-}" ]; then
  echo "ERROR: could not parse a version number from create-version output." >&2
  exit 1
fi

echo "→ Redeploying $DEPLOYMENT_ID to version $VERSION..."
clasp redeploy "$DEPLOYMENT_ID" -V "$VERSION" -d "$DESC"

echo
echo "✓ Live (bookmarked URL unchanged):"
echo "  https://script.google.com/a/macros/atxveg.org/s/$DEPLOYMENT_ID/exec"
