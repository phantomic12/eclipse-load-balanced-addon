# Eclipse Load-Balanced Addon

All-in-one Eclipse Music addon with multi-platform load balancing architecture.

## What This Is

An Eclipse Music addon that aggregates multiple music sources (TIDAL HiFi, SoundCloud, Internet Archive, podcasts, audiobooks, radio) behind a load-balanced proxy. The proxy distributes traffic across identical backend instances deployed on multiple free serverless platforms (Cloudflare Workers, Vercel, Deno Deploy). GitHub Actions monitors backend health and removes dead instances from the active pool automatically.

## Architecture Overview

```
Eclipse app
  → CF Workers proxy (account 1, read-only)
    → fetches healthy-backends.json from raw.githubusercontent.com (60s cache)
    → picks random healthy backend
    → proxies request (2 retries, 2s timeout each)
    → all backends fail → 503

Backend instances (identical improved-all-in-one codebase):
  → CF Workers account 2
  → CF Workers account 3
  → Vercel
  → Deno Deploy
  → (add more freely)
  Each: API keys in env vars, no shared cache, independent

GitHub repo (single account, ~850 GHA min/month):
  ├── backends.json (all registered URLs, written by registration workflow)
  ├── healthy-backends.json (passing health checks, written by health check workflow)
  ├── .github/workflows/
  │   ├── manifest-ping.yml (every 10 min)
  │   ├── search-check.yml (every 2 hours, query "music")
  │   ├── stream-check.yml (daily, hardcoded IA ID + search-then-stream)
  │   ├── register.yml (workflow_dispatch, triggered on deploy)
  │   └── upptime.yml (generates dashboard)
  └── docs/ → GitHub Pages (Upptime status page on .github.io)
```

## Documents

- [Architecture](docs/ARCHITECTURE.md) — Full system design, data flow, component responsibilities
- [Decisions](docs/DECISIONS.md) — Decision log from the grilling session (23 questions resolved)
- [Roadmap](docs/ROADMAP.md) — Implementation phases
- [Open Questions](docs/OPEN-QUESTIONS.md) — Remaining unknowns to resolve during implementation

## v1 Provider Set

TIDAL HiFi, SoundCloud, Internet Archive, Podcast Index, Taddy, Apple Podcasts, LibriVox, Radio Browser.

## Source Codebase

Based on [jacobyz211/improved-all-in-one](https://github.com/jacobyz211/improved-all-in-one) — a Hono-based Eclipse addon running on Cloudflare Workers.

## License

MIT
