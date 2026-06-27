# Architecture

## System Diagram

```
┌──────────────┐
│  Eclipse App │  (iOS, stores one addon URL)
│  (URLSession) │
└──────┬───────┘
       │ HTTPS
       ▼
┌──────────────────────────────────────────┐
│  Proxy (CF Workers, account 1)           │
│  - Read-only, no registration logic      │
│  - Fetches healthy-backends.json from    │
│    raw.githubusercontent.com (60s cache)  │
│  - Picks random healthy backend          │
│  - Proxies request (2 retries, 2s each)  │
│  - All backends down → 503               │
└──────┬───────────────────────────────────┘
       │ fetch() + return response body
       ▼
┌──────────────────────────────────────────────────────────┐
│  Backend Pool (healthy-backends.json)                    │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │ CF Workers  │  │ CF Workers  │  │   Vercel    │      │
│  │  account 2  │  │  account 3  │  │             │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐                       │
│  │ Deno Deploy │  │  (add more) │                       │
│  └─────────────┘  └─────────────┘                       │
│                                                          │
│  Each backend:                                           │
│  - Identical improved-all-in-one codebase (Hono)         │
│  - API keys in platform env vars (no token in URL)       │
│  - Fully independent — no shared cache, no shared state  │
│  - Handles all Eclipse endpoints:                       │
│    /manifest.json, /search, /stream/{id},               │
│    /album/{id}, /artist/{id}, /playlist/{id}           │
└──────────────────────────────────────────────────────────┘

         ▲ Health checks read from backends.json
         │
┌────────┴─────────────────────────────────────────────────┐
│  GitHub Actions (single account, ~850 min/month)         │
│                                                          │
│  ┌──────────────────┐  every 10 min                      │
│  │ manifest-ping    │  → GET /manifest.json on all       │
│  │                  │    backends, update                │
│  │                  │    healthy-backends.json           │
│  └──────────────────┘                                    │
│                                                          │
│  ┌──────────────────┐  every 2 hours                      │
│  │ search-check     │  → GET /search?q=music,            │
│  │                  │    verify non-empty tracks         │
│  └──────────────────┘                                    │
│                                                          │
│  ┌──────────────────┐  daily                             │
│  │ stream-check     │  → GET /stream/{hardcoded_ia_id}   │
│  │                  │    + search-then-stream             │
│  │                  │    verify url field present        │
│  └──────────────────┘                                    │
│                                                          │
│  ┌──────────────────┐  workflow_dispatch (on deploy)     │
│  │ register         │  → health-check new backend,       │
│  │                  │    append to backends.json         │
│  │                  │    if healthy                      │
│  └──────────────────┘                                    │
│                                                          │
│  ┌──────────────────┐  on health check completion         │
│  │ upptime          │  → generate static status page     │
│  │                  │    push to gh-pages branch         │
│  └──────────────────┘                                    │
└──────────────────────────────────────────────────────────┘

         ▼ Writes to
┌──────────────────────────────────────────────────────────┐
│  GitHub Repo (single source of truth)                    │
│                                                          │
│  ├── backends.json          (all registered URLs)        │
│  ├── healthy-backends.json  (only passing health checks) │
│  └── gh-pages branch        (Upptime status dashboard)    │
└──────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Proxy (CF Workers, account 1)

The entry point. Eclipse points at this URL. Stateless, read-only, minimal compute.

**Per request:**
1. Fetch `healthy-backends.json` from `raw.githubusercontent.com` (cached 60s in memory)
2. Parse the JSON array of backend URLs
3. Pick one at random
4. `fetch(backendUrl + request.path + request.query, { headers: request.headers })`
5. If response is not 2xx or times out (2s), try next backend (max 2 retries)
6. Return response body + headers to Eclipse
7. If all backends fail → return 503

**Does NOT:**
- Store API keys
- Handle registration
- Write to any file or database
- Understand the Eclipse protocol (just forwards HTTP)
- Process audio (audio comes from provider CDNs directly via `/stream/{id}` JSON response)

**CPU time per request:** <1ms (picking backend + constructing fetch). Network I/O (backend response) doesn't count against CF Workers CPU limit.

**Subrequests per request:** 1-3 (backend fetch + possible retries). CF Workers free tier allows 50.

### Backend Instances (multiple platforms)

Identical deployments of the `improved-all-in-one` codebase. Each is a full Eclipse addon.

**Per instance:**
- Handles all Eclipse endpoints: `/manifest.json`, `/search`, `/stream/{id}`, `/album/{id}`, `/artist/{id}`, `/playlist/{id}`
- API keys stored in platform env vars (CF Workers secrets, Vercel env vars, Deno Deploy env)
- No token in URL — Eclipse URL is just the proxy URL
- Fully independent — no shared Redis, no shared KV, no shared session state
- Each instance re-resolves streams, re-fetches metadata, manages its own provider sessions
- Uses CF KV for ISRC cache (per-account) if on CF Workers; other platforms use in-memory or no cache

**v1 providers:**
1. TIDAL HiFi (music, high quality)
2. SoundCloud (music)
3. Internet Archive (music, audiobooks)
4. Podcast Index (podcasts)
5. Taddy (podcasts)
6. Apple Podcasts (podcasts)
7. LibriVox (audiobooks)
8. Radio Browser (radio)

### GitHub Actions Workflows

All workflows live in one repo on one GitHub account (~850 min/month, within 2,000 free tier).

#### manifest-ping.yml (every 10 min)
1. Read `backends.json` from repo
2. For each backend URL: `GET {url}/manifest.json`
3. Verify 200 + valid JSON with `id` field
4. Write `healthy-backends.json` with only passing URLs
5. Commit + push if changed

#### search-check.yml (every 2 hours)
1. Read `healthy-backends.json`
2. For each backend: `GET {url}/search?q=music`
3. Verify non-empty `tracks` array in response
4. Update `healthy-backends.json` (remove failing backends)
5. Commit + push if changed

#### stream-check.yml (daily)
1. Read `healthy-backends.json`
2. Hardcoded Internet Archive track ID → `GET {url}/stream/{id}`
3. Verify JSON response has non-empty `url` field
4. Also: `GET {url}/search?q=music` → take first IA track → `GET {url}/stream/{id}`
5. Remove failing backends from `healthy-backends.json`
6. Commit + push if changed

#### register.yml (workflow_dispatch)
1. Input: `url` (new backend URL)
2. `GET {url}/manifest.json` — verify 200 + valid JSON
3. If healthy: append URL to `backends.json`, commit + push
4. Next manifest-ping cycle picks it up and adds to `healthy-backends.json`

### GitHub Repo (state storage)

```
backends.json
  ["https://backend2.workers.dev",
   "https://backend3.workers.dev",
   "https://backend4.vercel.app",
   "https://backend5.deno.dev"]
  ↑ Written by: register.yml only

