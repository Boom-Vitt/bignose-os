import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Keep config initialisation hermetic: never consult the user's persisted hook
// token while loading the production modules under test.
process.env.CLAUDEOS_HOOK_TOKEN = 'synthetic-hook-token-for-tests';
process.env.CLAUDEOS_CODEX_BIN = path.join(os.tmpdir(), 'missing-codex-for-redaction-tests');

const { default: chokidar } = await import('chokidar');
const { CONFIG } = await import('../server/lib/config.js');
const bus = await import('../server/lib/bus.js');
const jobsModule = await import('../server/lib/jobs.js');
const catalogModule = await import('../server/lib/catalog.js');
const scannerModule = await import('../server/lib/scanner.js');
const runnerModule = await import('../server/lib/runner.js');

const PRIVATE_HOME = '/Users/synthetic-private-user';
const PRIVATE_LINUX_HOME = '/home/synthetic-private-user';
const PRIVATE_TOKEN = 'syntheticsecretvalue123456';
const PRIVATE_TOKEN_ALT = 'syntheticsecretvalue654321';

const JOB_KEYS = [
  'id', 'name', 'state', 'tempo', 'detail', 'cwd', 'sessionId',
  'createdAt', 'updatedAt', 'tokens', 'inFlight', 'fan', 'needs',
  'suggestedReply', 'timeline',
];

const SKILL_KEYS = [
  'name', 'description', 'scope', 'path', 'argumentHint', 'allowedTools',
  'userInvokable', 'disableModelInvocation', 'model', 'effort', 'provider',
];

const AGENT_KEYS = ['name', 'description', 'model', 'tools', 'memory', 'path', 'provider'];
const ROUTINE_KEYS = [
  'id', 'name', 'schedule', 'runner', 'lastRunAt', 'nextRunAt', 'status',
  'provider',
];

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
  return out;
}

function assertNoFixtureLeaks(value) {
  for (const string of collectStrings(value)) {
    assert.equal(string.includes(PRIVATE_HOME), false);
    assert.equal(string.includes(PRIVATE_LINUX_HOME), false);
    assert.equal(string.includes(PRIVATE_TOKEN), false);
    assert.equal(string.includes(PRIVATE_TOKEN_ALT), false);
  }
}

function toComparable(value) {
  if (Array.isArray(value)) return value.map(toComparable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = toComparable(item);
    return out;
  }
  return value;
}

function installPrototypeToJSON(prototype, hook) {
  const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
  Object.defineProperty(prototype, 'toJSON', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: hook,
  });
  return () => {
    if (previous) Object.defineProperty(prototype, 'toJSON', previous);
    else delete prototype.toJSON;
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureConsoleWarnings() {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  return {
    warnings,
    restore() { console.warn = original; },
  };
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeResponse(writeResults = []) {
  const chunks = [];
  const handlers = new Map();
  let writes = 0;
  let endCalls = 0;

  return {
    chunks,
    handlers,
    get endCalls() { return endCalls; },
    setHeader() {},
    flushHeaders() {},
    setTimeout() {},
    socket: { setNoDelay() {} },
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    write(chunk) {
      chunks.push(String(chunk));
      const result = writeResults[writes];
      writes += 1;
      return result === undefined ? true : result;
    },
    end() {
      endCalls += 1;
    },
  };
}

function parseFrame(chunk) {
  assert.match(chunk, /^data: /);
  return JSON.parse(chunk.slice('data: '.length).trim());
}

test('SSE recursively redacts its payload for clients and listeners', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  const detach = bus.attach(response);

  try {
    const payload = {
      cwd: `${PRIVATE_HOME}/.claude`,
      nullable: null,
      nested: {
        [`${PRIVATE_HOME}/dynamic-key`]: [
          `token=${PRIVATE_TOKEN}`,
          { path: `${PRIVATE_HOME}/nested` },
        ],
      },
    };

    bus.emit('hook.event', payload);

    assert.equal(response.chunks.length, 2);
    const envelope = parseFrame(response.chunks[1]);
    assert.deepEqual(Object.keys(envelope), ['type', 'ts', 'payload']);
    assert.equal(envelope.type, 'hook.event');
    assert.equal(typeof envelope.ts, 'number');
    assert.equal(envelope.payload.nullable, null);
    assertNoFixtureLeaks(envelope);

    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, envelope.type);
    assert.deepEqual(toComparable(heard[0].payload), envelope.payload);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
  }
});

