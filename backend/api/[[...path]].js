/**
 * Vercel serverless function adapter.
 * Routes all traffic through the Hono app.
 */
import app from '../src/index.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    // @ts-ignore — duplex is needed for streaming body in Node 18+
    duplex: 'half',
  });

  // Attach env vars
  request.env = {
    HIFI_INSTANCES: process.env.HIFI_INSTANCES,
    SC_CLIENT_ID: process.env.SC_CLIENT_ID,
    SC_OAUTH_TOKEN: process.env.SC_OAUTH_TOKEN,
    PI_KEY: process.env.PI_KEY,
    PI_SECRET: process.env.PI_SECRET,
    TADDY_KEY: process.env.TADDY_KEY,
    TADDY_UID: process.env.TADDY_UID,
    DEEZER_ARL: process.env.DEEZER_ARL,
    QOBUZ_USER_TOKEN: process.env.QOBUZ_USER_TOKEN,
    QOBUZ_SECRET: process.env.QOBUZ_SECRET,
    QOBUZ_APP_ID: process.env.QOBUZ_APP_ID,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  try {
    const response = await app.fetch(request);
    res.status(response.status);
    response.headers.forEach((val, key) => res.setHeader(key, val));
    const body = await response.text();
    res.end(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
