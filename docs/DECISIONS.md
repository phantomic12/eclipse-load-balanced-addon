# Decision Log

Decision log from the grilling session. 23 questions resolved.

---

## D1: Load balancer architecture — separate proxy service

**Question:** Is the load balancer a separate service, or logic embedded inside each addon instance?

**Decision:** Separate proxy service. Eclipse stores one addon URL and has no multi-host failover. A separate proxy (thin CF Workers function) receives all Eclipse traffic, reads `healthy-backends.json`, routes to a healthy backend instance. Peer-to-peer/gossip between instances can't work because Eclipse only knows one URL.

---

## D2: GitHub Pages as the addon endpoint — not possible

**Question:** Can the addon URL be a GitHub Pages site?

**Decision:** No. GitHub Pages is static file hosting — it cannot handle `/search?q=hello` or `/stream/{id}`. Eclipse expects dynamic JSON responses per query/path. GitHub Pages is used only for the Upptime status dashboard (static HTML).

---

## D3: DNS round-robin — not used (proxy approach instead)

**Question:** Can we do DNS round-robin across backend URLs?

**Decision:** No. DNS round-robin requires A records (IPs). Most free serverless platforms (CF Workers, Vercel, Render, Deno Deploy) give hostnames, not IPs. Instead, a proxy function receives all requests and routes to healthy backends. This allows URL-based backends across any platform, no IPs needed.

---

## D4: Entry point redundancy — single proxy on CF Workers

**Question:** How do we handle entry-point redundancy (single point of failure)?

**Decision:** Accept single proxy entry point on CF Workers for v1. CF Workers uptime is excellent. The proxy does minimal compute (just proxy + retry). If CF goes down, the addon goes down temporarily — acceptable for v1. Can add a secondary proxy on Deno Deploy later if needed.

---

## D5: Cross-platform backends — mixed platforms

**Question:** One CF account or multiple? Mixed platforms?

**Decision:** Mixed platforms. Deploy backend instances across CF Workers (multiple accounts for separate 100k/day quotas), Vercel, Deno Deploy. Diverse platforms = diverse failure modes. No single platform outage takes down the whole addon.

---

## D6: Redirect vs proxy — proxy with retries

**Question:** Should the proxy do 302 redirects or full proxying?

