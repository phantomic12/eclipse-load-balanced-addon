# Custom Domain Setup

The proxy and backends work fine on their default platform URLs (`.workers.dev`, `.vercel.app`, etc.). A custom domain is optional but recommended for the proxy — it's the URL Eclipse stores.

## Proxy Custom Domain (Cloudflare)

Since the proxy runs on CF Workers, use Cloudflare DNS:

1. Add your domain to Cloudflare (if not already there) — free plan is fine
2. Go to Workers & Pages → your proxy worker (`eclipse-lb-proxy`)
3. Settings → Triggers → Custom Domains → Add Custom Domain
4. Enter your domain (e.g. `eclipse.yourdomain.com`)
5. Cloudflare auto-creates the DNS record and provisions SSL

Your Eclipse addon URL becomes: `https://eclipse.yourdomain.com/manifest.json`

## Backend Custom Domains (Optional)

Backend instances don't need custom domains — the proxy routes to them by URL. But if you want them:

### Cloudflare Workers backends
Same process as proxy — Workers → Settings → Triggers → Custom Domains.

### Vercel backends
Vercel dashboard → Project → Settings → Domains → Add domain.

### Deno Deploy backends
Deno Deploy dashboard → Project → Settings → Domains.

### Fly.io backends
```bash
flyctl certs add eclipse-backend.yourdomain.com
```

## Updating the Proxy URL in wrangler.toml

If you fork this repo, update the `BACKENDS_URL` in `proxy/wrangler.toml`:

```toml
[vars]
BACKENDS_URL = "https://raw.githubusercontent.com/YOUR-USERNAME/eclipse-load-balanced-addon/main/healthy-backends.json"
```

Then redeploy the proxy:
```bash
cd proxy && npx wrangler deploy
```

## DNS-Only Setup (No Custom Domain)

If you don't want to use a custom domain, just use the platform URLs directly:

- Proxy: `https://eclipse-lb-proxy.<your-subdomain>.workers.dev/manifest.json`
- Backends: registered via `gh workflow run register.yml -f url=https://...`

The proxy URL is what you paste into Eclipse. Backend URLs are internal — only the proxy needs to reach them.
