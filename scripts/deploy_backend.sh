#!/usr/bin/env bash
set -euo pipefail

# ─── Eclipse Load-Balanced Addon — Backend Deploy Script ───────────────────────
# Usage:
#   ./scripts/deploy_backend.sh
#
# Deploys the backend to Cloudflare Workers and registers it with the proxy.
# API keys are set via `wrangler secret put` (interactive) or can be set
# in backend/wrangler.toml [vars] section.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$REPO_DIR/backend"

echo "═══════════════════════════════════════════════════════════════"
echo "  Eclipse LB Addon — Backend Deploy"
echo "═══════════════════════════════════════════════════════════════"

# Check wrangler is installed
if ! command -v npx &> /dev/null; then
  echo "ERROR: npx not found. Install Node.js first."
  exit 1
fi

cd "$BACKEND_DIR"

echo ""
echo "→ Installing dependencies..."
npm install

echo ""
echo "→ Deploying to Cloudflare Workers..."
npx wrangler deploy

echo ""
echo "→ Backend deployed successfully!"
echo ""

# Get the deployed URL
WORKER_NAME=$(grep '^name = ' wrangler.toml | head -1 | sed 's/name = "//;s/"//')
ACCOUNT_SUBDOMAIN=""

echo "Your backend is live at: https://${WORKER_NAME}.<your-subdomain>.workers.dev"
echo "(Find the exact URL in the wrangler deploy output above)"
echo ""
echo "To register this backend with the proxy:"
echo "  gh workflow run register.yml -f url=https://${WORKER_NAME}.<your-subdomain>.workers.dev"
echo ""

# Optionally set secrets
echo "To set API keys (optional, enables additional providers):"
echo "  npx wrangler secret put HIFI_INSTANCES"
echo "  npx wrangler secret put SC_CLIENT_ID"
echo "  npx wrangler secret put PI_KEY"
echo "  npx wrangler secret put PI_SECRET"
echo "  npx wrangler secret put TADDY_KEY"
echo "  npx wrangler secret put TADDY_UID"
echo "  npx wrangler secret put DEEZER_ARL"
echo "  npx wrangler secret put QOBUZ_USER_TOKEN"
echo "  npx wrangler secret put QOBUZ_SECRET"
echo "  npx wrangler secret put QOBUZ_APP_ID"
echo ""
echo "Without keys, backend still works for SoundCloud, Internet Archive, Radio Browser."