test('SSE omits executable serializer hooks without invoking them', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  const detach = bus.attach(response);
  let serializerCalls = 0;

  try {
    const payload = {
      safe: 'kept',
      toJSON() {
        serializerCalls += 1;
        return `${PRIVATE_HOME}/serializer-bypass`;
      },
      functionField() {
        serializerCalls += 1;
      },
      symbolField: Symbol(`${PRIVATE_HOME}/symbol`),
      undefinedField: undefined,
      values: [() => { serializerCalls += 1; }, Symbol('hidden'), undefined, 'kept'],
    };

    bus.emit('run.tool', payload);

    assert.equal(serializerCalls, 0);
    const envelope = parseFrame(response.chunks[1]);
    assert.deepEqual(envelope.payload, {
      safe: 'kept',
      values: [null, null, null, 'kept'],
    });
    assertNoFixtureLeaks(envelope);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.deepEqual(toComparable(heard[0].payload), envelope.payload);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
  }
});

test('SSE and listeners never invoke Object.prototype.toJSON', () => {
  bus.closeAll();
  let serializerCalls = 0;
  const restore = installPrototypeToJSON(Object.prototype, () => {
    serializerCalls += 1;
    return `${PRIVATE_HOME}/object-prototype-bypass`;
  });
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  let detach = () => {};

  try {
    detach = bus.attach(response);
    bus.emit('run.tool', { nested: { path: `${PRIVATE_HOME}/object-value` } });

    assert.equal(serializerCalls, 0);
    assertNoFixtureLeaks(response.chunks);
    const envelope = parseFrame(response.chunks[1]);
    assertNoFixtureLeaks(envelope);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.deepEqual(toComparable(heard[0].payload), envelope.payload);
    assert.equal(Object.getPrototypeOf(heard[0].payload), null);
    assert.equal(Object.getPrototypeOf(heard[0].payload.nested), null);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
    restore();
  }
});

test('SSE and listeners never invoke Array.prototype.toJSON', () => {
  bus.closeAll();
  let serializerCalls = 0;
  const restore = installPrototypeToJSON(Array.prototype, () => {
    serializerCalls += 1;
    return `${PRIVATE_HOME}/array-prototype-bypass`;
  });
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  let detach = () => {};

  try {
    detach = bus.attach(response);
    bus.emit('run.tool', [`${PRIVATE_HOME}/array-value`]);

    assert.equal(serializerCalls, 0);
    assertNoFixtureLeaks(response.chunks);
    const envelope = parseFrame(response.chunks[1]);
    assertNoFixtureLeaks(envelope);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.deepEqual(toComparable(heard[0].payload), envelope.payload);
    const descriptor = Object.getOwnPropertyDescriptor(heard[0].payload, 'toJSON');
    assert.ok(descriptor);
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.value, undefined);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
    restore();
  }
});

test('SSE and listeners never invoke BigInt.prototype.toJSON', () => {
  bus.closeAll();
  let serializerCalls = 0;
  const restore = installPrototypeToJSON(BigInt.prototype, () => {
    serializerCalls += 1;
    return `${PRIVATE_HOME}/bigint-prototype-bypass`;
  });
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  let detach = () => {};

  try {
    detach = bus.attach(response);
    bus.emit('run.tool', 7n);

    assert.equal(serializerCalls, 0);
    assertNoFixtureLeaks(response.chunks);
    const envelope = parseFrame(response.chunks[1]);
    assert.equal(envelope.payload, null);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.equal(heard[0].payload, null);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
    restore();
  }
});

