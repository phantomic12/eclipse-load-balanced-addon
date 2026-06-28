/**
 * Deno Deploy adapter.
 * Runs the Hono app on Deno's native server.
 */
import app from './src/index.js';

Deno.serve(app.fetch);
