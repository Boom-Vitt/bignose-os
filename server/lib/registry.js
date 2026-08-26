// server/lib/registry.js — Slice A · the wiring table for all eight slices.
//
// Everything here is loaded with dynamic import() on purpose: this module is
// written in parallel with the modules it loads, so a slice that does not exist
// yet (or throws at import time) must degrade into a missing feature, never a
// dead server. Each mount and each service start gets its own try/catch.

import express from 'express';

/**
 * Route modules. Each exports `export const router` — an express.Router() whose
 * paths are relative to /api. `prefix` is the API sub-path the fallback claims
 * when the real module is unavailable, so the client gets JSON 503 instead of
 * falling through to the SPA handler and receiving an HTML page.
 */
const ROUTE_MODULES = [
  { name: 'brain',   specifier: '../routes/brain.js',   prefix: '/brain' },
  { name: 'graph',   specifier: '../routes/graph.js',   prefix: '/graph' },
  { name: 'jobs',    specifier: '../routes/jobs.js',    prefix: '/jobs' },
  { name: 'catalog', specifier: '../routes/catalog.js', prefix: '/catalog' },
  { name: 'run',     specifier: '../routes/run.js',     prefix: '/run' },
];

/** Background services started after the port is open. */
const SERVICES = [
  { name: 'scanner', specifier: './scanner.js', fn: 'startScanner' },
  { name: 'jobs',    specifier: './jobs.js',    fn: 'startJobs' },
  { name: 'catalog', specifier: './catalog.js', fn: 'startCatalogWatch' },
];

function unavailableRouter(prefix, reason) {
  const router = express.Router();
  // .use, not .all — claims the prefix and everything beneath it
  // (/graph/rescan, /catalog/skill/:name, /run/:runId).
  router.use(prefix, (_req, res) => {
    res.status(503).json({ error: 'slice unavailable', path: prefix, reason });
  });
  return router;
}

/**
 * Mount every route module under /api. Never throws.
 * @param {import('express').Express} app
 * @returns {Promise<{mounted: string[], degraded: string[]}>}
 */
export async function mountRoutes(app) {
  const mounted = [];
  const degraded = [];

  for (const { name, specifier, prefix } of ROUTE_MODULES) {
    try {
      const mod = await import(specifier);
      if (typeof mod?.router !== 'function') {
        throw new Error('module does not export `router`');
      }
      app.use('/api', mod.router);
      mounted.push(name);
    } catch (err) {
      console.warn(`[claudeos] route ${name} unavailable:`, err.message);
      degraded.push(name);
      try {
        app.use('/api', unavailableRouter(prefix, `route module ${name} failed to load`));
      } catch (mountErr) {
        console.warn(`[claudeos] route ${name} fallback failed:`, mountErr.message);
      }
    }
  }

  return { mounted, degraded };
}

/**
 * Start the background watchers. Called AFTER listen() so a slow scanner never
 * delays the port opening. Never throws.
 * @returns {Promise<{started: string[], degraded: string[]}>}
 */
export async function startServices() {
  const started = [];
  const degraded = [];

  for (const { name, specifier, fn } of SERVICES) {
    try {
      const mod = await import(specifier);
      if (typeof mod?.[fn] !== 'function') {
        throw new Error(`module does not export ${fn}()`);
      }
      // Deliberately NOT awaited. The pinned interface says these return void,
      // but a slice may hand back a promise that only settles after a full
      // filesystem walk — awaiting it would hold every service behind it
      // hostage, which is exactly the cascade this module exists to prevent.
      // Sync throws are still caught below; async ones are reported here.
      const pending = mod[fn]();
      if (pending && typeof pending.then === 'function') {
        pending.then(undefined, (err) => {
          console.warn(`[claudeos] service ${name} unavailable:`, err?.message ?? err);
        });
      }
      started.push(name);
    } catch (err) {
      console.warn(`[claudeos] service ${name} unavailable:`, err.message);
      degraded.push(name);
    }
  }

  return { started, degraded };
}