test('SSE preserves the payload envelope key for unsupported root values', () => {
  bus.closeAll();
  const response = makeResponse([true, true, true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  const detach = bus.attach(response);

  try {
    for (const value of [() => 'not-called', Symbol('unsupported'), undefined]) {
      bus.emit('run.tool', value);
    }

    assert.equal(heard.length, 3);
    for (let index = 0; index < 3; index++) {
      const envelope = parseFrame(response.chunks[index + 1]);
      assert.deepEqual(Object.keys(envelope), ['type', 'ts', 'payload']);
      assert.equal(envelope.payload, null);
      assert.equal(heard[index].type, 'run.tool');
      assert.equal(heard[index].payload, null);
    }
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
  }
});

test('SSE listeners receive the same normalized numeric values as the wire', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  const detach = bus.attach(response);

  try {
    bus.emit('run.tool', {
      finite: 1.5,
      negativeZero: -0,
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
    });

    const envelope = parseFrame(response.chunks[1]);
    const expected = {
      finite: 1.5,
      negativeZero: 0,
      nan: null,
      positiveInfinity: null,
      negativeInfinity: null,
    };
    assert.deepEqual(envelope.payload, expected);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.deepEqual(toComparable(heard[0].payload), expected);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
  }
});

test('SSE sends the exact null-payload fallback when a descriptor trap throws null', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const diagnostics = captureConsoleWarnings();
  const rawType = `hook.event ${PRIVATE_HOME}/proxy`;
  const payload = new Proxy({ path: `${PRIVATE_HOME}/hidden` }, {
    ownKeys() { return ['path']; },
    getOwnPropertyDescriptor() { throw null; },
  });
  let detach = () => {};

  try {
    detach = bus.attach(response);
    assert.doesNotThrow(() => bus.emit(rawType, payload));

    assert.equal(response.chunks.length, 2);
    const envelope = parseFrame(response.chunks[1]);
    assert.deepEqual(Object.keys(envelope), ['type', 'ts', 'payload']);
    assert.equal(envelope.type, 'hook.event ~/proxy');
    assert.equal(typeof envelope.ts, 'number');
    assert.equal(envelope.payload, null);
    assertNoFixtureLeaks(envelope);
    assertNoFixtureLeaks(diagnostics.warnings);
  } finally {
    detach();
    bus.closeAll();
    diagnostics.restore();
  }
});

test('a listener throwing null or a hostile value cannot stop later listeners', () => {
  bus.closeAll();
  const diagnostics = captureConsoleWarnings();
  const hostileThrownValue = new Proxy(Object.create(null), {
    get() { throw null; },
  });
  let thrownValue = null;
  const heard = [];
  const unsubscribeFirst = bus.onEvent(() => { throw thrownValue; });
  const unsubscribeSecond = bus.onEvent((type, payload) => heard.push({ type, payload }));

  try {
    assert.doesNotThrow(() => bus.emit('run.tool', { path: `${PRIVATE_HOME}/first` }));
    thrownValue = hostileThrownValue;
    assert.doesNotThrow(() => bus.emit('run.tool', { path: `${PRIVATE_HOME}/second` }));
    thrownValue = new Error(`${PRIVATE_HOME}/diagnostic`);
    assert.doesNotThrow(() => bus.emit('run.tool', { path: `${PRIVATE_HOME}/third` }));

    assert.equal(heard.length, 3);
    for (const entry of heard) {
      assert.equal(entry.type, 'run.tool');
      assertNoFixtureLeaks(entry.payload);
    }
    assert.equal(diagnostics.warnings.length, 3);
    assertNoFixtureLeaks(diagnostics.warnings);
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    bus.closeAll();
    diagnostics.restore();
  }
});

