# Open Questions

Questions to resolve during implementation.

## Finding a Stable Internet Archive Track ID

The daily stream check needs a hardcoded Internet Archive track ID that won't disappear. Need to find:
- A public domain music recording on archive.org
- With a stable item identifier
- That the `improved-all-in-one` codebase can resolve via `/stream/{id}`

Action: Browse archive.org for a permanent music item, test its ID against the `improved-all-in-one` codebase, hardcode in `stream-check.yml`.

## CF Workers Cross-Account Setup

Multiple CF Workers accounts need:
- Separate email addresses
- Separate Cloudflare zones (or same zone, different Workers)
- Question: Can multiple accounts deploy Workers under the same custom domain, or does each need its own subdomain?

Action: Test deploying Workers on two CF accounts. If same domain is an issue, use subdomains (`backend2.proxy.dev`, `backend3.proxy.dev`).

## Vercel Serverless Function Timeout

Vercel hobby tier has a 10s timeout for serverless functions. The backend addon needs to respond within 3s (Eclipse stream requirement) and 5s (search). Should be fine, but TIDAL HiFi login flow can be slow (1-2s). If the backend takes >10s on Vercel, the function times out and the proxy tries the next backend.

Action: Monitor Vercel response times during Phase 2 testing. If timeouts occur, consider caching TIDAL sessions.

## Deno Deploy Hono Compatibility

The `improved-all-in-one` uses Hono with `nodejs_compat` flag on CF Workers. Deno Deploy runs standard Hono natively — but some CF-specific APIs (KV, Cache API) won't work. Need to make KV usage optional (it already is in the codebase — KV is used for ISRC cache, falls back gracefully without it).

Action: Test Hono app on Deno Deploy. If KV breaks, ensure code falls back to no-cache mode.

## Provider API Key Acquisition

Some providers need API keys:
- TIDAL HiFi: needs HiFi instance URL (self-hosted or community instance)
- Podcast Index: free API key from podcastindex.org
- Taddy: free API key from taddy.org
- Deezer (v2): Deezer API key
- Qobuz (v2): Qobuz API key

Action: Document which keys are needed, how to get them (free where possible), and how to set them per platform.

## Proxy CORS Behavior

Eclipse is a native iOS app using URLSession — CORS doesn't apply. But the proxy should still return `Access-Control-Allow-Origin: *` on its responses for safety (in case Eclipse ever uses a web view, or for browser-based testing).

Action: Add CORS headers to proxy response. Minimal effort, no downside.

## GHA Workflow Concurrency

Multiple health check workflows might run simultaneously (e.g., manifest-ping and search-check overlap). Both write to `healthy-backends.json`. Need to ensure GHA handles concurrent writes — either via Git push retries or workflow concurrency groups.

Action: Use GHA `concurrency` groups to serialize writes to `healthy-backends.json`. One workflow at a time can write.

## backends.json Schema

Current schema: flat array of URL strings `["https://...", "https://..."]`. Simple. Could be extended to objects with metadata `[{url, platform, region, weight}]` for weighted routing in Phase 6.

Action: Keep flat array for v1. Extend schema if weighted routing is implemented.
