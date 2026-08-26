import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let port;
let serverProcess;
let childOutput = '';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnostic(message) {
  return `${message}${childOutput ? `\nserver output:\n${childOutput}` : ''}`;
}

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return address.port;
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawRequest(path, { host } = {}) {
  return request(path, { headers: { host } });
}

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverProcess.exitCode !== null) throw new Error(diagnostic('test server exited before health check'));
    try {
      const res = await request('/api/health');
      if (res.status === 200) return;
      lastError = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(50);
  }
  throw new Error(diagnostic(`test server did not become healthy: ${lastError?.message ?? 'unknown error'}`));
}

before(async () => {
  port = await getFreePort();
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAUDEOS_PORT: String(port),
      CLAUDEOS_CLAUDE_BIN: '/usr/bin/false',
      CLAUDEOS_ENABLE_EXECUTION: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    childOutput = (childOutput + String(chunk)).slice(-8192);
  };
  serverProcess.stdout.on('data', capture);
  serverProcess.stderr.on('data', capture);
  await waitForHealth();
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, 'exit');
  serverProcess.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(3000).then(() => true),
  ]);
  if (!timedOut || serverProcess.exitCode !== null) return;
  const killed = once(serverProcess, 'exit');
  serverProcess.kill('SIGKILL');
  await killed;
});

test('rejects a foreign Origin before a text/plain run body can execute', async () => {
  const res = await request('/api/run', {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid', 'content-type': 'text/plain' },
    body: JSON.stringify({ prompt: 'must not run', model: 'invalid-test-model' }),
  });

  assert.equal(res.status, 403);
});

test('rejects non-loopback Host headers', async () => {
  const res = await rawRequest('/api/health', { host: `attacker.invalid:${port}` });

  assert.equal(res.status, 403);
});

test('sets a restrictive CSP for the local app', async () => {
  const res = await request('/api/health');

  assert.equal(
    res.headers['content-security-policy'],
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
  );
});

test('keeps scripts self-only while explicitly permitting style attributes', async () => {
  const res = await request('/api/health');
  const csp = res.headers['content-security-policy'];

  assert.match(csp, /(?:^|;) script-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /(?:^|;) style-src-attr 'unsafe-inline'(?:;|$)/);
});

test('default server denies same-origin run POST before execution validation', async () => {
  const res = await request('/api/run', {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: '' }),
  });

  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'execution disabled', errorCode: 'execution-disabled',
  });
});

test('default viewer rejects every run body before JSON parsing', async () => {
  const headers = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
  };
  const expected = {
    status: 403,
    body: { error: 'execution disabled', errorCode: 'execution-disabled' },
  };

  for (const body of [
    '{',
    '',
    JSON.stringify({ prompt: 'x'.repeat((1024 * 1024) + 1) }),
  ]) {
    const res = await request('/api/run', { method: 'POST', headers, body });
    assert.deepEqual({ status: res.status, body: JSON.parse(res.body) }, expected);
  }
});

test('default live run route denies every provider and resume shape uniformly', async () => {
  const headers = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
  };
  const unknown = await request('/api/run', {
    method: 'POST', headers,
    body: JSON.stringify({ prompt: 'x', provider: 'unknown' }),
  });
  const expired = await request('/api/run', {
    method: 'POST', headers,
    body: JSON.stringify({
      prompt: 'x', provider: 'codex',
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
    }),
  });

  assert.deepEqual({ status: unknown.status, body: JSON.parse(unknown.body) }, {
    status: 403,
    body: { error: 'execution disabled', errorCode: 'execution-disabled' },
  });
  assert.deepEqual({ status: expired.status, body: JSON.parse(expired.body) }, {
    status: 403,
    body: { error: 'execution disabled', errorCode: 'execution-disabled' },
  });
});

test('health identifies local viewer mode and both filesystem sources', async () => {
  const res = await request('/api/health');
  const body = JSON.parse(res.body);

  assert.equal(body.mode, 'viewer');
  assert.equal(body.executionEnabled, false);
  assert.deepEqual(body.sources, ['.claude', '.codex']);
});
