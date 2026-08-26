import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import * as runner from '../server/lib/runner.js';
import * as bus from '../server/lib/bus.js';
import { buildClaudeArgs as adapterBuildClaudeArgs } from '../server/lib/run-adapters/claude.js';
import { createResumeRegistry } from '../server/lib/resume-registry.js';

const UUID = 'a4f1ae04-849a-4db5-aa49-4e1de96cac8';
const CODEX_UUID = '019c9a3e-1234-7abc-8def-123456789abc';
const PRIVATE_HOME = '/Users/synthetic-private-user';
const PRIVATE_TOKEN = 'syntheticsecretvalue123456';

function collectStrings(value, out = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    out.push(key);
    collectStrings(descriptor.value, out, seen);
  }
  return out;
}

function assertNoPrivateFixture(value) {
  for (const string of collectStrings(value)) {
    assert.equal(string.includes(PRIVATE_HOME), false);
    assert.equal(string.includes(PRIVATE_TOKEN), false);
  }
}

function makeExecutable(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-runner-test-'));
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, source, { mode: 0o700 });
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeClaude(messages) {
  return makeExecutable('fake-claude', [
    '#!/usr/bin/env node',
    `const messages = ${JSON.stringify(messages)};`,
    "for (const message of messages) process.stdout.write(JSON.stringify(message) + '\\n');",
    '',
  ].join('\n'));
}

async function withClaudeBin(bin, fn) {
  const previous = process.env.CLAUDEOS_CLAUDE_BIN;
  process.env.CLAUDEOS_CLAUDE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDEOS_CLAUDE_BIN;
    else process.env.CLAUDEOS_CLAUDE_BIN = previous;
  }
}

async function waitForRun(runId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = runner.getRun(runId);
    if (run && run.state !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`fixture run ${runId} did not settle`);
}

function fakeChild(spec = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdinText = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => { child.stdinText += chunk; });
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (spec.closeOnKill !== false) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => {
    if (spec.waitForKill) return;
    for (const chunk of spec.stdout ?? []) child.stdout.write(chunk);
    for (const chunk of spec.stderr ?? []) child.stderr.write(chunk);
    if (spec.error) child.emit('error', spec.error);
    child.emit('close', spec.code ?? 0, spec.signal ?? null);
  });
  return child;
}

function makeManager({ children = [], claudeBin = '/fixture/claude', codexBin = '/fixture/codex', ...options } = {}) {
  const spawns = [];
  const manager = runner.createRunManager({
    spawnProcess(bin, args, spawnOptions) {
      const child = fakeChild(children.shift() ?? {});
      spawns.push({ bin, args, options: spawnOptions, child });
      return child;
    },
    resolveClaudeBinary: () => claudeBin,
    resolveCodexBinary: () => codexBin,
    ...options,
  });
  return { manager, spawns };
}

async function collectTerminal(manager, request) {
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const unsubscribe = bus.onEvent((type, payload) => {
    if (payload?.runId !== started?.runId) return;
    events.push({ type, payload });
    if (type === 'run.done') resolveDone(payload);
  });
  let started;
  try {
    started = manager.startRun(request);
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('fixture run did not settle')), 1000)),
    ]);
    return { started, events, run: manager.getRun(started.runId) };
  } finally {
    unsubscribe();
  }
}

test('NDJSON parser drops complete and partial records above one MiB then resynchronizes', () => {
  const normal = { type: 'turn.completed', usage: {} };
  const completeMessages = [];
  const completeParser = runner.createNdjsonParser((message) => completeMessages.push(message));
  const oversizedComplete = JSON.stringify({
    type: 'item.completed',
    padding: 'x'.repeat((1024 * 1024) + 32),
  });
  completeParser.feed(`${oversizedComplete}\n${JSON.stringify(normal)}\n`);
  completeParser.flush();
  assert.deepEqual(completeMessages, [normal]);

  const partialMessages = [];
  const partialParser = runner.createNdjsonParser((message) => partialMessages.push(message));
  partialParser.feed(`{"type":"item.completed","padding":"${'y'.repeat((1024 * 1024) + 32)}`);
  partialParser.feed(`tail"}\n${JSON.stringify(normal)}\n`);
  partialParser.flush();
  assert.deepEqual(partialMessages, [normal]);
});

test('runner re-exports the exact Claude argv builder function reference', () => {
  assert.strictEqual(runner.buildClaudeArgs, adapterBuildClaudeArgs);
});

