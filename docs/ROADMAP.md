# Roadmap

## Phase 1 — Proxy + Health Check Infrastructure

Build and deploy the load balancing layer.

- [ ] Write CF Workers proxy (Hono)
  - [ ] Fetch `healthy-backends.json` from `raw.githubusercontent.com` with 60s cache
  - [ ] Random backend selection
  - [ ] Proxy request with 2 retries, 2s timeout each
  - [ ] Return 503 when all backends down
  - [ ] Preserve request path + query string
  - [ ] Pass through response headers + body
- [ ] Create GitHub repo structure
  - [ ] `backends.json` (empty array initially)
  - [ ] `healthy-backends.json` (empty array initially)
- [ ] Write GHA workflows
  - [ ] `manifest-ping.yml` (every 10 min)
  - [ ] `search-check.yml` (every 2 hours)
  - [ ] `stream-check.yml` (daily, hardcoded IA ID + search-then-stream)
  - [ ] `register.yml` (workflow_dispatch)
  - [ ] `upptime.yml` (dashboard generation)
- [ ] Deploy proxy to CF Workers (account 1)
- [ ] Find stable Internet Archive track ID for stream check
- [ ] Set up GitHub Pages for Upptime dashboard

## Phase 2 — First Backend Deployment

Get one backend instance live and routed through the proxy.

- [ ] Fork/clone `jacobyz211/improved-all-in-one`
- [ ] Remove token requirement (use env vars for API keys)
- [ ] Deploy to CF Workers (account 2)
- [ ] Configure API keys via `wrangler secret`
- [ ] Register backend: `gh workflow run register.yml -f url=https://backend2.workers.dev`
- [ ] Verify health checks pass (manifest, search, stream)
- [ ] Verify proxy routes to the backend
- [ ] Install in Eclipse: `https://proxy.workers.dev/manifest.json`
- [ ] End-to-end test: search, stream, album browse, artist browse

## Phase 3 — Multi-Platform Expansion

Deploy across all platforms for redundancy.

- [ ] Deploy to CF Workers (account 3) — separate 100k/day quota
- [ ] Deploy to Vercel — adapt Hono app to Vercel serverless function
- [ ] Deploy to Deno Deploy — adapt Hono app to Deno Deploy
- [ ] Register all backends via `register.yml`
- [ ] Verify health checks track all instances
- [ ] Verify Upptime dashboard shows all instances
- [ ] Test failover: take down one backend, verify proxy routes to others
- [ ] Test total failure: all backends down, verify 503

## Phase 4 — Harden + Document

Make it production-ready.

- [ ] Write deploy script (one command: deploy + register)
- [ ] Document API key setup per platform
- [ ] Add CORS headers in proxy (safety, even though Eclipse is native)
- [ ] Add request logging in proxy (optional, for debugging)
- [ ] Test with real Eclipse usage patterns
- [ ] Write user-facing README for installing the addon
- [ ] Set up custom domain for proxy (optional, via CF DNS)

## Phase 5 — Scale + Optimize (future)

- [ ] Add more platforms (Render, Netlify, Fly.io)
- [ ] Weighted backend selection (faster backends get more traffic)
- [ ] Geographic routing (route to nearest backend)
- [ ] Proxy redundancy (secondary proxy on Deno Deploy)
- [ ] Rate limit handling (detect provider rate limits, temporarily reduce traffic)
