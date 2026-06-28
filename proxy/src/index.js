/**
 * Eclipse Load-Balanced Addon — Proxy
 *
 * Receives all Eclipse traffic, reads healthy-backends.json from GitHub,
 * picks a random healthy backend, proxies the request (2 retries, 2s timeout).
 * Returns 503 if all backends are down.
 *
 * The proxy is read-only — it never writes to any file or database.
 * GHA workflows manage backends.json and healthy-backends.json.
 *
 * Env vars (set in wrangler.toml [vars] or via wrangler secret):
 *   BACKENDS_URL — raw GitHub URL to healthy-backends.json
 *   CACHE_TTL    — cache duration in seconds (default: 60)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// ─── CORS: applied to all responses ──────────────────────────────────────────
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['*'],
  exposeHeaders: ['X-Backend', 'X-Attempt', 'X-Response-Time'],
}));

// ─── In-memory cache for healthy-backends.json ────────────────────────────────
let _cachedBackends = null;
let _cachedAt = 0;

async function getHealthyBackends(env) {
  const now = Date.now();
  const ttl = parseInt(env.CACHE_TTL || '60', 10) * 1000;

  // Return cache if fresh
  if (_cachedBackends && (now - _cachedAt) < ttl) {
    return _cachedBackends;
  }

  try {
    const resp = await fetch(env.BACKENDS_URL, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!resp.ok) {
      console.warn(`Failed to fetch backends: ${resp.status}`);
      return _cachedBackends || [];
    }
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      _cachedBackends = data;
      _cachedAt = now;
    }
    return _cachedBackends || [];
  } catch (e) {
    console.warn('Error fetching backends:', e.message);
    return _cachedBackends || [];
  }
}

// ─── Pick random backend ──────────────────────────────────────────────────────
function pickRandom(backends) {
  if (!backends || backends.length === 0) return null;
  return backends[Math.floor(Math.random() * backends.length)];
}

// ─── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Proxy with retries ────────────────────────────────────────────────────────
const MAX_RETRIES = 2;
const TIMEOUT_MS = 2000;

async function proxyRequest(request, env) {
  const startTime = Date.now();
  const backends = await getHealthyBackends(env);

  if (backends.length === 0) {
    const ms = Date.now() - startTime;
    console.log(`[503] ${request.method} ${new URL(request.url).pathname} — no backends (${ms}ms)`);
    return new Response(
      JSON.stringify({ error: 'No healthy backends available' }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'X-Response-Time': `${ms}ms`,
        },
      }
    );
  }

  // Build the target URL: backend URL + original path + query string
  const url = new URL(request.url);
  const path = url.pathname;
  const query = url.search;

  // Headers to forward (strip proxy/CDN-specific headers)
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host');
  forwardHeaders.delete('cf-connecting-ip');
  forwardHeaders.delete('cf-ray');
  forwardHeaders.delete('cf-visitor');
  forwardHeaders.delete('cf-worker');
  forwardHeaders.delete('x-forwarded-for');
  forwardHeaders.delete('x-forwarded-proto');
  forwardHeaders.delete('x-real-ip');

  const method = request.method;
  let lastError = null;
  let backendUsed = null;

  // Try up to MAX_RETRIES + 1 backends
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const backend = pickRandom(backends);
    if (!backend) break;

    // Normalize: remove trailing slash from backend URL
    const backendBase = backend.replace(/\/+$/, '');
    const targetUrl = backendBase + path + query;

    try {
      const resp = await fetchWithTimeout(
        targetUrl,
        {
          method,
          headers: forwardHeaders,
          body: method !== 'GET' && method !== 'HEAD' ? request.body : undefined,
          redirect: 'follow',
        },
        TIMEOUT_MS
      );

      // If we got a 2xx response, return it
      if (resp.ok) {
        backendUsed = new URL(backend).host;
        const ms = Date.now() - startTime;
        console.log(`[200] ${method} ${path} — ${backendUsed} attempt ${attempt + 1} (${ms}ms)`);

        // Clone response and add proxy metadata headers
        const newHeaders = new Headers(resp.headers);
        newHeaders.set('X-Backend', backendUsed);
        newHeaders.set('X-Attempt', String(attempt + 1));
        newHeaders.set('X-Response-Time', `${ms}ms`);

        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: newHeaders,
        });
      }

      // Non-2xx: try next backend (but don't retry on 404 — resource genuinely doesn't exist)
      if (resp.status === 404) {
        const ms = Date.now() - startTime;
        console.log(`[404] ${method} ${path} — ${new URL(backend).host} (${ms}ms) — not retrying`);
        const newHeaders = new Headers(resp.headers);
        newHeaders.set('X-Backend', new URL(backend).host);
        newHeaders.set('X-Response-Time', `${ms}ms`);
        return new Response(resp.body, {
          status: 404,
          statusText: resp.statusText,
          headers: newHeaders,
        });
      }

      console.warn(`Backend ${backend} returned ${resp.status}, trying next...`);
      lastError = new Error(`Backend returned ${resp.status}`);
    } catch (e) {
      console.warn(`Backend ${backend} failed: ${e.message}, trying next...`);
      lastError = e;
    }
  }

  // All retries exhausted
  const ms = Date.now() - startTime;
  console.log(`[503] ${method} ${path} — all backends failed (${ms}ms)`);
  return new Response(
    JSON.stringify({ error: 'All backends failed', detail: lastError?.message || 'unknown' }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Response-Time': `${ms}ms`,
      },
    }
  );
}

// ─── Proxy health endpoint (not proxied to backend) ──────────────────────────
app.get('/proxy-health', async (c) => {
  const backends = await getHealthyBackends(c.env);
  const cacheAge = _cachedAt ? Math.round((Date.now() - _cachedAt) / 1000) : null;
  return c.json({
    status: 'ok',
    healthy_backends: backends.length,
    backends: backends.map(b => {
      try { return new URL(b).host; } catch { return b; }
    }),
    cache_age_seconds: cacheAge,
    cache_ttl_seconds: parseInt(c.env.CACHE_TTL || '60', 10),
  });
});

// ─── All other routes: proxy to backend ──────────────────────────────────────
app.all('*', async (c) => {
  return proxyRequest(c.req.raw, c.env);
});

// ─── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch.bind(app),
};