test('client scrubber skips hostile code and produces a redacted JSON-safe clone', () => {
  assert.equal(typeof bus.scrubForClient, 'function');
  let getterCalls = 0;
  let serializerCalls = 0;
  const prototype = {
    inherited: `token=${PRIVATE_TOKEN}`,
    toJSON() {
      serializerCalls += 1;
      return `token=${PRIVATE_TOKEN}`;
    },
  };
  const payload = Object.create(prototype);
  Object.defineProperties(payload, {
    safe: { enumerable: true, value: 'kept' },
    [`${PRIVATE_HOME}/dynamic-key`]: {
      enumerable: true,
      value: { secret: `token=${PRIVATE_TOKEN}`, count: 7 },
    },
    getter: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return `token=${PRIVATE_TOKEN}`;
      },
    },
    toJSON: {
      enumerable: true,
      value() {
        serializerCalls += 1;
        return `token=${PRIVATE_TOKEN}`;
      },
    },
    self: { enumerable: true, writable: true, value: null },
  });
  payload.self = payload;

  const clean = bus.scrubForClient(payload);

  assert.equal(getterCalls, 0);
  assert.equal(serializerCalls, 0);
  assert.equal(Object.getPrototypeOf(clean), null);
  assert.equal(clean.safe, 'kept');
  assert.equal(clean['~/dynamic-key'].count, 7);
  assert.equal(clean['~/dynamic-key'].secret, 'token=[redacted]');
  assert.equal(clean.self, null);
  assert.equal(Object.hasOwn(clean, 'getter'), false);
  assert.equal(Object.hasOwn(clean, 'toJSON'), false);
  assert.doesNotThrow(() => JSON.stringify(clean));
  assertNoPrivateFixture(clean);

  const descriptorTrap = new Proxy({}, {
    ownKeys() { throw new Error(`token=${PRIVATE_TOKEN}`); },
  });
  assert.equal(bus.scrubForClient(descriptorTrap), null);
});

test('GET transcript recursively redacts tool names, usage keys, and usage values', async () => {
  const fixture = makeFakeClaude([
    {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: `token=${PRIVATE_TOKEN}`,
          input: { path: `${PRIVATE_HOME}/workspace`, safe: 'kept' },
        }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'safe result',
      usage: {
        [`${PRIVATE_HOME}/usage-key`]: {
          [`token=${PRIVATE_TOKEN}`]: `token=${PRIVATE_TOKEN}`,
          count: 7,
          cached: true,
        },
      },
      total_cost_usd: 1.25,
    },
  ]);

  try {
    const run = await withClaudeBin(fixture.bin, async () => {
      const started = runner.startRun({ prompt: 'local fixture only' });
      return waitForRun(started.runId);
    });

    assert.equal(run.state, 'done');
    assertNoPrivateFixture(run);
    const tool = run.transcript.find((entry) => entry.kind === 'tool');
    const done = run.transcript.find((entry) => entry.kind === 'done');
    assert.ok(tool);
    assert.ok(done);
    assert.equal(tool.toolName, 'token=[redacted]');
    assert.match(tool.input, /"path":"~\/workspace"/);
    assert.equal(done.result, 'safe result');
    assert.equal(done.costUsd, 1.25);
    assert.deepEqual(Object.keys(done.usage), ['~/usage-key']);
    assert.equal(done.usage['~/usage-key']['token=[redacted]'], 'token=[redacted]');
    assert.equal(done.usage['~/usage-key'].count, 7);
    assert.equal(done.usage['~/usage-key'].cached, true);
    assert.doesNotThrow(() => JSON.stringify(run));
  } finally {
    fixture.cleanup();
  }
});

test('tool input serialization never invokes an inherited toJSON hook', async () => {
  const fixture = makeFakeClaude([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { safe: 'kept' } }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'safe result',
      usage: null,
      total_cost_usd: 0,
    },
  ]);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let serializerCalls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() {
      serializerCalls += 1;
      return `token=${PRIVATE_TOKEN}`;
    },
  });

  try {
    const run = await withClaudeBin(fixture.bin, async () => {
      const started = runner.startRun({ prompt: 'local fixture only' });
      return waitForRun(started.runId);
    });
    const tool = run.transcript.find((entry) => entry.kind === 'tool');
    assert.ok(tool);
    assert.equal(serializerCalls, 0);
    assert.equal(tool.input, '{"safe":"kept"}');
    assertNoPrivateFixture(run);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
    else delete Object.prototype.toJSON;
    fixture.cleanup();
  }
});

