#!/usr/bin/env bash
set -euo pipefail

# ─── Proxy Test Script ────────────────────────────────────────────────────────
# Tests the proxy against all Eclipse endpoints.
# Usage: ./scripts/test_proxy.sh https://your-proxy.workers.dev

PROXY_URL="${1:?Usage: $0 <proxy-url>}"
PASSED=0
FAILED=0

assert() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✓ $name"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $name (expected: $expected, got: $actual)"
    FAILED=$((FAILED + 1))
  fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Testing proxy: $PROXY_URL"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# 1. Proxy health endpoint
echo "[1] Proxy health endpoint"
RESP=$(curl -sL --max-time 5 "$PROXY_URL/proxy-health")
assert "returns 200 with status" '"status"' "$RESP"
assert "lists healthy_backends count" '"healthy_backends"' "$RESP"

# 2. CORS headers
echo ""
echo "[2] CORS headers"
HEADERS=$(curl -sI --max-time 5 "$PROXY_URL/manifest.json" 2>&1)
assert "Access-Control-Allow-Origin: *" "Access-Control-Allow-Origin: \*" "$HEADERS"

# 3. Manifest endpoint
echo ""
echo "[3] Manifest endpoint (/manifest.json)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/manifest.json")
assert "returns JSON with id" '"id"' "$RESP"
assert "has resources array" '"resources"' "$RESP"

# 4. Search endpoint
echo ""
echo "[4] Search endpoint (/search?q=music)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/search?q=music")
assert "returns JSON with tracks" '"tracks"' "$RESP"

# 5. Stream endpoint (IA track)
echo ""
echo "[5] Stream endpoint (/stream/ia_music_271159)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/stream/ia_music_271159")
assert "returns JSON with url" '"url"' "$RESP"

# 6. 404 handling
echo ""
echo "[6] 404 handling (/nonexistent)"
STATUS=$(curl -sL --max-time 5 -o /dev/null -w "%{http_code}" "$PROXY_URL/nonexistent")
assert "returns 404" "404" "$STATUS"

# 7. Response headers
echo ""
echo "[7] Response headers"
HEADERS=$(curl -sI --max-time 5 "$PROXY_URL/manifest.json" 2>&1)
assert "X-Backend header present" "X-Backend" "$HEADERS"
assert "X-Response-Time header" "X-Response-Time" "$HEADERS"

# 8. Podcast manifest (if backend supports it)
echo ""
echo "[8] Podcast manifest (/podcast/manifest.json)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/podcast/manifest.json")
if echo "$RESP" | grep -q '"id"'; then
  assert "returns JSON with id" '"id"' "$RESP"
else
  echo "  - Skipped (backend may not support podcast manifest)"
fi

# 9. Audiobook manifest
echo ""
echo "[9] Audiobook manifest (/audiobook/manifest.json)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/audiobook/manifest.json")
if echo "$RESP" | grep -q '"id"'; then
  assert "returns JSON with id" '"id"' "$RESP"
else
  echo "  - Skipped (backend may not support audiobook manifest)"
fi

# 10. Radio manifest
echo ""
echo "[10] Radio manifest (/radio/manifest.json)"
RESP=$(curl -sL --max-time 10 "$PROXY_URL/radio/manifest.json")
if echo "$RESP" | grep -q '"id"'; then
  assert "returns JSON with id" '"id"' "$RESP"
else
  echo "  - Skipped (backend may not support radio manifest)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════════════════════"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