**Decision:** Full proxy with 2 retries, 2s timeout each. Redirect can't retry — once Eclipse follows a 302, it's committed to that backend. If that backend is down, user gets an error. Proxy can try multiple backends and return the first successful response. CPU time is <1ms (I/O doesn't count). Audio never goes through the proxy — only small JSON payloads.

---

## D7: Backend pool config — GitHub raw file, 60s cache

**Question:** Where does the proxy read the backend list from?

**Decision:** Fetch `healthy-backends.json` from `raw.githubusercontent.com` with 60s in-memory cache. GHA updates the file every 10 min. Worst-case stale backend: 10 min (health check interval) + 60s (cache) = 11 min before proxy stops routing to a dead backend.

---

## D8: Shared cache between instances — no shared cache

**Question:** Do backend instances share a cache (e.g., Upstash Redis)?

**Decision:** No. Each instance is fully independent — own cache, own sessions, own everything. More provider API calls, but fewer moving parts. No external Redis dependency to manage or pay for.

---

## D9: Proxy retry behavior — 2 retries, 2s timeout

**Question:** How many retries and what timeout per attempt?

**Decision:** 2 retries (3 total attempts), 2s timeout per attempt. Worst-case latency: 4s (within Eclipse's 5s search limit). With 5+ backends, probability all 3 attempted are down: ~1.6%. Conservative on compute, generous on timeout to avoid false failures.

---

## D10: Proxy hosting — CF Workers

**Question:** Where is the proxy hosted?

**Decision:** CF Workers (separate account from backends). 100k req/day is plenty for a proxy that does microsecond compute. Free tier, global edge, fast cold starts.

---

## D11: v1 provider set — ship existing, add later

**Question:** Merge all providers into the codebase before shipping, or ship with existing set?

**Decision:** Ship with the existing `improved-all-in-one` provider set (TIDAL HiFi, SoundCloud, Internet Archive, Podcast Index, Taddy, Apple Podcasts, LibriVox, Radio Browser). Add Deezer, Qobuz, YouTube, Spotify FLAC, Jamendo, AnimeThemes, FMA, MusicBrainz in v2+. Validate the load balancing architecture first, then add providers incrementally.

---

## D12: Backend registration — deploy-time registration via GHA workflow

**Question:** How does a new backend get added to the pool?

**Decision:** Deploy-time registration. True self-registration doesn't work on serverless (no startup event). Deploy script triggers `register.yml` workflow_dispatch with the backend URL. GHA health-checks the new backend, appends to `backends.json` if healthy. Shared secret authenticates the registration call.

---

## D13: Registration storage — GHA writes to GitHub repo, proxy is read-only

**Question:** Where does the proxy store registered backends?

**Decision:** GHA workflow handles registration writes. Deploy script triggers `register.yml`, which health-checks the backend and appends to `backends.json` in the repo. Proxy reads `healthy-backends.json` from `raw.githubusercontent.com` — never writes. No KV, no D1, no GitHub token in the Worker. Proxy stays read-only.

---

## D14: GHA minute budget — one account, relaxed schedules

**Question:** How to handle the 2,000 GHA min/month free tier?

**Decision:** One account, relaxed schedules. Manifest ping every 10 min (not 5), search every 2 hours, stream daily. Total ~850 min/month. Within 2,000 free tier with headroom for registration and dashboard jobs.

---

## D15: Health check tiers — manifest, search, stream

**Question:** What does GHA check per backend?

**Decision:** Three tiers:
- **Manifest ping (every 10 min):** `GET /manifest.json` → verify 200 + valid JSON. Catches platform outages, broken deploys.
- **Search check (every 2 hours):** `GET /search?q=music` → verify non-empty tracks array. Catches broken provider integrations, edge cases.
- **Stream check (daily):** Hardcoded Internet Archive track ID → `GET /stream/{id}` → verify `url` field. Plus search-then-stream (search `music`, take first IA track, resolve stream). Verifies full end-to-end pipeline.

---

## D16: Health check search query — "music"

**Question:** What search query for the functional check?

**Decision:** `music`. Returns results from all keyless providers (SoundCloud, Internet Archive). Natural, broad, every provider returns results. If a backend returns zero tracks for "music", something is genuinely broken.

---

## D17: Stream check approach — both hardcoded + search-then-stream

**Question:** Hardcoded IA track ID or search-then-stream for daily check?

**Decision:** Both. Hardcoded IA track ID verifies stream resolution pipeline. Search-then-stream verifies full end-to-end flow. Belt and suspenders.

---

## D18: All backends down — return 503

**Question:** What does the proxy return when all backends are down?

**Decision:** 503 Service Unavailable. Honest failure. Eclipse handles addon failures gracefully — app works, just this addon's content doesn't load. Upptime dashboard shows status. Don't fake availability.

---

## D19: Token/API key handling — keys in backend env vars

**Question:** Should the proxy see the token (API keys)?

**Decision:** No token. API keys stored in backend env vars (CF Workers secrets, Vercel env vars, Deno Deploy env). Eclipse URL is just `https://proxy.workers.dev/manifest.json` — clean, no keys in URL. Proxy never sees sensitive data. Each backend reads keys from its own environment. The `improved-all-in-one` codebase falls back to env vars when no token is provided.

---

## D20: Backend state file structure — two files

**Question:** Does the proxy read `backends.json` (all) or a separate healthy file?

**Decision:** Two files. `backends.json` — all registered URLs, written by `register.yml` only. `healthy-backends.json` — subset passing health checks, written by health check workflows only. Proxy reads `healthy-backends.json`. Each file has one writer — no race conditions.

---

## D21: Proxy approach — full proxy with retries (confirmed)

**Question:** Redirect or proxy?

**Decision:** Full proxy. The proxy does one `fetch()` to the backend, returns the response body. Enables retries on failure. Audio never goes through the proxy — only small JSON. CPU time <1ms per request.

---

## D22: Platform diversity — CF Workers + Vercel + Deno Deploy

**Question:** Which platforms for backends?

**Decision:** Multiple platforms. CF Workers (accounts 2, 3) + Vercel + Deno Deploy. Each platform has different failure modes. GHA removes dead instances automatically. Add more platforms (Render, Netlify, Fly.io) as needed.

---

## D23: Cost — $0

**Question:** Total cost?

**Decision:** $0. All free tiers:
- CF Workers: 100k req/day per account (×3 accounts)
- Vercel: 100GB bandwidth, unlimited function invocations
- Deno Deploy: 1M req/month
- GitHub Actions: 2,000 min/month
- GitHub Pages: free static hosting
- raw.githubusercontent.com: free, no rate limit for public repos