healthy-backends.json
  ["https://backend2.workers.dev",
   "https://backend3.workers.dev",
   "https://backend4.vercel.app"]
  ↑ Written by: manifest-ping.yml, search-check.yml, stream-check.yml
  ↑ Read by: proxy (via raw.githubusercontent.com, 60s cache)

gh-pages branch
  Upptime static dashboard showing backend status
  ↑ Generated by: upptime.yml
```

**File ownership — one writer per file:**
- `backends.json` → `register.yml` only
- `healthy-backends.json` → health check workflows only
- No race conditions

### Upptime Dashboard (GitHub Pages)

Static HTML status page at `https://{user}.github.io/eclipse-load-balanced-addon/`. Shows:
- Each backend URL
- Current status (up/down)
- Response time history
- Uptime percentage

Generated by `upptime.yml` on each health check completion. No server-side code.

## Data Flow

### Eclipse Search Request

```
1. User searches "radiohead" in Eclipse
2. Eclipse → GET https://proxy.workers.dev/search?q=radiohead
3. Proxy: fetch healthy-backends.json (cached 60s)
4. Proxy: pick https://backend3.workers.dev (random)
5. Proxy: fetch("https://backend3.workers.dev/search?q=radiohead")
6. Backend3: search SoundCloud, TIDAL, Internet Archive, etc.
7. Backend3: return JSON { tracks: [...], albums: [...], ... }
8. Proxy: return backend3's response to Eclipse
9. Eclipse: display results
```

