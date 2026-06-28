#!/usr/bin/env bash
set -euo pipefail

# ─── Eclipse Load-Balanced Addon — Multi-Platform Backend Deploy ───────────────
# Usage:
#   ./scripts/deploy_backend.sh cf        # Cloudflare Workers
#   ./scripts/deploy_backend.sh vercel    # Vercel
#   ./scripts/deploy_backend.sh deno      # Deno Deploy
#   ./scripts/deploy_backend.sh fly       # Fly.io (Docker)
#   ./scripts/deploy_backend.sh render    # Render (Docker)
#   ./scripts/deploy_backend.sh node     # Local Node.js

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$REPO_DIR/backend"
PLATFORM="${1:-cf}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Eclipse LB Addon — Backend Deploy ($PLATFORM)"
echo "═══════════════════════════════════════════════════════════════"

cd "$BACKEND_DIR"

case "$PLATFORM" in
  cf)
    echo "→ Deploying to Cloudflare Workers..."
    npm install
    npx wrangler deploy
    echo ""
    echo "✓ Deployed. URL: https://eclipse-backend.<your-subdomain>.workers.dev"
    echo "  Set keys: npx wrangler secret put HIFI_INSTANCES"
    ;;

  vercel)
    echo "→ Deploying to Vercel..."
    npm install
    npx vercel --prod
    echo ""
    echo "✓ Deployed. Check Vercel dashboard for URL."
    echo "  Set keys: vercel env add HIFI_INSTANCES"
    ;;

  deno)
    echo "→ Deploying to Deno Deploy..."
    echo "  Link repo at https://dash.deno.com — set deno.ts as entrypoint"
    echo "  Or deploy via CLI:"
    echo "    deno deploy --allow-net --allow-env deno.ts"
    echo ""
    echo "  Set keys in Deno Deploy dashboard: Project → Settings → Environment Variables"
    ;;

  fly)
    echo "→ Deploying to Fly.io..."
    if ! command -v flyctl &> /dev/null; then
      echo "  Installing flyctl..."
      curl -L https://fly.io/install.sh | sh
      export PATH="$HOME/.fly/bin:$PATH"
    fi
    npm install
    flyctl deploy
    echo ""
    echo "✓ Deployed. Check fly.toml for app name."
    echo "  Set keys: flyctl secrets set HIFI_INSTANCES=..."
    ;;

  render)
    echo "→ Deploying to Render..."
    echo "  Option A (Blueprint): connect repo at https://dashboard.render.com"
    echo "    → New → Blueprint → select this repo → render.yaml detected"
    echo ""
    echo "  Option B (Manual): create Web Service, connect repo"
    echo "    Build: npm install"
    echo "    Start: node node-server.js"
    echo ""
    echo "  Set keys in Render dashboard → Environment tab"
    ;;

  node)
    echo "→ Starting local Node.js server..."
    npm install
    node node-server.js
    ;;

  *)
    echo "Unknown platform: $PLATFORM"
    echo "Usage: $0 {cf|vercel|deno|fly|render|node}"
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  After deploy, register your backend:"
echo "  gh workflow run register.yml -f url=https://YOUR-BACKEND-URL"
echo "═══════════════════════════════════════════════════════════════"
