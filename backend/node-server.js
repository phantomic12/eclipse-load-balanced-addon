/**
 * Node.js server adapter (for Docker/Render/Fly.io/Railway).
 * Uses @hono/node-server to run the Hono app as a standard HTTP server.
 */
import { serve } from '@hono/node-server';
import app from './src/index.js';

const port = process.env.PORT || 3000;

// Patch: Hono's c.env is empty on Node.js. Inject process.env so getConfig() works.
const originalFetch = app.fetch.bind(app);
app.fetch = (request, env, ctx) => {
  // Merge process.env into the Hono context env
  const mergedEnv = { ...process.env, ...env };
  return originalFetch(request, mergedEnv, ctx);
};

serve({
  fetch: app.fetch,
  port: Number(port),
}, (info) => {
  console.log(`Eclipse backend running on http://localhost:${info.port}`);
});
