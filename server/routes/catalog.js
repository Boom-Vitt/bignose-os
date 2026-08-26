// server/routes/catalog.js — Slice D · catalog
//
// CONTRACT.md §3. Paths are RELATIVE to /api — the server mounts this router there.
//   GET   /catalog                 -> { skills, agents, routines, mcpServers }, 200 always
//   PATCH /catalog/skill/:name     -> updated Skill | 400 invalid | 404 unknown skill
//
// Neither handler ever throws out of the route.

import express from 'express';
import { getCatalog, invalidateCatalog } from '../lib/catalog.js';
import { writeSidecar } from '../lib/sidecar.js';
import { emit } from '../lib/bus.js';
import { normalizeProvider, validateSkillPatch } from '../lib/providers.js';

const EMPTY = { skills: [], agents: [], routines: [], mcpServers: [], applications: [] };

export function createCatalogRouter({
  catalogLoader = getCatalog,
  sidecarWriter = writeSidecar,
  invalidate = invalidateCatalog,
  emitEvent = emit,
} = {}) {
  const route = express.Router();

  // Body parsing is mounted here rather than relying on server/index.js (slice A).
  // express.json() is a no-op when a body was already parsed upstream, so this is
  // idempotent — but without it a PATCH would see `req.body === undefined` and
  // silently persist nothing while still answering 200.
  route.use(express.json({ limit: '256kb' }));

  route.get('/catalog', async (_req, res) => {
  try {
    const catalog = await catalogLoader();
    res.json(catalog ?? EMPTY);
  } catch (err) {
    console.warn('[claudeos:catalog] GET /catalog failed:', err && err.message ? err.message : err);
    res.json(EMPTY);   // 200 always — degrade to empty, never 500
  }
  });

  route.patch('/catalog/skill/:name', async (req, res) => {
  const name = String(req.params.name ?? '');
  try {
    const provider = normalizeProvider(req.query.provider);
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

    // Unknown skill -> 404 before we persist anything.
    const before = await catalogLoader();
    const exists = (before?.skills ?? []).some((s) => s.name === name && s.provider === provider);
    if (!exists) {
      res.status(404).json({ error: `unknown skill: ${name}` });
      return;
    }

    for (const key of Object.keys(body)) {
      if (key !== 'model' && key !== 'effort') {
        res.status(400).json({ error: `unknown field "${key}" (allowed: model, effort)` });
        return;
      }
    }

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'model')) patch.model = body.model;
    if (Object.prototype.hasOwnProperty.call(body, 'effort')) patch.effort = body.effort;
    if (Object.keys(patch).length === 0) {
      // An empty patch would persist nothing yet answer 200 — say so instead.
      res.status(400).json({ error: 'expected model and/or effort in the body' });
      return;
    }

    // Validate separately so expected client errors remain safe 400 responses,
    // while filesystem/write failures never expose their exception text.
    const validatedPatch = validateSkillPatch(provider, patch);
    try {
      sidecarWriter(name, validatedPatch, { provider });
    } catch {
      console.warn('[claudeos:catalog] skill settings write failed');
      res.status(500).json({
        error: 'skill settings update failed',
        code: 'SKILL_SETTINGS_WRITE_FAILED',
      });
      return;
    }

    // The sidecar feeds the catalog, so the cached build is now stale.
    invalidate();
    const after = await catalogLoader();
    const skill = (after?.skills ?? []).find((s) => s.name === name && s.provider === provider);
    if (!skill) {
      res.status(404).json({ error: `unknown skill: ${name}` });
      return;
    }

    try { emitEvent('catalog.invalidated', { reason: 'sidecar' }); }
    catch (err) { console.warn('[claudeos:catalog] emit failed:', err && err.message ? err.message : err); }

    res.json(skill);
  } catch (err) {
    const message = err && err.message ? err.message : 'invalid request';
    console.warn('[claudeos:catalog] PATCH /catalog/skill failed:', message);
    res.status(400).json({ error: message });
  }
  });

// Router-scoped error handler. express.json() throws on a malformed body, which
// would otherwise fall through to the app's default handler and answer HTML.
// Keeps every failure on this router shaped like the rest of the API.
  route.use((err, _req, res, _next) => {
  const message = err && err.message ? err.message : 'invalid request';
  console.warn('[claudeos:catalog] request rejected:', message);
  if (res.headersSent) return;
  res.status(400).json({ error: `invalid request body: ${message}` });
  });

  return route;
}

export const router = createCatalogRouter();
