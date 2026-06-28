# Eclipse Load-Balanced Addon

All-in-one Eclipse Music addon with multi-platform load balancing architecture.

## What This Is

An Eclipse Music addon that aggregates multiple music sources (TIDAL HiFi, SoundCloud, Deezer, Qobuz, Internet Archive, podcasts, audiobooks, radio) behind a load-balanced proxy. The proxy distributes traffic across identical backend instances deployed on multiple free serverless platforms. GitHub Actions monitors backend health and removes dead instances from the active pool automatically.

## Deploy a Backend

Pick a platform, click the button, follow the prompts. After deploy, register your backend URL:

```
gh workflow run register.yml -f url=https://YOUR-BACKEND-URL
```

### Cloudflare Workers

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/phantomic12/eclipse-load-balanced-addon)

Or via CLI:
```bash
cd backend && npm install && npx wrangler deploy
```

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/phantomic12/eclipse-load-balanced-addon&root-directory=backend)

Or via CLI:
```bash
cd backend && npm install && npx vercel --prod
```

### Deno Deploy

[![Deploy to Deno Deploy](https://img.shields.io/badge/Deno-Deploy-black?logo=deno)](https://dash.deno.com/new)

1. Fork this repo
2. Create new project at [dash.deno.com](https://dash.deno.com/new)
3. Link your GitHub fork
4. Set entrypoint to `backend/deno.ts`
5. Add environment variables for API keys

### Fly.io

[![Deploy on Fly.io](https://img.shields.io/badge/Fly.io-Deploy-blue?logo=fly.io)](https://fly.io/launch)

```bash
cd backend && flyctl deploy
```

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/phantomic12/eclipse-load-balanced-addon)

Blueprint auto-detected via `backend/render.yaml`.

### Local (Node.js)

```bash
cd backend && npm install && node node-server.js
```

## Deploy the Proxy

The proxy is the entry point Eclipse connects to. Deploy it once:

```bash
cd proxy && npm install && npx wrangler deploy
```

Your Eclipse addon URL: `https://eclipse-lb-proxy.<your-subdomain>.workers.dev/manifest.json`

## Architecture Overview

```
Eclipse app
  → CF Workers proxy (account 1, read-only)
    → fetches healthy-backends.json from raw.githubusercontent.com (60s cache)
    → picks random healthy backend
    → proxies request (2 retries, 2s timeout each)
    → all backends fail → 503

Backend instances (identical codebase, multi-platform):
  → CF Workers (multiple accounts for separate quotas)
  → Vercel
  → Deno Deploy
  → Fly.io
  → Render
  → (add more freely)
  Each: API keys in env vars, no shared cache, independent

GitHub repo (single account, ~850 GHA min/month):
  ├── backends.json (all registered URLs)
  ├── healthy-backends.json (passing health checks)
  ├── .github/workflows/
  │   ├── manifest-ping.yml (every 10 min)
  │   ├── search-check.yml (every 2 hours, query "music")
  │   ├── stream-check.yml (daily, hardcoded IA ID + search-then-stream)
  │   ├── register.yml (workflow_dispatch, triggered on deploy)
  │   └── upptime.yml (generates dashboard)
  └── status dashboard → GitHub Pages
```

## Install in Eclipse Music

1. Deploy the proxy (see above)
2. Deploy at least one backend and register it
3. Open Eclipse Music on your iPhone/iPad
4. Go to **Settings** → **Connections** → **Add Connection** → **Addon**
5. Paste your proxy URL: `https://eclipse-lb-proxy.<your-subdomain>.workers.dev/manifest.json`
6. Tap **Install**

Your addon appears in the search dropdown. Eclipse routes all searches and playback through the proxy, which load-balances across your backend instances.

## Custom Domain (Optional)

See [Custom Domain Setup](docs/CUSTOM-DOMAIN.md) for pointing your own domain at the proxy.

## Testing

### Test the proxy
```bash
./scripts/test_proxy.sh https://your-proxy.workers.dev
```
Tests: proxy health, CORS headers, manifest, search, stream, 404 handling, response headers.

### Test health checks
```bash
python3 scripts/test_health_check.py
```
Unit tests with mock backends — verifies manifest, search, stream checks against healthy and broken backends.

## Documents

- [Setup Guide](docs/SETUP.md) — Deploy your first backend + register with the proxy
- [Architecture](docs/ARCHITECTURE.md) — Full system design, data flow, component responsibilities
- [Decisions](docs/DECISIONS.md) — Decision log from the grilling session (23 questions resolved)
- [Roadmap](docs/ROADMAP.md) — Implementation phases
- [Open Questions](docs/OPEN-QUESTIONS.md) — Remaining unknowns to resolve during implementation

## Provider Set

All providers from the [improved-all-in-one](https://github.com/jacobyz211/improved-all-in-one) codebase:

- TIDAL HiFi (lossless music)
- SoundCloud (music)
- Deezer (music)
- Qobuz (hi-res music)
- Internet Archive (music, audiobooks)
- Podcast Index (podcasts)
- Taddy (podcasts)
- Apple Podcasts (podcasts)
- LibriVox (audiobooks)
- Radio Browser (radio)
- MusicBrainz (ISRC metadata enrichment)

## Multi-Platform Deploy Script

```bash
./scripts/deploy_backend.sh cf        # Cloudflare Workers
./scripts/deploy_backend.sh vercel    # Vercel
./scripts/deploy_backend.sh deno      # Deno Deploy
./scripts/deploy_backend.sh fly       # Fly.io
./scripts/deploy_backend.sh render    # Render
./scripts/deploy_backend.sh node      # Local Node.js
```

## License

MIT