test('runner caps every post-redaction tool input at five hundred characters', async () => {
  const fixture = makeFakeClaude([
    {
      type: 'assistant',
      message: { content: [{
        type: 'tool_use',
        name: 'Read',
        input: { value: `${'x'.repeat(700)} token=${PRIVATE_TOKEN}` },
      }] },
    },
    {
      type: 'result', subtype: 'success', is_error: false,
      result: 'safe result', usage: null, total_cost_usd: 0,
    },
  ]);

  try {
    const run = await withClaudeBin(fixture.bin, async () => {
      const started = runner.startRun({ prompt: 'local fixture only' });
      return waitForRun(started.runId);
    });
    const tool = run.transcript.find((entry) => entry.kind === 'tool');
    assert.ok(tool);
    assert.equal(tool.input.length, 500);
    assert.equal(tool.input.includes(PRIVATE_TOKEN), false);
  } finally {
    fixture.cleanup();
  }
});

test('getRun returns deep serializer-safe clones that cannot mutate stored transcript data', async () => {
  const fixture = makeFakeClaude([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { safe: 'kept' } }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'safe result',
      usage: { nested: { count: 7 } },
      total_cost_usd: 0,
    },
  ]);

  try {
    const runId = await withClaudeBin(fixture.bin, async () => {
      const started = runner.startRun({ prompt: 'local fixture only' });
      await waitForRun(started.runId);
      return started.runId;
    });
    const first = runner.getRun(runId);
    const firstTool = first.transcript.find((entry) => entry.kind === 'tool');
    const firstDone = first.transcript.find((entry) => entry.kind === 'done');
    let getterCalls = 0;
    let serializerCalls = 0;
    Object.defineProperties(firstTool, {
      hostile: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return `token=${PRIVATE_TOKEN}`;
        },
      },
      toJSON: {
        enumerable: true,
        value() {
          serializerCalls += 1;
          return `token=${PRIVATE_TOKEN}`;
        },
      },
    });
    firstTool.self = firstTool;
    firstDone.usage.nested.count = 999;
    firstDone.usage[`token=${PRIVATE_TOKEN}`] = `token=${PRIVATE_TOKEN}`;

    const second = runner.getRun(runId);
    const secondTool = second.transcript.find((entry) => entry.kind === 'tool');
    const secondDone = second.transcript.find((entry) => entry.kind === 'done');
    assert.equal(getterCalls, 0);
    assert.equal(serializerCalls, 0);
    assert.equal(Object.hasOwn(secondTool, 'hostile'), false);
    assert.equal(Object.hasOwn(secondTool, 'toJSON'), false);
    assert.equal(Object.hasOwn(secondTool, 'self'), false);
    assert.equal(secondDone.usage.nested.count, 7);
    assert.equal(Object.hasOwn(secondDone.usage, 'token=[redacted]'), false);

    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() {
        serializerCalls += 1;
        return `token=${PRIVATE_TOKEN}`;
      },
    });
    try {
      const json = JSON.stringify(second);
      assert.equal(serializerCalls, 0);
      assert.equal(json.includes(PRIVATE_TOKEN), false);
      assert.match(json, /"count":7/);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
      else delete Object.prototype.toJSON;
    }
  } finally {
    fixture.cleanup();
  }
});

test('spawn-error transcript redacts the failing executable path', async () => {
  const fixture = makeExecutable(
    `token=${PRIVATE_TOKEN}`,
    '#!/definitely/not/an/installed/interpreter\n',
  );

  try {
    const run = await withClaudeBin(fixture.bin, async () => {
      const started = runner.startRun({ prompt: 'local invalid-shebang fixture only' });
      return waitForRun(started.runId);
    });

    assert.equal(run.state, 'error');
    assertNoPrivateFixture(run);
    const done = run.transcript.find((entry) => entry.kind === 'done');
    assert.ok(done);
    assert.match(done.result, /^claude CLI failed to start:/);
    assert.equal(done.result.includes(PRIVATE_TOKEN), false);
    assert.doesNotThrow(() => JSON.stringify(run));
  } finally {
    fixture.cleanup();
  }
});

