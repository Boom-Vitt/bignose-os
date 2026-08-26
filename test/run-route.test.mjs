import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import fs from 'node:fs';
import test from 'node:test';

import { createResumeRegistry } from '../server/lib/resume-registry.js';
import { createRunRouter } from '../server/routes/run.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const THIRD_UUID = '33333333-3333-4333-8333-333333333333';
const UUID_V7 = '019c9a3e-1234-7abc-8def-123456789abc';

async function request(router, { method = 'POST', path = '/api/run', body } = {}) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? {} : {
        'content-type': 'application/json', accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('resume registry binds canonical UUIDs to real cwd, expires, and evicts oldest', () => {
  let now = 1_000;
  const originalCwd = fs.realpathSync(process.cwd());
  const registry = createResumeRegistry({ now: () => now, ttlMs: 100, max: 2 });
  assert.deepEqual(registry.capture(UUID, originalCwd), {
    provider: 'codex', cwd: originalCwd, capturedAt: 1_000,
  });
  now = 1_001;
  registry.capture(OTHER_UUID, originalCwd);
  now = 1_002;
  registry.capture(THIRD_UUID, originalCwd);
  assert.equal(registry.lookup(UUID), null);
  assert.equal(registry.lookup(OTHER_UUID).capturedAt, 1_001);
  now = 1_102;
  assert.equal(registry.lookup(OTHER_UUID), null);
  assert.throws(() => registry.capture('--last', originalCwd), /valid Codex session UUID/);
  assert.throws(() => registry.capture(UUID, '/definitely/missing'), /valid real directory/);
  registry.clear();
  assert.equal(registry.lookup(THIRD_UUID), null);
});

test('resume registry accepts UUIDv7 and rejects noncanonical, option-like, and unsupported versions', () => {
  const cwd = fs.realpathSync(process.cwd());
  const registry = createResumeRegistry({ now: () => 7_000 });
  assert.deepEqual(registry.capture(UUID_V7, cwd), {
    provider: 'codex', cwd, capturedAt: 7_000,
  });
  assert.deepEqual(registry.lookup(UUID_V7), {
    provider: 'codex', cwd, capturedAt: 7_000,
  });
  for (const invalid of [
    '019c9a3e-1234-0abc-8def-123456789abc',
    '019c9a3e-1234-9abc-8def-123456789abc',
    '019c9a3e12347abc8def123456789abc',
    '019c9a3e-1234-7abc-7def-123456789abc',
    '--last',
  ]) {
    assert.throws(() => registry.capture(invalid, cwd), /valid Codex session UUID/);
    assert.equal(registry.lookup(invalid), null);
  }
});

test('run route validates provider-specific fields before startRun', async () => {
  const calls = [];
  const router = createRunRouter({
    executionEnabled: true,
    startRun(options) {
      calls.push(options);
      return { runId: 'run-1', sessionId: 'run-1' };
    },
    getRun: () => null,
    getResumableSession: (id) => id === UUID
      ? { provider: 'codex', cwd: process.cwd(), capturedAt: 1 }
      : null,
  });

  assert.equal((await request(router, { body: { prompt: 'x', provider: 'unknown' } })).status, 400);
  assert.equal((await request(router, { body: { prompt: 'x', provider: 'codex', effort: 'max' } })).status, 400);
  assert.equal((await request(router, { body: { prompt: 'x', provider: 'codex', resumeSessionId: '--last' } })).status, 400);
  assert.deepEqual((await request(router, {
    body: { prompt: 'x', provider: 'codex', resumeSessionId: OTHER_UUID },
  })), {
    status: 400,
    body: { error: 'Codex session could not be resumed', errorCode: 'session-expired' },
  });
  assert.deepEqual((await request(router, {
    body: { prompt: 'x', provider: 'claude', resumeSessionId: UUID },
  })).body, { error: 'resumeSessionId is supported only for Codex' });
  assert.equal(calls.length, 0);

  const accepted = await request(router, {
    body: { prompt: 'go', provider: 'codex', model: '', effort: '', cwd: process.cwd(), resumeSessionId: UUID },
  });
  assert.deepEqual(accepted, { status: 200, body: { runId: 'run-1', sessionId: 'run-1' } });
  assert.deepEqual(calls[0], {
    prompt: 'go', provider: 'codex', model: null, effort: null,
    cwd: process.cwd(), resumeSessionId: UUID,
  });
});

test('omitted provider preserves Claude POST and exact GET compatibility', async () => {
  const calls = [];
  const frozen = { runId: 'run-existing', state: 'done', transcript: [] };
  const router = createRunRouter({
    executionEnabled: true,
    startRun(options) {
      calls.push(options);
      return { runId: 'run-new', sessionId: 'run-new' };
    },
    getRun: (id) => id === frozen.runId ? frozen : null,
    getResumableSession: () => null,
  });

  assert.deepEqual(await request(router, { body: { prompt: 'legacy', model: 'opus' } }), {
    status: 200, body: { runId: 'run-new', sessionId: 'run-new' },
  });
  assert.deepEqual(calls[0], {
    prompt: 'legacy', provider: 'claude', model: 'opus', effort: null,
    cwd: null, resumeSessionId: null,
  });
  const fetched = await request(router, { method: 'GET', path: '/api/run/run-existing' });
  assert.deepEqual(fetched, { status: 200, body: frozen });
  assert.deepEqual(Object.keys(fetched.body), ['runId', 'state', 'transcript']);
});

test('run route converts internal failures to fixed responses without private data', async () => {
  const privatePath = '/Users/private-user/.codex/session.jsonl';
  const router = createRunRouter({
    executionEnabled: true,
    startRun() { throw new Error(privatePath); },
    getRun() { throw new Error(privatePath); },
    getResumableSession: () => null,
  });
  const post = await request(router, { body: { prompt: 'x' } });
  const get = await request(router, { method: 'GET', path: '/api/run/any' });
  assert.deepEqual(post, { status: 500, body: { error: 'could not start run' } });
  assert.deepEqual(get, { status: 500, body: { error: 'could not read run' } });
  assert.equal(JSON.stringify([post, get]).includes(privatePath), false);
});

test('run POST is disabled by default and explicit opt-in preserves legacy execution', async () => {
  const calls = [];
  const dependencies = {
    startRun(options) {
      calls.push(options);
      return { runId: 'run-opt-in', sessionId: null };
    },
    getRun: () => null,
    getResumableSession: () => null,
  };

  assert.deepEqual(await request(createRunRouter(dependencies), {
    body: { prompt: 'must stay local viewer-only' },
  }), {
    status: 403,
    body: { error: 'execution disabled', errorCode: 'execution-disabled' },
  });
  assert.equal(calls.length, 0);

  assert.deepEqual(await request(createRunRouter({ ...dependencies, executionEnabled: true }), {
    body: { prompt: 'explicit legacy execution' },
  }), {
    status: 200,
    body: { runId: 'run-opt-in', sessionId: null },
  });
  assert.equal(calls.length, 1);
});

test('only CLAUDEOS_ENABLE_EXECUTION=1 enables the environment-controlled route', async () => {
  const calls = [];
  const dependencies = {
    startRun(options) {
      calls.push(options);
      return { runId: 'run-env-opt-in', sessionId: null };
    },
    getRun: () => null,
    getResumableSession: () => null,
  };

  for (const value of ['', '0', 'true', 'yes', '01']) {
    const denied = await request(createRunRouter({
      ...dependencies,
      env: { CLAUDEOS_ENABLE_EXECUTION: value },
    }), { body: { prompt: 'deny non-exact flag' } });
    assert.equal(denied.status, 403);
  }
  const enabled = await request(createRunRouter({
    ...dependencies,
    env: { CLAUDEOS_ENABLE_EXECUTION: '1' },
  }), { body: { prompt: 'exact environment opt-in' } });
  assert.deepEqual(enabled, {
    status: 200,
    body: { runId: 'run-env-opt-in', sessionId: null },
  });
  assert.equal(calls.length, 1);
});