test('attach returns a detach function and no client when response setup throws null', () => {
  bus.closeAll();
  const diagnostics = captureConsoleWarnings();
  const response = makeResponse();
  response.setHeader = () => { throw null; };
  let detach;

  try {
    assert.doesNotThrow(() => { detach = bus.attach(response); });
    assert.equal(typeof detach, 'function');
    assert.equal(bus.clientCount(), 0);
    assert.doesNotThrow(() => detach());
    assertNoFixtureLeaks(diagnostics.warnings);
  } finally {
    bus.closeAll();
    diagnostics.restore();
  }
});

test('SSE preserves values whose raw object keys collide after redaction', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  const detach = bus.attach(response);

  try {
    bus.emit('run.tool', {
      input: {
        [`${PRIVATE_HOME}/collision`]: 'first-value',
        [`${PRIVATE_LINUX_HOME}/collision`]: 'second-value',
      },
    });

    const envelope = parseFrame(response.chunks[1]);
    const keys = Object.keys(envelope.payload.input);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(Object.values(envelope.payload.input).sort(), [
      'first-value',
      'second-value',
    ]);
    assertNoFixtureLeaks(envelope);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, 'run.tool');
    assert.deepEqual(toComparable(heard[0].payload), envelope.payload);
  } finally {
    unsubscribe();
    detach();
    bus.closeAll();
  }
});

test('SSE drops and ends a client as soon as write reports backpressure', () => {
  bus.closeAll();
  const response = makeResponse([true, false]);
  const detach = bus.attach(response);
  try {
    bus.emit('run.delta', { runId: 'synthetic-run', text: 'bounded' });
    assert.equal(bus.clientCount(), 0);
    assert.equal(response.endCalls, 1);
  } finally {
    detach();
    bus.closeAll();
  }
});

test('SSE redacts the envelope type itself', () => {
  bus.closeAll();
  const response = makeResponse([true, true]);
  const detach = bus.attach(response);
  try {
    bus.emit(`hook.event token=${PRIVATE_TOKEN}`, null);
    const envelope = parseFrame(response.chunks[1]);
    assert.equal(envelope.type.includes(PRIVATE_TOKEN), false);
    assert.equal(envelope.payload, null);
  } finally {
    detach();
    bus.closeAll();
  }
});

