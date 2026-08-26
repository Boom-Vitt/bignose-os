// server/routes/run.js — Slice E · run manager HTTP surface.
//
// CONTRACT.md §3:
//   POST /api/run          body {prompt, provider?, model?, effort?, cwd?, resumeSessionId?}
//                          -> {runId, sessionId}
//   GET  /api/run/:runId   -> {runId, state, transcript}; 404 {error} if unknown
//
// Paths here are relative to /api — slice A mounts this router at that prefix.
// No handler may throw: every path ends in a res.*.json().

import express from 'express';

import { isExecutionEnabled } from '../lib/execution-mode.js';
import { normalizeProvider, validateSkillPatch } from '../lib/providers.js';
import {
  startRun as defaultStartRun,
  getRun as defaultGetRun,
  getResumableSession as defaultGetResumableSession,
} from '../lib/runner.js';

const MAX_PROMPT = 8000;

// Own body parser so this router works whether or not slice A mounted one.
// express.json() no-ops on an already-parsed body, so double-mounting is safe.
// Attached per-route, not router-wide: slice A may mount several routers at
// /api, and this must not run for paths another slice owns.
const parseBody = express.json({ limit: '64kb' });

export function createRunRouter({
  env = process.env,
  executionEnabled = isExecutionEnabled(env),
  startRun = defaultStartRun,
  getRun = defaultGetRun,
  getResumableSession = defaultGetResumableSession,
} = {}) {
  const router = express.Router();

  router.post('/run', (req, res, next) => {
    if (!executionEnabled) {
      return res.status(403).json({
        error: 'execution disabled',
        errorCode: 'execution-disabled',
      });
    }
    return next();
  }, parseBody, (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({ error: 'prompt must be a non-empty string' });
    }
    if (prompt.length > MAX_PROMPT) {
      return res.status(400).json({ error: `prompt must be ${MAX_PROMPT} characters or fewer` });
    }
    if (body.cwd != null && body.cwd !== '' && typeof body.cwd !== 'string') {
      return res.status(400).json({ error: 'cwd must be a string' });
    }

    let provider;
    let patch;
    try {
      provider = normalizeProvider(body.provider);
      const requestedOverrides = {};
      if (Object.hasOwn(body, 'model')) requestedOverrides.model = body.model;
      if (Object.hasOwn(body, 'effort')) requestedOverrides.effort = body.effort;
      patch = validateSkillPatch(provider, requestedOverrides);
    } catch (error) {
      const message = error instanceof Error && /provider/.test(error.message)
        ? 'provider must be claude or codex'
        : 'invalid model or effort for provider';
      return res.status(400).json({ error: message });
    }

    const resumeSessionId = body.resumeSessionId ?? null;
    if (resumeSessionId !== null && provider !== 'codex') {
      return res.status(400).json({ error: 'resumeSessionId is supported only for Codex' });
    }
    if (resumeSessionId !== null && getResumableSession(resumeSessionId) === null) {
      return res.status(400).json({
        error: 'Codex session could not be resumed',
        errorCode: 'session-expired',
      });
    }

    try {
      const { runId, sessionId } = startRun({
        prompt,
        provider,
        model: patch.model ?? null,
        effort: patch.effort ?? null,
        cwd: body.cwd == null || body.cwd === '' ? null : body.cwd,
        resumeSessionId,
      });
      return res.status(200).json({ runId, sessionId });
    } catch {
      return res.status(500).json({ error: 'could not start run' });
    }
  });

  router.get('/run/:runId', (req, res) => {
    try {
      const run = getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'unknown run' });
      return res.status(200).json(run);
    } catch {
      return res.status(500).json({ error: 'could not read run' });
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(400).json({ error: 'invalid JSON body' });
  });
  return router;
}

export const router = createRunRouter();
