// server/index.js — Slice A · boombignose_claudeos server core.
//
// The only file in the project allowed to call process.exit (CONTRACT.md §7).
// Boot order matters:
//   1. viewer execution gate, then body parser
//   2. core endpoints (/api/health, /api/events, /api/hooks)
//   3. mountRoutes()  — slice routes, each degrading to JSON 503
//   4. JSON 404 for any other /api/*
//   5. static public/, then SPA fallback for non-/api HTML GETs
//   6. JSON error handler
//   7. listen, THEN startServices() — a slow scanner must not delay the port

import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';

import { CONFIG } from './lib/config.js';
import * as bus from './lib/bus.js';
import { isExecutionEnabled, LOCAL_VIEWER_SOURCES } from './lib/execution-mode.js';
import { mountRoutes, startServices } from './lib/registry.js';

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

const LOCAL_APP_CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'";

function loopbackOrigin(host) {
  if (typeof host !== 'string' || !host) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

// This server is a local execution boundary. Validate Host and Origin before
// any request body parser can hand hostile input to a route.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', LOCAL_APP_CSP);

  const origin = loopbackOrigin(req.get('host'));
  if (!origin) {
    res.status(403).json({ error: 'forbidden host' });
    return;
  }

  const requestOrigin = req.get('origin');
  if (requestOrigin && requestOrigin !== origin) {
    res.status(403).json({ error: 'forbidden origin' });
    return;
  }

  next();
});

// Viewer mode is a hard boundary, not merely route validation. Deny run POSTs
// before any parser reads the body so malformed, empty, and oversized payloads
// all receive the same fixed response and can never reach execution code.
app.use('/api/run', (req, res, next) => {
  if (req.method !== 'POST' || isExecutionEnabled()) {
    next();
    return;
  }
  res.status(403).json({
    error: 'execution disabled',
    errorCode: 'execution-disabled',
  });
});

app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'application/*+json'],
}));

// ---------------------------------------------------------------------------
// core endpoints
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: CONFIG.VERSION,
    startedAt: bus.serverStartedAt,
    port: CONFIG.PORT,
    mode: 'viewer',
    executionEnabled: isExecutionEnabled(),
    sources: LOCAL_VIEWER_SOURCES,
  });
});

app.get('/api/events', (req, res) => {
  const detach = bus.attach(res);
  req.on('close', detach);
  req.on('error', detach);
});

// --- POST /api/hooks -------------------------------------------------------
// Bearer auth, compared as fixed-length SHA-256 digests so timingSafeEqual
// never sees unequal lengths (and the comparison leaks no length information).
const EXPECTED_TOKEN_DIGEST = crypto
  .createHash('sha256')
  .update(String(CONFIG.HOOK_TOKEN ?? ''), 'utf8')
  .digest();

function hookAuthOk(header) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = crypto.createHash('sha256').update(match[1].trim(), 'utf8').digest();
  try {
    return crypto.timingSafeEqual(presented, EXPECTED_TOKEN_DIGEST);
  } catch {
    return false;
  }
}

app.post('/api/hooks', (req, res) => {
  if (!hookAuthOk(req.get('authorization'))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Claude Code sends snake_case; accept camelCase too (CONTRACT.md §2).
  const payload = {
    event: body.hook_event_name ?? body.hookEventName ?? null,
    sessionId: body.session_id ?? body.sessionId ?? null,
    cwd: body.cwd ?? null,
    toolName: body.tool_name ?? body.toolName ?? null,
    at: Date.now(),
  };

  // Respond first — a hook must never wait on fan-out.
  res.status(202).json({ ok: true });
  setImmediate(() => {
    try {
      bus.emit('hook.event', payload);
    } catch (err) {
      console.warn('[claudeos] hook emit failed:', err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// slice routes + static + SPA
// ---------------------------------------------------------------------------

const { mounted, degraded } = await mountRoutes(app);

// Anything under /api that nothing claimed is JSON, never the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl });
});

app.use(express.static(CONFIG.PUBLIC_DIR, { extensions: ['html'] }));

const INDEX_HTML = path.join(CONFIG.PUBLIC_DIR, 'index.html');

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path === '/api') return next();
  if (!req.accepts('html')) return next();

  res.sendFile(INDEX_HTML, (err) => {
    if (!err) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    // public/index.html is Slice F's; until it lands, say so in JSON.
    res.status(404).json({ error: 'ui not built', path: req.originalUrl });
  });
});

// JSON error handler — never an HTML stack page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.warn('[claudeos] request failed:', err?.message ?? err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: err?.type === 'entity.parse.failed' ? 'invalid json body' : (err?.message ?? 'internal error'),
    status,
  });
});

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

const server = app.listen(CONFIG.PORT, CONFIG.HOST);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[claudeos] port ${CONFIG.PORT} is already in use on ${CONFIG.HOST}.\n` +
      `[claudeos] another claudeos server is probably running. Stop it, or set ` +
      `CLAUDEOS_PORT to a free port and retry.`
    );
  } else if (err.code === 'EACCES') {
    console.error(`[claudeos] not permitted to bind ${CONFIG.HOST}:${CONFIG.PORT}.`);
  } else {
    console.error('[claudeos] server error:', err.message);
  }
  process.exit(1);
});

await new Promise((resolve) => server.once('listening', resolve));

console.log(`[claudeos] v${CONFIG.VERSION} listening on http://${CONFIG.HOST}:${CONFIG.PORT}`);
if (mounted.length) console.log('[claudeos] routes mounted:', mounted.join(', '));
if (degraded.length) console.log('[claudeos] routes degraded:', degraded.join(', '));

// After listen, so slow watchers never delay the port opening.
const services = await startServices();
if (services.started.length) console.log('[claudeos] services started:', services.started.join(', '));
if (services.degraded.length) console.log('[claudeos] services degraded:', services.degraded.join(', '));

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

let closing = false;

function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[claudeos] ${signal} — shutting down`);
  try {
    bus.closeAll();
  } catch { /* nothing to close */ }
  server.close(() => process.exit(0));
  // SSE sockets are keep-alive by design; do not wait on them.
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.warn('[claudeos] unhandled rejection:', reason?.message ?? reason);
});