test('job DTOs redact every string field and removal ids match the exposed id', async () => {
  const fixtureHome = makeTempDir('claudeos-jobs-redaction-');
  const jobsDir = path.join(fixtureHome, '.claude', 'jobs');
  const rawJobId = `job-token=${PRIVATE_TOKEN}`;
  const rawJobIdAlt = `job-token=${PRIVATE_TOKEN_ALT}`;
  const jobDir = path.join(jobsDir, rawJobId);
  const jobDirAlt = path.join(jobsDir, rawJobIdAlt);
  const nullJobDir = path.join(jobsDir, 'null-fields');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(jobDirAlt, { recursive: true });
  fs.mkdirSync(nullJobDir, { recursive: true });

  fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify({
    name: `name ${PRIVATE_HOME}/name`,
    state: `${PRIVATE_HOME}/working`,
    tempo: `token=${PRIVATE_TOKEN}`,
    detail: `detail ${PRIVATE_HOME}/detail`,
    cwd: `${PRIVATE_HOME}/workspace`,
    sessionId: `token=${PRIVATE_TOKEN}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    tokens: 42,
    inFlight: {
      tasks: 2,
      queued: 1,
      kinds: [`${PRIVATE_HOME}/kind`, `token=${PRIVATE_TOKEN}`],
    },
    fan: [{
      id: `token=${PRIVATE_TOKEN}`,
      kind: `${PRIVATE_HOME}/fan-kind`,
      label: `${PRIVATE_HOME}/fan-label`,
      startedAt: 0,
      doneAt: 0,
    }],
    needs: `${PRIVATE_HOME}/need`,
    suggestedReply: `token=${PRIVATE_TOKEN}`,
  }), 'utf8');
  fs.writeFileSync(path.join(jobDir, 'timeline.jsonl'), `${JSON.stringify({
    at: `${PRIVATE_HOME}/at`,
    state: `token=${PRIVATE_TOKEN}`,
    detail: `${PRIVATE_HOME}/timeline-detail`,
    text: `token=${PRIVATE_TOKEN}`,
  })}\n`, 'utf8');
  fs.writeFileSync(path.join(jobDirAlt, 'state.json'), JSON.stringify({
    name: 'collision-second',
    state: 'working',
    createdAt: 1_700_000_000_500,
    updatedAt: 1_700_000_000_500,
  }), 'utf8');
  fs.writeFileSync(path.join(nullJobDir, 'state.json'), JSON.stringify({
    name: null,
    state: null,
    tempo: null,
    detail: null,
    cwd: null,
    sessionId: null,
    needs: null,
    suggestedReply: null,
  }), 'utf8');

  const originalJobsDir = CONFIG.JOBS_DIR;
  const originalWatch = chokidar.watch;
  const watchHandlers = new Map();
  const events = [];
  const unsubscribe = bus.onEvent((type, payload) => events.push({ type, payload }));

  CONFIG.JOBS_DIR = jobsDir;
  chokidar.watch = () => ({
    on(event, handler) {
      watchHandlers.set(event, handler);
      return this;
    },
  });

  try {
    jobsModule.startJobs();
    const jobs = jobsModule.listJobs();
    const job = jobs.find((entry) => entry.name?.startsWith('name '));
    const jobAlt = jobs.find((entry) => entry.name === 'collision-second');
    const nullJob = jobs.find((entry) => entry.id === 'null-fields');

    assert.ok(job);
    assert.ok(jobAlt);
    assert.deepEqual(Object.keys(job), JOB_KEYS);
    assert.deepEqual(Object.keys(jobAlt), JOB_KEYS);
    assertNoFixtureLeaks(jobs);
    assert.notEqual(job.id, rawJobId);
    assert.notEqual(jobAlt.id, rawJobIdAlt);
    assert.notEqual(job.id, jobAlt.id);
    assert.deepEqual(job.inFlight, {
      tasks: 2,
      queued: 1,
      kinds: job.inFlight.kinds,
    });
    assert.equal(job.inFlight.kinds.length, 2);
    assert.deepEqual(Object.keys(job.fan[0]), [
      'id', 'kind', 'label', 'startedAt', 'doneAt', 'ageDays',
    ]);
    assert.deepEqual(Object.keys(job.timeline[0]), ['at', 'state', 'detail', 'text']);

    assert.ok(nullJob);
    assert.equal(nullJob.id, 'null-fields');
    for (const key of [
      'name', 'state', 'tempo', 'detail', 'cwd', 'sessionId', 'needs', 'suggestedReply',
    ]) {
      assert.equal(nullJob[key], null);
    }

    const jobState = events.find((entry) =>
      entry.type === 'job.state' && entry.payload.name === job.name);
    const jobStateAlt = events.find((entry) =>
      entry.type === 'job.state' && entry.payload.name === jobAlt.name);
    assert.ok(jobState);
    assert.ok(jobStateAlt);
    assert.equal(jobState.payload.id, job.id);
    assert.equal(jobStateAlt.payload.id, jobAlt.id);

    const overlappingRawId = job.id;
    const overlappingDir = path.join(jobsDir, overlappingRawId);
    fs.mkdirSync(overlappingDir, { recursive: true });
    fs.writeFileSync(path.join(overlappingDir, 'state.json'), JSON.stringify({
      name: 'namespace-overlap-safe',
      state: 'working',
      createdAt: 1_700_000_002_000,
      updatedAt: 1_700_000_002_000,
    }), 'utf8');
    assert.equal(typeof watchHandlers.get('add'), 'function');
    watchHandlers.get('add')(path.join(overlappingDir, 'state.json'));
    await delay(400);

    const jobsAfterOverlap = jobsModule.listJobs();
    const jobAfterOverlap = jobsAfterOverlap.find((entry) => entry.name === job.name);
    const overlappingJob = jobsAfterOverlap.find((entry) => entry.name === 'namespace-overlap-safe');
    assert.ok(jobAfterOverlap);
    assert.ok(overlappingJob);
    assert.equal(jobAfterOverlap.id, job.id);
    assert.notEqual(overlappingJob.id, overlappingRawId);
    assert.notEqual(overlappingJob.id, jobAfterOverlap.id);
    assertNoFixtureLeaks(overlappingJob);

    const overlappingState = events.find((entry) =>
      entry.type === 'job.state' && entry.payload.name === overlappingJob.name);
    assert.ok(overlappingState);
    assert.equal(overlappingState.payload.id, overlappingJob.id);

    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.rmSync(jobDirAlt, { recursive: true, force: true });
    fs.rmSync(overlappingDir, { recursive: true, force: true });
    assert.equal(typeof watchHandlers.get('unlinkDir'), 'function');
    watchHandlers.get('unlinkDir')(jobDir);
    watchHandlers.get('unlinkDir')(jobDirAlt);
    watchHandlers.get('unlinkDir')(overlappingDir);

    const removedIds = events
      .filter((entry) => entry.type === 'job.removed')
      .map((entry) => entry.payload.id);
    assert.deepEqual(new Set(removedIds), new Set([job.id, jobAlt.id, overlappingJob.id]));
    assertNoFixtureLeaks(removedIds);
  } finally {
    unsubscribe();
    chokidar.watch = originalWatch;
    CONFIG.JOBS_DIR = originalJobsDir;
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
});

test('catalog builders and catalog output redact optional, list, sidecar, and routine strings while preserving nulls', async () => {
  const fixtureHome = makeTempDir('claudeos-catalog-redaction-');
  const claudeDir = path.join(fixtureHome, '.claude');
  const stateDir = path.join(fixtureHome, '.boombignose_claudeos');
  const skillsDir = path.join(claudeDir, 'skills');
  const agentsDir = path.join(claudeDir, 'agents');
  const commandsDir = path.join(claudeDir, 'commands');
  const pluginsDir = path.join(claudeDir, 'plugins');
  const scheduledDir = path.join(claudeDir, 'scheduled-tasks');
  const skillDir = path.join(skillsDir, 'fixture-skill');
  const routineDir = path.join(scheduledDir, `routine-token=${PRIVATE_TOKEN}`);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const agentPath = path.join(agentsDir, 'fixture-agent.md');
  const nullSkillPath = path.join(skillsDir, 'null-skill.md');
  const nullAgentPath = path.join(agentsDir, 'null-agent.md');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const sidecarPath = path.join(stateDir, 'sidecar.json');

  for (const dir of [
    skillDir, agentsDir, commandsDir, pluginsDir, routineDir, stateDir,
  ]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(skillPath, `---\nname: fixture-skill\ndescription: ${PRIVATE_HOME}/description\nargument-hint: ${PRIVATE_HOME}/argument\nallowed-tools:\n  - Read ${PRIVATE_HOME}/tool\n  - token=${PRIVATE_TOKEN}\nmodel: ${PRIVATE_HOME}/frontmatter-model-must-not-win\neffort: ${PRIVATE_HOME}/frontmatter-effort-must-not-win\n---\n`, 'utf8');
  fs.writeFileSync(nullSkillPath, '---\nname: null-skill\ndescription: plain\n---\n', 'utf8');
  fs.writeFileSync(agentPath, `---\nname: fixture-agent\ndescription: ${PRIVATE_HOME}/agent-description\nmodel: ${PRIVATE_HOME}/agent-model\ntools:\n  - Read ${PRIVATE_HOME}/agent-tool\n  - token=${PRIVATE_TOKEN}\nmemory: ${PRIVATE_HOME}/agent-memory\n---\n`, 'utf8');
  fs.writeFileSync(nullAgentPath, '---\nname: null-agent\ndescription: plain\n---\n', 'utf8');
  fs.writeFileSync(path.join(routineDir, 'SKILL.md'), `---\nname: ${PRIVATE_HOME}/routine-name\n---\n`, 'utf8');
  fs.writeFileSync(path.join(routineDir, 'config.json'), JSON.stringify({
    schedule: `${PRIVATE_HOME}/routine-schedule`,
  }), 'utf8');
  fs.writeFileSync(settingsPath, JSON.stringify({
    mcpServers: { [`${PRIVATE_HOME}/mcp-server`]: {} },
  }), 'utf8');
  fs.writeFileSync(sidecarPath, JSON.stringify({
    'fixture-skill': {
      model: `${PRIVATE_HOME}/sidecar-model`,
      effort: `token=${PRIVATE_TOKEN}`,
    },
  }), 'utf8');

  const configKeys = [
    'HOME', 'SKILLS_DIR', 'AGENTS_DIR', 'COMMANDS_DIR', 'PLUGINS_DIR',
    'SCHEDULED_DIR', 'SETTINGS_PATH', 'SIDECAR_PATH',
  ];
  const original = Object.fromEntries(configKeys.map((key) => [key, CONFIG[key]]));
  Object.assign(CONFIG, {
    HOME: fixtureHome,
    SKILLS_DIR: skillsDir,
    AGENTS_DIR: agentsDir,
    COMMANDS_DIR: commandsDir,
    PLUGINS_DIR: pluginsDir,
    SCHEDULED_DIR: scheduledDir,
    SETTINGS_PATH: settingsPath,
    SIDECAR_PATH: sidecarPath,
  });

  try {
    catalogModule.invalidateCatalog();
    const catalog = await catalogModule.getCatalog();

    assert.deepEqual(Object.keys(catalog), ['skills', 'agents', 'routines', 'mcpServers', 'applications']);
    assertNoFixtureLeaks(catalog);

    const skill = catalog.skills.find((entry) => entry.name === 'fixture-skill');
    const nullSkill = catalog.skills.find((entry) => entry.name === 'null-skill');
    const agent = catalog.agents.find((entry) => entry.name === 'fixture-agent');
    const nullAgent = catalog.agents.find((entry) => entry.name === 'null-agent');
    const routine = catalog.routines[0];

    assert.ok(skill);
    assert.deepEqual(Object.keys(skill), SKILL_KEYS);
    assert.equal(skill.allowedTools.length, 2);
    assert.equal(skill.model, '~/sidecar-model');
    assert.equal(skill.effort, 'token=[redacted]');
    assert.notEqual(skill.model, '~/frontmatter-model-must-not-win');
    assert.notEqual(skill.effort, '~/frontmatter-effort-must-not-win');

    assert.ok(nullSkill);
    assert.equal(nullSkill.argumentHint, null);
    assert.equal(nullSkill.allowedTools, null);
    assert.equal(nullSkill.model, null);
    assert.equal(nullSkill.effort, null);

    assert.ok(agent);
    assert.deepEqual(Object.keys(agent), AGENT_KEYS);
    assert.equal(agent.tools.length, 2);

    assert.ok(nullAgent);
    assert.equal(nullAgent.model, null);
    assert.equal(nullAgent.tools, null);
    assert.equal(nullAgent.memory, null);

    assert.ok(routine);
    assert.deepEqual(Object.keys(routine), ROUTINE_KEYS);
    assert.equal(catalog.mcpServers.length, 1);
    assert.deepEqual(catalog.applications, [{
      id: 'claude:mcp:~/mcp-server', name: '~/mcp-server',
      provider: 'claude', kind: 'mcp', version: null,
    }]);

    assert.equal(typeof catalogModule.buildSkill, 'function');
    assert.equal(typeof catalogModule.buildAgent, 'function');
    assert.deepEqual(
      catalogModule.buildSkill(skillPath, 'fallback', 'user', {
        'fixture-skill': {
          model: `${PRIVATE_HOME}/sidecar-model`,
          effort: `token=${PRIVATE_TOKEN}`,
        },
      }),
      skill,
    );
    assert.deepEqual(catalogModule.buildAgent(agentPath, 'fallback'), agent);
  } finally {
    Object.assign(CONFIG, original);
    catalogModule.invalidateCatalog();
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
});

test('schema 2 graph DTOs redact paths and identifiers while exposing only bounded provider fields', async () => {
  const fixtureHome = makeTempDir('claudeos-graph-redaction-');
  const claudeDir = path.join(fixtureHome, '.claude');
  const hostileDir = path.join(claudeDir, 'skills', `token=${PRIVATE_TOKEN}`);
  fs.mkdirSync(hostileDir, { recursive: true });
  fs.writeFileSync(path.join(hostileDir, 'note.md'), `${PRIVATE_HOME} token=${PRIVATE_TOKEN}`, 'utf8');

  try {
    const graph = await scannerModule.buildGraphFromSources(
      scannerModule.buildGraphSources({ home: fixtureHome, claudeDir }),
      { now: () => 100 },
    );
    assertNoFixtureLeaks(graph);
    assert.equal(graph.schema, 3);
    assert.equal(graph.stats.schemaVersion, 2);
    const root = graph.nodes.find((node) => node.id === 'agent-core');
    const skill = graph.nodes.find((node) => node.id.startsWith('claude/skills/token='));
    assert.ok(root);
    assert.ok(skill);
    assert.deepEqual(Object.keys(skill), [
      'id', 'label', 'path', 'kind', 'ring', 'department', 'ext', 'size', 'mtime',
      'claudeOnly', 'provider', 'resourceKind', 'files', 'mdFiles', 'bytes', 'depth',
    ]);
    assert.equal(root.provider, 'unified');
    assert.equal(skill.provider, 'claude');
    assert.equal(skill.resourceKind, 'filesystem');
    assert.equal(skill.claudeOnly, true);
  } finally {
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
});

test('Codex runner emits only normalized actions and bounded provider terminal fields', async () => {
  const fixtureDir = makeTempDir('claudeos-codex-run-redaction-');
  const executable = path.join(fixtureDir, 'codex');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    `process.stderr.write('token=${PRIVATE_TOKEN} ${PRIVATE_HOME}\\n');`,
    `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '${sessionId}' }) + '\\n');`,
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'printf ok', status: 'completed', exit_code: 0, stdout: 'forbidden-stdout', stderr: 'forbidden-stderr', arguments: { secret: 'forbidden-action-secret' } } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');",
    '',
  ].join('\n'), { mode: 0o700 });
  const previous = process.env.CLAUDEOS_CODEX_BIN;
  const heard = [];
  const unsubscribe = bus.onEvent((type, payload) => heard.push({ type, payload }));
  process.env.CLAUDEOS_CODEX_BIN = executable;

  try {
    const started = runnerModule.startRun({
      prompt: 'fixture only', provider: 'codex', cwd: process.cwd(),
    });
    const deadline = Date.now() + 5_000;
    let run;
    while (Date.now() < deadline) {
      run = runnerModule.getRun(started.runId);
      if (run?.state !== 'running') break;
      await delay(10);
    }
    assert.equal(run?.state, 'done');
    const events = heard.filter(({ payload }) => payload?.runId === started.runId);
    const done = events.find(({ type }) => type === 'run.done');
    const tool = events.find(({ type }) => type === 'run.tool');
    assert.ok(done);
    assert.ok(tool);
    assert.deepEqual(
      { provider: done.payload.provider, sessionId: done.payload.sessionId, errorCode: done.payload.errorCode },
      { provider: 'codex', sessionId, errorCode: null },
    );
    assert.deepEqual(JSON.parse(tool.payload.input), {
      command: 'printf ok', status: 'completed', exitCode: 0,
    });
    const serialized = JSON.stringify([events, run]);
    for (const forbidden of [
      PRIVATE_HOME, PRIVATE_TOKEN, 'forbidden-stdout', 'forbidden-stderr',
      'forbidden-action-secret',
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    unsubscribe();
    if (previous === undefined) delete process.env.CLAUDEOS_CODEX_BIN;
    else process.env.CLAUDEOS_CODEX_BIN = previous;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