test('provider runner selects binaries, confines stdin execution, and detects Git membership', async () => {
  const gitRoot = fs.mkdtempSync(path.join(path.dirname(process.cwd()), '.task5-git-fixture-'));
  fs.mkdirSync(path.join(gitRoot, '.git'));
  const children = [
    { stdout: ['{"type":"turn.completed","usage":{}}\n'] },
    { stdout: ['{"type":"turn.completed","usage":{}}\n'] },
  ];
  const { manager, spawns } = makeManager({ children });
  try {
    await collectTerminal(manager, { prompt: 'outside git', provider: 'codex', cwd: process.cwd() });
    await collectTerminal(manager, { prompt: 'inside git', provider: 'codex', cwd: gitRoot });
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns.map((entry) => entry.bin), ['/fixture/codex', '/fixture/codex']);
    assert.equal(spawns[0].args.includes('--skip-git-repo-check'), true);
    assert.equal(spawns[1].args.includes('--skip-git-repo-check'), false);
    assert.equal(spawns[0].args.includes('outside git'), false);
    assert.equal(spawns[0].child.stdinText, 'outside git');
    assert.equal(spawns[0].options.shell, false);
    assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(spawns[0].args.includes('workspace-write'), true);
    assert.equal(spawns[0].args.includes('never'), true);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

test('captured Codex session is canonical, registered, and resumes only in original real cwd', async () => {
  const registry = createResumeRegistry();
  const children = [
    { stdout: [
      `{"type":"thread.started","thread_id":"${CODEX_UUID}"}\n`,
      '{"type":"turn.completed","usage":{}}\n',
    ] },
    { stdout: ['{"type":"turn.completed","usage":{}}\n'] },
  ];
  const { manager, spawns } = makeManager({ children, resumeRegistry: registry });
  const originalCwd = fs.realpathSync(process.cwd());
  const callerCwd = path.dirname(originalCwd);

  const first = await collectTerminal(manager, {
    prompt: 'new', provider: 'codex', cwd: originalCwd,
  });
  assert.deepEqual({
    started: first.events.filter(({ type }) => type === 'run.started').length,
    done: first.events.filter(({ type }) => type === 'run.done').length,
  }, { started: 1, done: 1 });
  assert.deepEqual(manager.getResumableSession(CODEX_UUID), {
    provider: 'codex', cwd: originalCwd, capturedAt: manager.getResumableSession(CODEX_UUID).capturedAt,
  });
  assert.equal(first.events.find(({ type }) => type === 'run.done').payload.sessionId, CODEX_UUID);

  const resumed = await collectTerminal(manager, {
    prompt: 'continue', provider: 'codex', cwd: callerCwd, resumeSessionId: CODEX_UUID,
  });
  assert.deepEqual({
    started: resumed.events.filter(({ type }) => type === 'run.started').length,
    done: resumed.events.filter(({ type }) => type === 'run.done').length,
  }, { started: 1, done: 1 });
  assert.equal(spawns[1].options.cwd, originalCwd);
  assert.deepEqual(spawns[1].args.slice(-3), ['--json', CODEX_UUID, '-']);
  assert.equal(resumed.events.find(({ type }) => type === 'run.started').payload.provider, 'codex');
  assert.equal(resumed.events.find(({ type }) => type === 'run.done').payload.sessionId, CODEX_UUID);
  assert.deepEqual(Object.keys(manager.getRun(resumed.started.runId)), ['runId', 'state', 'transcript']);
});

test('unknown, expired, and option-like direct resumes never emit caller text as session provenance', async (t) => {
  for (const resumeSessionId of [CODEX_UUID, '--last', 'not-a-session']) {
    await t.test(resumeSessionId, async () => {
      const registry = createResumeRegistry();
      const { manager, spawns } = makeManager({ resumeRegistry: registry });
      const result = await collectTerminal(manager, {
        prompt: 'continue', provider: 'codex', resumeSessionId,
      });
      assert.equal(spawns.length, 0);
      const doneEvents = result.events.filter(({ type }) => type === 'run.done');
      assert.equal(doneEvents.length, 1);
      assert.deepEqual({
        ok: doneEvents[0].payload.ok,
        errorCode: doneEvents[0].payload.errorCode,
        sessionId: doneEvents[0].payload.sessionId,
      }, { ok: false, errorCode: 'run-failed', sessionId: null });
      assert.notEqual(doneEvents[0].payload.sessionId, resumeSessionId);
    });
  }
});

test('explicit authentication failure remains sticky when completion follows', async () => {
  const { manager } = makeManager({ children: [{ stdout: [
    '{"type":"error","message":"authentication required"}\n',
    '{"type":"turn.completed","usage":{"input_tokens":7}}\n',
  ] }] });
  const result = await collectTerminal(manager, {
    prompt: 'conflicting terminal records', provider: 'codex', cwd: process.cwd(),
  });
  const started = result.events.filter(({ type }) => type === 'run.started');
  const done = result.events.filter(({ type }) => type === 'run.done');
  assert.deepEqual({ started: started.length, done: done.length }, { started: 1, done: 1 });
  assert.equal(done[0].payload.ok, false);
  assert.equal(done[0].payload.errorCode, 'authentication-required');
  assert.equal(done[0].payload.sessionId, null);
});

test('terminal paths emit exactly one started/done with bounded provider error codes', async (t) => {
  const stderrToken = PRIVATE_TOKEN;
  const cases = [
    {
      name: 'Claude success', provider: 'claude', expectedOk: true, expectedCode: null,
      child: { stdout: ['{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{},"total_cost_usd":0}\n'] },
    },
    {
      name: 'Codex success warning', provider: 'codex', expectedOk: true, expectedCode: null,
      child: { stdout: ['{"type":"turn.completed","usage":{}}\n'], stderr: [`token=${stderrToken} ${PRIVATE_HOME}\n`] },
    },
    {
      name: 'unavailable Codex binary', provider: 'codex', expectedOk: false,
      expectedCode: 'cli-unavailable', codexBin: null, child: null,
    },
    {
      name: 'Codex authentication error', provider: 'codex', expectedOk: false,
      expectedCode: 'authentication-required',
      child: { stdout: ['{"type":"error","message":"authentication required"}\n'] },
    },
    {
      name: 'malformed JSONL then valid terminal line', provider: 'codex', expectedOk: true,
      expectedCode: null,
      child: { stdout: ['not-json\n{"type":"turn.completed","usage":{}}\n'] },
    },
    {
      name: 'generic non-zero close', provider: 'codex', expectedOk: false,
      expectedCode: 'run-failed',
      child: { code: 7, stderr: [`token=${stderrToken} ${PRIVATE_HOME}\n`] },
    },
    {
      name: 'timeout', provider: 'codex', expectedOk: false, expectedCode: 'run-failed',
      child: { waitForKill: true }, runTimeoutMs: 5,
    },
    {
      name: 'child error followed by close', provider: 'codex', expectedOk: false,
      expectedCode: 'run-failed',
      child: { error: new Error(`token=${stderrToken} ${PRIVATE_HOME}`), code: 1 },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { manager, spawns } = makeManager({
        children: fixture.child ? [fixture.child] : [],
        codexBin: fixture.codexBin === null ? null : '/fixture/codex',
        runTimeoutMs: fixture.runTimeoutMs,
      });
      const result = await collectTerminal(manager, {
        prompt: 'bounded terminal fixture', provider: fixture.provider, cwd: process.cwd(),
      });
      const started = result.events.filter(({ type }) => type === 'run.started');
      const done = result.events.filter(({ type }) => type === 'run.done');
      assert.deepEqual({ started: started.length, done: done.length }, { started: 1, done: 1 });
      assert.equal(started[0].payload.provider, fixture.provider);
      assert.equal(done[0].payload.provider, fixture.provider);
      assert.equal(done[0].payload.ok, fixture.expectedOk);
      assert.equal(done[0].payload.errorCode, fixture.expectedCode);
      assert.equal(JSON.stringify(result.events).includes(stderrToken), false);
      assert.equal(JSON.stringify(result.events).includes(PRIVATE_HOME), false);
      if (fixture.child === null) assert.equal(spawns.length, 0);
      else assert.equal(spawns[0].bin, fixture.provider === 'codex' ? '/fixture/codex' : '/fixture/claude');
    });
  }
});

test('failed runs keep only an 8 KiB rolling stderr window and an 800-character safe tail', async () => {
  const droppedPrefix = 'DROP_THIS_STDERR_PREFIX';
  const privateTail = `token=${PRIVATE_TOKEN} ${PRIVATE_HOME}`;
  const stderr = `${droppedPrefix}${'x'.repeat(9_000)}\n${privateTail}`;
  const { manager } = makeManager({ children: [{ code: 2, stderr: [stderr] }] });
  const result = await collectTerminal(manager, {
    prompt: 'stderr bounds', provider: 'codex', cwd: process.cwd(),
  });
  const done = result.events.find(({ type }) => type === 'run.done').payload;
  assert.equal(done.ok, false);
  assert.equal(done.errorCode, 'run-failed');
  assert.equal(done.result.includes(droppedPrefix), false);
  assert.equal(done.result.includes(PRIVATE_TOKEN), false);
  assert.equal(done.result.includes(PRIVATE_HOME), false);
  assert.match(done.result, /\[stderr\]/);
  assert.ok(done.result.length <= 900, done.result.length);
});
