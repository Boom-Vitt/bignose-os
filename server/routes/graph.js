// server/routes/graph.js — Slice B.
//
// CONTRACT.md §3. Paths are RELATIVE to /api; slice A mounts this router there.
//   GET  /api/graph         -> { nodes, edges, stats }
//   POST /api/graph/rescan  -> 202 { ok: true }
//
// CONTRACT.md §7: "If a source file is missing or malformed, degrade to
// empty/null — never throw out of a route." Both handlers answer 200/202 no
// matter what, so the UI degrades to an empty graph rather than a broken page.

import express from 'express';

import { getGraph, rescan } from '../lib/scanner.js';
import { redact } from './../lib/redact.js';

export const router = express.Router();

router.get('/graph', async (_req, res) => {
  try {
    const graph = await getGraph();
    res.status(200).json({
      nodes: Array.isArray(graph && graph.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph && graph.edges) ? graph.edges : [],
      stats: (graph && graph.stats) || {},
    });
  } catch (err) {
    const message = redact(String((err && err.message) || 'graph unavailable'));
    console.warn('[graph] GET /graph failed:', message);
    // Deliberately 200: an empty graph renders, a 500 does not.
    res.status(200).json({ nodes: [], edges: [], stats: { error: message } });
  }
});

router.post('/graph/rescan', (_req, res) => {
  // Answer immediately; the rebuild announces itself over SSE via
  // graph.invalidated { reason: 'manual' }.
  res.status(202).json({ ok: true });

  Promise.resolve()
    .then(() => rescan())
    .catch((err) => {
      console.warn('[graph] rescan failed:', redact(String((err && err.message) || err)));
    });
});
