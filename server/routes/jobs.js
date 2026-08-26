// server/routes/jobs.js — Slice C · GET /api/jobs
//
// Paths are relative to /api; slice A mounts this router there.

import express from 'express';

import { listJobs } from '../lib/jobs.js';

export const router = express.Router();

// CONTRACT §3 — always 200, always `{ jobs: Job[] }`. Never throws.
router.get('/jobs', (_req, res) => {
  let jobs = [];
  try {
    const snapshot = listJobs();
    if (Array.isArray(snapshot)) jobs = snapshot;
  } catch (err) {
    console.warn('[claudeos:jobs] GET /api/jobs failed:', err?.message || err);
  }
  res.status(200).json({ jobs });
});
