# Setup Guide

This guide walks you through deploying your first backend instance and registering it with the load balancer.

## Prerequisites

- Node.js 18+ installed
- Cloudflare account (free)
- GitHub CLI (`gh`) installed and authenticated
- The `eclipse-load-balanced-addon` repo cloned locally

## Step 1: Deploy the Proxy

The proxy is the entry point Eclipse connects to. Deploy it first.

```bash
cd proxy
npm install
npx wrangler deploy
```

Wrangler outputs a URL like `https://eclipse-lb-proxy.<your-subdomain>.workers.dev`. This is your Eclipse addon URL.

Note: Update `proxy/wrangler.toml` to point `BACKENDS_URL` to your repo's `healthy-backends.json` raw URL if you forked the repo.

## Step 2: Deploy a Backend Instance

Each backend instance runs the full all-in-one addon code.

```bash
cd backend
npm install
npx wrangler deploy
```

Wrangler outputs a URL like `https://eclipse-backend.<your-subdomain>.workers.dev`. This is your first backend.

## Step 3: Set API Keys (Optional)

Without keys, the backend works for SoundCloud, Internet Archive, and Radio Browser. To enable additional providers, set secrets:

```bash
cd backend

# TIDAL HiFi (requires a HiFi instance URL)
npx wrangler secret put HIFI_INSTANCES

# SoundCloud (optional — auto-discovers client_id without this)
npx wrangler secret put SC_CLIENT_ID

# Podcast Index (free key from podcastindex.org)
npx wrangler secret put PI_KEY
npx wrangler secret put PI_SECRET

# Taddy (free key from taddy.org)
npx wrangler secret put TADDY_KEY
npx wrangler secret put TADDY_UID

# Deezer (requires ARL token from Deezer account)
npx wrangler secret put DEEZER_ARL

# Qobuz (requires app credentials)
npx wrangler secret put QOBUZ_USER_TOKEN
npx wrangler secret put QOBUZ_SECRET
npx wrangler secret put QOBUZ_APP_ID
```

Redeploy after setting secrets:

```bash
npx wrangler deploy
```

## Step 4: Register the Backend

Register the backend URL so the proxy knows about it:

```bash
gh workflow run register.yml -f url=https://eclipse-backend.<your-subdomain>.workers.dev
```

The `register.yml` workflow will:
1. Health-check the backend (GET /manifest.json)
2. If healthy, append the URL to `backends.json`
3. Trigger a manifest-ping to add it to `healthy-backends.json`

Within ~10 minutes, the proxy will start routing traffic to your backend.

## Step 5: Verify

Check that the backend is registered and healthy:

1. Go to the repo's **Actions** tab — verify `register.yml` succeeded
2. Wait 10 minutes for `manifest-ping.yml` to run
3. Check `healthy-backends.json` in the repo — your URL should be listed
4. Visit the status dashboard: `https://<username>.github.io/eclipse-load-balanced-addon/`
5. Test the proxy directly: `curl https://eclipse-lb-proxy.<your-subdomain>.workers.dev/manifest.json`

## Step 6: Install in Eclipse

1. Open Eclipse Music on your iPhone/iPad
2. Go to Settings → Connections → Add Connection → Addon
3. Paste your proxy URL: `https://eclipse-lb-proxy.<your-subdomain>.workers.dev/manifest.json`
4. Tap Install

## Adding More Backends

Deploy the same `backend/` code to different platforms for maximum redundancy:

### Cloudflare Workers (different account for separate quota)
```bash
cd backend
CLOUDFLARE_ACCOUNT_ID=<other-account-id> npx wrangler deploy
```

### Vercel
```bash
cd backend && npx vercel --prod
```

### Deno Deploy
1. Fork this repo
2. Create project at [dash.deno.com](https://dash.deno.com/new)
3. Link your fork, set entrypoint to `backend/deno.ts`
4. Add API keys as environment variables

### Fly.io
```bash
cd backend && flyctl deploy
```

### Render
1. Go to [render.com](https://dashboard.render.com) → New → Blueprint
2. Select this repo — `backend/render.yaml` auto-detected

### Register each new backend
```bash
gh workflow run register.yml -f url=https://<new-backend-url>
```

Each platform has different failure modes. Deploying across all of them maximizes uptime — if CF goes down, Vercel/Deno/Fly backends still serve traffic through the proxy.

## API Key Reference

| Key | Provider | Required? | How to Get |
|---|---|---|---|
| HIFI_INSTANCES | TIDAL HiFi | Optional | Community HiFi instance URL |
| SC_CLIENT_ID | SoundCloud | Optional | Auto-discovered without key |
| PI_KEY | Podcast Index | Optional | Free at podcastindex.org |
| PI_SECRET | Podcast Index | Optional | Paired with PI_KEY |
| TADDY_KEY | Taddy | Optional | Free at taddy.org |
| TADDY_UID | Taddy | Optional | Paired with TADDY_KEY |
| DEEZER_ARL | Deezer | Optional | From Deezer account cookies |
| QOBUZ_USER_TOKEN | Qobuz | Optional | Qobuz app credentials |
| QOBUZ_SECRET | Qobuz | Optional | Paired with QOBUZ_USER_TOKEN |
| QOBUZ_APP_ID | Qobuz | Optional | Paired with QOBUZ_USER_TOKEN |
| UPSTASH_REDIS_REST_URL | Upstash Redis | Optional | Free at upstash.com (Deezer stream cache only) |
| UPSTASH_REDIS_REST_TOKEN | Upstash Redis | Optional | Paired with UPSTASH_REDIS_REST_URL |