### Eclipse Stream Request

```
1. User taps play on a track
2. Eclipse → GET https://proxy.workers.dev/stream/track_123
3. Proxy: fetch healthy-backends.json (cached 60s)
4. Proxy: pick https://backend2.vercel.app (random)
5. Proxy: fetch("https://backend2.vercel.app/stream/track_123")
6. Backend2: resolve stream URL from provider (SoundCloud/TIDAL/etc.)
7. Backend2: return JSON { url: "https://cdn.soundcloud.com/...", format: "mp3" }
8. Proxy: return backend2's response to Eclipse
9. Eclipse: play audio directly from cdn.soundcloud.com (NOT through proxy)
```

### Backend Deployment + Registration

```
1. Developer: wrangler deploy (or vercel deploy, deno deploy)
2. Developer: set API keys via platform secrets
3. Developer: gh workflow run register.yml -f url=https://backend6.workers.dev
4. register.yml: GET https://backend6.workers.dev/manifest.json
5. register.yml: if healthy, append URL to backends.json, commit + push
6. Next manifest-ping cycle (within 10 min): includes backend6 in health checks
7. If healthy: added to healthy-backends.json
8. Proxy: picks up new backend within 60s of healthy-backends.json update
```

### Backend Failure + Recovery

```
1. backend4.vercel.app goes down
2. manifest-ping.yml (within 10 min): GET https://backend4.vercel.app/manifest.json → timeout
3. manifest-ping.yml: removes backend4 from healthy-backends.json
4. Proxy: picks up updated healthy-backends.json within 60s
5. Proxy: no longer routes traffic to backend4
6. Users: no disruption (other backends still serve)
7. backend4 comes back up
8. manifest-ping.yml: GET https://backend4.vercel.app/manifest.json → 200
9. manifest-ping.yml: re-adds backend4 to healthy-backends.json
10. Proxy: resumes routing to backend4 within 60s
```

## Request Routing Rules

| Scenario | Proxy Behavior |
|---|---|
| Healthy backend responds | Return response |
| Backend returns non-2xx | Try next backend (retry 1) |
| Backend times out (2s) | Try next backend (retry 1) |
| Retry 1 fails | Try next backend (retry 2) |
| Retry 2 fails | Return 503 Service Unavailable |
| `healthy-backends.json` is empty | Return 503 |
| `healthy-backends.json` fetch fails | Use last cached version (60s stale) |

## Eclipse URL

```
https://{proxy-domain}/manifest.json
```

No token, no API keys in URL. Clean. Eclipse fetches manifest from proxy, proxy routes to healthy backend.

## Platform Diversity

| Platform | Role | Free Tier | Why |
|---|---|---|---|
| CF Workers (account 1) | Proxy | 100k req/day | Global edge, fast cold starts |
| CF Workers (account 2) | Backend | 100k req/day | Same codebase, separate quota |
| CF Workers (account 3) | Backend | 100k req/day | Separate quota, separate account |
| Vercel | Backend | 100GB bandwidth | Reliable, auto-deploy from git |
| Deno Deploy | Backend | 1M req/month | Different runtime, different failure mode |

Multiple platforms = diverse failure modes. CF outage doesn't take down Vercel/Deno backends. Vercel outage doesn't take down CF/Deno backends. GHA removes dead instances automatically.
