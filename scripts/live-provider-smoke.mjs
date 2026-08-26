import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_TIMEOUT_MS = 10 * 60 * 1000;
const RUNNER_SIGTERM_GRACE_MS = 5_000;
const RUNNER_REAP_GRACE_MS = 1_000;
const SSE_RUN_TIMEOUT_MS = RUNNER_TIMEOUT_MS
  + RUNNER_SIGTERM_GRACE_MS
  + RUNNER_REAP_GRACE_MS
  + 15_000;
const SERVER_GROUP_TERM_GRACE_MS = 8_000;
const SERVER_GROUP_KILL_GRACE_MS = 3_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fixedOperation(message, operation) {
  try { return operation(); }
  catch { throw new Error(message); }
}

function readMarkerText(markerPath, failureMessage) {
  return fixedOperation(failureMessage, () => fs.readFileSync(markerPath, 'utf8'));
}

function uuidVersion(value) {
  return UUID_RE.test(value) ? Number.parseInt(value[14], 16) : null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('live smoke interrupted');
}

function findStrings(value, out = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return out; }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    out.push(key);
    findStrings(descriptor.value, out, seen);
  }
  return out;
}

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object', 'loopback port reservation failed');
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function consumeBounded(stream, limit = 8192) {
  let value = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    value = (value + chunk).slice(-limit);
  });
  return () => value;
}

async function getJson(baseUrl, pathname, { signal = null } = {}) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      headers: { accept: 'application/json' },
      signal,
    });
  } catch {
    throwIfAborted(signal);
    throw new Error(`${pathname} request failed`);
  }
  assert.equal(response.ok, true, `${pathname} returned ${response.status}`);
  try { return await response.json(); }
  catch {
    throwIfAborted(signal);
    throw new Error(`${pathname} returned invalid JSON`);
  }
}

async function postJson(baseUrl, pathname, body, { signal = null } = {}) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throwIfAborted(signal);
    throw new Error(`${pathname} request failed`);
  }
  assert.equal(response.ok, true, `${pathname} returned ${response.status}`);
  try { return await response.json(); }
  catch {
    throwIfAborted(signal);
    throw new Error(`${pathname} returned invalid JSON`);
  }
}

async function waitForHealth(baseUrl, {
  signal = null,
  loadJson = getJson,
  timeoutMs = 15_000,
  retryDelayMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const health = await loadJson(baseUrl, '/api/health', { signal });
      if (health?.ok === true) return health;
    } catch { /* bounded retry until deadline */ }
    throwIfAborted(signal);
    await delay(retryDelayMs, { signal });
  }
  throw new Error('loopback server did not become healthy');
}

function openEvents(baseUrl, { signal = null } = {}) {
  throwIfAborted(signal);
  const history = [];
  const waiters = new Set();
  let response = null;
  let request = null;
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  let closedReason = null;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const close = (reason = 'event stream closed') => {
    if (closedReason !== null) return;
    closedReason = reason === 'live smoke interrupted'
      ? 'live smoke interrupted'
      : 'event stream closed';
    const error = new Error(closedReason);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(closedReason));
    }
    signal?.removeEventListener('abort', onAbort);
    try { response?.destroy(); } catch { /* fixed close state already published */ }
    try { request?.destroy(); } catch { /* fixed close state already published */ }
  };
  const onAbort = () => close('live smoke interrupted');

  request = http.get(`${baseUrl}/api/events`, {
    headers: { accept: 'text/event-stream' },
  }, (incoming) => {
    if (closedReason !== null) {
      incoming.destroy();
      return;
    }
    response = incoming;
    if (incoming.statusCode !== 200) {
      close('event stream request failed');
      return;
    }
    readySettled = true;
    resolveReady();
    incoming.setEncoding('utf8');
    incoming.on('error', () => close('event stream response failed'));
    incoming.on('close', () => close(
      signal?.aborted ? 'live smoke interrupted' : 'event stream closed'
    ));
    let buffer = '';
    incoming.on('data', (chunk) => {
      if (closedReason !== null) return;
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        history.push(message);
        if (history.length > 256) history.splice(0, history.length - 256);
        for (const waiter of [...waiters]) {
          let matches = false;
          try { matches = message.type === waiter.type && waiter.predicate(message.payload); }
          catch { matches = false; }
          if (!matches) continue;
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve(message.payload);
        }
      }
    });
  });
  request.on('error', () => close(
    signal?.aborted ? 'live smoke interrupted' : 'event stream request failed'
  ));
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    ready,
    waitFor(type, predicate = () => true, timeoutMs = SSE_RUN_TIMEOUT_MS) {
      if (closedReason !== null) return Promise.reject(new Error(closedReason));
      const existing = history.find((entry) => entry.type === type && predicate(entry.payload));
      if (existing) return Promise.resolve(existing.payload);
      return new Promise((resolve, reject) => {
        const waiter = { type, predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${type}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    close,
    pendingWaiterCount: () => waiters.size,
  };
}

function delay(ms, { signal = null } = {}) {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('live smoke interrupted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function trackServerChild(child, platform = process.platform) {
  let closed = false;
  child.once('error', () => { /* health/close verification reports a fixed failure */ });
  const closePromise = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  return {
    child,
    pid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
    posixGroup: platform !== 'win32',
    closePromise,
    isClosed: () => closed,
  };
}

async function waitForPromise(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function waitForCondition(predicate, timeoutMs, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(pollMs);
  }
  return predicate();
}

function isMissingProcess(error) {
  return error && typeof error === 'object' && error.code === 'ESRCH';
}

function posixGroupExists(pid, killProcess = process.kill) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw new Error('server process group status check failed');
  }
}

function signalPosixGroup(pid, signal, killProcess = process.kill) {
  try {
    killProcess(-pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw new Error('server process group termination failed');
  }
}

function terminateWindowsTree(pid, force = false, run = execFileSync) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    run('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function stopServerTree(handle, {
  killProcess = process.kill,
  runTaskkill = terminateWindowsTree,
  termGraceMs = SERVER_GROUP_TERM_GRACE_MS,
  killGraceMs = SERVER_GROUP_KILL_GRACE_MS,
} = {}) {
  if (!handle) return;
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0 || handle.pid === process.pid) {
    if (!await waitForPromise(handle.closePromise, killGraceMs)) {
      throw new Error('server process close could not be verified');
    }
    return;
  }

  if (handle.posixGroup) {
    if (posixGroupExists(handle.pid, killProcess)) {
      signalPosixGroup(handle.pid, 'SIGTERM', killProcess);
    }
    let gone = await waitForCondition(
      () => !posixGroupExists(handle.pid, killProcess), termGraceMs,
    );
    if (!gone) {
      signalPosixGroup(handle.pid, 'SIGKILL', killProcess);
      gone = await waitForCondition(
        () => !posixGroupExists(handle.pid, killProcess), killGraceMs,
      );
    }
    if (!gone) throw new Error('server process group termination could not be verified');
    if (!await waitForPromise(handle.closePromise, killGraceMs)) {
      throw new Error('server process close could not be verified');
    }
    return;
  }

  // Windows has no negative-PID process groups. taskkill /T is the explicit
  // process-tree fallback; its exit plus the tracked close event are both
  // required before the scratch workspace may be deleted.
  let treeStopped = runTaskkill(handle.pid, false);
  let closed = await waitForPromise(handle.closePromise, termGraceMs);
  if (!treeStopped || !closed) {
    treeStopped = runTaskkill(handle.pid, true);
    closed = await waitForPromise(handle.closePromise, killGraceMs);
  }
  if (!treeStopped || !closed || !handle.isClosed()) {
    throw new Error('server process tree termination could not be verified');
  }
}

function canonicalGeneratedScratch(candidate, scratchRoot, scratchPrefix) {
  const resolved = fixedOperation(
    'live-smoke workspace could not be resolved',
    () => fs.realpathSync(candidate),
  );
  const expected = path.join(scratchRoot, path.basename(candidate));
  if (resolved !== expected
      || path.dirname(resolved) !== scratchRoot
      || !path.basename(resolved).startsWith('agent-os-live-')
      || !resolved.startsWith(scratchPrefix)) {
    throw new Error('refusing unsafe live-smoke workspace');
  }
  return resolved;
}

async function removeScratch(target, { expectedTarget, scratchRoot }) {
  if (target !== expectedTarget
      || path.dirname(target) !== scratchRoot
      || !path.basename(target).startsWith('agent-os-live-')) {
    throw new Error('refusing unsafe live-smoke cleanup');
  }
  const retryable = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (!retryable.has(code)) throw new Error('live-smoke workspace cleanup failed');
    }
    await delay(250);
  }
  throw new Error('live-smoke workspace cleanup did not complete');
}

function createSignalInterruption(processRef = process, {
  abortController = null,
  onInterrupt = () => {},
} = {}) {
  let rejectInterruption;
  let interrupted = false;
  const promise = new Promise((_, reject) => { rejectInterruption = reject; });
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    try { abortController?.abort(); } catch { /* fixed interruption still rejects below */ }
    try { onInterrupt(); } catch { /* fixed interruption still rejects below */ }
    rejectInterruption(new Error('live smoke interrupted'));
  };
  processRef.once('SIGINT', onSignal);
  processRef.once('SIGTERM', onSignal);
  return {
    promise,
    isInterrupted: () => interrupted,
    throwIfInterrupted() {
      if (interrupted) throw new Error('live smoke interrupted');
    },
    dispose() {
      processRef.removeListener('SIGINT', onSignal);
      processRef.removeListener('SIGTERM', onSignal);
    },
  };
}

async function runLiveSmoke() {
  if (typeof process.env.HOME !== 'string' || process.env.HOME.length === 0) {
    throw new Error('HOME is required for the confined live smoke');
  }
  const operatorHome = fixedOperation(
    'operator home could not be resolved',
    () => fs.realpathSync(process.env.HOME),
  );
  const scratchRoot = fixedOperation(
    'temporary root could not be resolved',
    () => fs.realpathSync(os.tmpdir()),
  );
  const scratchPrefix = path.join(scratchRoot, 'agent-os-live-');
  let resolvedScratch = null;
  let serverHandle = null;
  let events = null;
  let interruption = null;
  let abortController = null;
  let liveWork = null;
  const scratch = fixedOperation(
    'live-smoke workspace could not be created',
    () => fs.mkdtempSync(scratchPrefix),
  );
  try {
    abortController = new AbortController();
    interruption = createSignalInterruption(process, {
      abortController,
      onInterrupt: () => events?.close('live smoke interrupted'),
    });
    const signal = abortController.signal;
    liveWork = (async () => {
        // The cleanup guard is active before the first fixture, realpath, Git,
        // or assertion operation after mkdtemp succeeds.
        resolvedScratch = canonicalGeneratedScratch(scratch, scratchRoot, scratchPrefix);
        const sandboxHome = path.join(resolvedScratch, 'home');
        const temp = path.join(sandboxHome, 'work');
        for (const skillDir of [
          path.join(sandboxHome, '.claude', 'skills', 'live-proof'),
          path.join(sandboxHome, '.codex', 'skills', 'live-proof'),
        ]) {
          fixedOperation('provider proof fixture could not be created', () => {
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
              '---\nname: live-proof\ndescription: Disposable provider proof\n---\n', 'utf8');
          });
        }
        fixedOperation('live-smoke work directory could not be created', () => {
          fs.mkdirSync(temp, { recursive: true });
        });
        const resolvedTemp = fixedOperation(
          'live-smoke work directory could not be resolved',
          () => fs.realpathSync(temp),
        );
        if (!resolvedTemp.startsWith(resolvedScratch + path.sep)) {
          throw new Error('refusing unsafe live-smoke workspace');
        }
        fixedOperation('disposable Git repository could not be initialized', () => {
          execFileSync('git', ['init', '-q', resolvedTemp], { stdio: 'ignore' });
        });
        const gitDirectoryReady = fixedOperation(
          'disposable Git repository could not be verified',
          () => fs.statSync(path.join(resolvedTemp, '.git')).isDirectory(),
        );
        assert.equal(gitDirectoryReady, true,
          'disposable Git repository was not initialized');

        const port = await reservePort();
        throwIfAborted(signal);
        const baseUrl = `http://127.0.0.1:${port}`;
        const server = fixedOperation('loopback server could not be started', () => spawn(
          process.execPath,
          ['server/index.js'],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              HOME: sandboxHome,
              CODEX_HOME: process.env.CODEX_HOME || path.join(operatorHome, '.codex'),
              CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(operatorHome, '.claude'),
              CLAUDEOS_PORT: String(port),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          },
        ));
        serverHandle = trackServerChild(server);
        consumeBounded(server.stdout);
        consumeBounded(server.stderr);
        await waitForHealth(baseUrl, { signal });
        throwIfAborted(signal);

        events = openEvents(baseUrl, { signal });
        await events.ready;
        throwIfAborted(signal);
        await events.waitFor('hello');
        throwIfAborted(signal);

        const [catalog, graph] = await Promise.all([
          getJson(baseUrl, '/api/catalog', { signal }),
          getJson(baseUrl, '/api/graph', { signal }),
        ]);
        throwIfAborted(signal);
        const exposed = findStrings({ catalog, graph });
        assert.equal(graph.stats.schemaVersion, 2, 'live graph schema did not match');
        assert.equal(graph.nodes.some((node) => node.id === 'agent-core'), true,
          'live graph Agent Core was absent');
        assert.equal(graph.nodes.some((node) => node.id === 'claude'), true,
          'live graph Claude branch was absent');
        assert.equal(graph.nodes.some((node) => node.id === 'codex'), true,
          'live graph Codex branch was absent');
        assert.equal(exposed.some((value) =>
          /auth\.json|archived_sessions|history\.jsonl|\.sqlite|attachments|worktrees/.test(value)), false,
          'sensitive basename crossed the live API boundary');
        for (const privateRoot of [operatorHome, sandboxHome]) {
          assert.equal(exposed.some((value) => value.includes(privateRoot)), false,
            'private root crossed the live API boundary');
        }
        console.log('GRAPH_SCHEMA=2 CLAUDE=present CODEX=present SENSITIVE=absent');

        const markerName = `agent-os-${Date.now()}-${process.pid}.txt`;
        const markerPath = path.join(resolvedTemp, markerName);
        const firstText = `CODEX_NEW_${process.pid}`;
        const secondText = `CODEX_RESUME_${process.pid}`;
        const first = await postJson(baseUrl, '/api/run', {
          provider: 'codex', cwd: resolvedTemp,
          prompt: `Create ${markerName} in the current workspace with exactly ${firstText} followed by a newline.`,
        }, { signal });
        throwIfAborted(signal);
        const firstDone = await events.waitFor(
          'run.done', (payload) => payload?.runId === first.runId,
        );
        throwIfAborted(signal);
        assert.equal(firstDone.ok, true, 'Codex new run did not succeed');
        assert.equal(UUID_RE.test(firstDone.sessionId), true,
          'Codex returned an invalid session ID');
        assert.equal(uuidVersion(firstDone.sessionId), 7,
          'Codex returned an unexpected native session UUID version');
        const firstMarker = readMarkerText(
          markerPath, 'Codex new-run marker could not be read',
        );
        assert.equal(firstMarker === `${firstText}\n`, true,
          'Codex new-run marker content did not match');
        console.log('CODEX_NEW=ok MARKER=ok');

        const resumed = await postJson(baseUrl, '/api/run', {
          provider: 'codex', resumeSessionId: firstDone.sessionId,
          prompt: `Append exactly ${secondText} followed by a newline to ${markerName}.`,
        }, { signal });
        throwIfAborted(signal);
        const resumedDone = await events.waitFor(
          'run.done', (payload) => payload?.runId === resumed.runId,
        );
        throwIfAborted(signal);
        assert.equal(resumedDone.ok, true, 'Codex resumed run did not succeed');
        const resumedMarker = readMarkerText(
          markerPath, 'Codex resumed marker could not be read',
        );
        assert.equal(resumedMarker === `${firstText}\n${secondText}\n`, true,
          'Codex resumed marker content did not match');
        console.log('CODEX_RESUME=ok MARKER_APPEND=ok');

        const claude = await postJson(baseUrl, '/api/run', {
          provider: 'claude', cwd: resolvedTemp,
          prompt: 'Reply with exactly CLAUDE_RUN_OK. Do not use tools or change files.',
        }, { signal });
        throwIfAborted(signal);
        const claudeDone = await events.waitFor(
          'run.done', (payload) => payload?.runId === claude.runId,
        );
        throwIfAborted(signal);
        assert.equal(claudeDone.ok, true, 'Claude compatibility run did not succeed');
        assert.equal(String(claudeDone.result).trim() === 'CLAUDE_RUN_OK', true,
          'Claude compatibility reply did not match');
        console.log('CLAUDE_RUN=ok');
    })();
    await Promise.race([liveWork, interruption.promise]);
  } finally {
    try {
      const closeReason = interruption?.isInterrupted()
        ? 'live smoke interrupted'
        : 'event stream closed';
      try { events?.close(closeReason); } catch { /* process-group teardown remains authoritative */ }
      try { abortController?.abort(); } catch { /* liveWork is also settled below */ }
      let terminationError = null;
      try { await stopServerTree(serverHandle); }
      catch { terminationError = new Error('server process termination could not be verified'); }
      if (liveWork !== null) {
        await liveWork.then(
          () => undefined,
          () => undefined,
        );
      }
      if (terminationError) throw terminationError;
      if (resolvedScratch === null && fs.existsSync(scratch)) {
        resolvedScratch = canonicalGeneratedScratch(scratch, scratchRoot, scratchPrefix);
      }
      if (resolvedScratch !== null) {
        const expectedTarget = path.join(scratchRoot, path.basename(scratch));
        await removeScratch(resolvedScratch, { expectedTarget, scratchRoot });
      }
      assert.equal(fs.existsSync(scratch), false,
        'live-smoke workspace cleanup did not complete');
    } finally {
      interruption?.dispose();
    }
  }
}

async function runSelfTests() {
  assert.equal(
    SSE_RUN_TIMEOUT_MS > RUNNER_TIMEOUT_MS + RUNNER_SIGTERM_GRACE_MS + RUNNER_REAP_GRACE_MS,
    true,
    'SSE timeout must outlast runner termination',
  );
  assert.equal(uuidVersion('00000000-0000-7000-8000-000000000000'), 7);
  assert.throws(
    () => readMarkerText(path.join(REPO_ROOT, '__missing_live_marker__'),
      'fixed marker read failure'),
    { message: 'fixed marker read failure' },
  );

  const fakeProcess = new EventEmitter();
  const interruption = createSignalInterruption(fakeProcess);
  fakeProcess.emit('SIGINT');
  await assert.rejects(interruption.promise, { message: 'live smoke interrupted' });
  assert.throws(() => interruption.throwIfInterrupted(), { message: 'live smoke interrupted' });
  interruption.dispose();
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);

  const structuredProcess = new EventEmitter();
  const structuredAbort = new AbortController();
  const structuredInterruption = createSignalInterruption(structuredProcess, {
    abortController: structuredAbort,
  });
  let healthAttempts = 0;
  let postInterruptContinuation = false;
  let liveWorkSettled = false;
  const structuredOrder = [];
  const pendingHealthWork = (async () => {
    await waitForHealth('http://127.0.0.1:1', {
      signal: structuredAbort.signal,
      timeoutMs: 60_000,
      retryDelayMs: 60_000,
      async loadJson() {
        healthAttempts += 1;
        throw new Error('synthetic health failure');
      },
    });
    postInterruptContinuation = true;
  })().finally(() => {
    liveWorkSettled = true;
    structuredOrder.push('liveWork settled');
  });
  const structuredRace = Promise.race([
    pendingHealthWork,
    structuredInterruption.promise,
  ]);
  await delay(0);
  structuredProcess.emit('SIGTERM');
  await assert.rejects(structuredRace, { message: 'live smoke interrupted' });
  await pendingHealthWork.then(
    () => undefined,
    () => undefined,
  );
  const cleanupSawSettledWork = liveWorkSettled;
  structuredOrder.push('cleanup');
  assert.equal(healthAttempts, 1);
  assert.equal(postInterruptContinuation, false);
  assert.equal(cleanupSawSettledWork, true);
  assert.deepEqual(structuredOrder, ['liveWork settled', 'cleanup']);
  structuredInterruption.dispose();

  const sseServer = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.flushHeaders();
  });
  sseServer.listen(0, '127.0.0.1');
  await once(sseServer, 'listening');
  const sseAddress = sseServer.address();
  assert.ok(sseAddress && typeof sseAddress === 'object',
    'self-test SSE server did not start');
  const sseAbort = new AbortController();
  const fixtureEvents = openEvents(`http://127.0.0.1:${sseAddress.port}`, {
    signal: sseAbort.signal,
  });
  await fixtureEvents.ready;
  const pendingSseWait = fixtureEvents.waitFor('never', () => true, 60_000);
  assert.equal(fixtureEvents.pendingWaiterCount(), 1);
  sseAbort.abort();
  await assert.rejects(pendingSseWait, { message: 'live smoke interrupted' });
  assert.equal(fixtureEvents.pendingWaiterCount(), 0);
  await assert.rejects(
    fixtureEvents.waitFor('future'),
    { message: 'live smoke interrupted' },
  );
  fixtureEvents.close('live smoke interrupted');
  sseServer.closeAllConnections?.();
  await new Promise((resolve, reject) => sseServer.close((error) => {
    if (error) reject(new Error('self-test SSE server did not close'));
    else resolve();
  }));

  let groupAlive = true;
  const groupSignals = [];
  const fakeKill = (target, signal) => {
    groupSignals.push([target, signal]);
    if (signal === 0) {
      if (groupAlive) return;
      const error = new Error('synthetic missing group');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') groupAlive = false;
  };
  await stopServerTree({
    pid: 4242,
    posixGroup: true,
    closePromise: Promise.resolve({ code: 0, signal: 'SIGTERM' }),
    isClosed: () => true,
  }, { killProcess: fakeKill, termGraceMs: 5, killGraceMs: 5 });
  assert.equal(groupSignals.some(([target, signal]) => target === -4242 && signal === 'SIGTERM'), true);
  assert.equal(groupSignals.some(([target, signal]) => target === -4242 && signal === 0), true);

  let stubbornGroupAlive = true;
  const stubbornSignals = [];
  const stubbornKill = (target, signal) => {
    stubbornSignals.push([target, signal]);
    if (signal === 0) {
      if (stubbornGroupAlive) return;
      const error = new Error('synthetic missing group');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 'SIGKILL') stubbornGroupAlive = false;
  };
  await stopServerTree({
    pid: 4243,
    posixGroup: true,
    closePromise: Promise.resolve({ code: null, signal: 'SIGKILL' }),
    isClosed: () => true,
  }, { killProcess: stubbornKill, termGraceMs: 1, killGraceMs: 5 });
  assert.equal(stubbornSignals.some(
    ([target, signal]) => target === -4243 && signal === 'SIGKILL'
  ), true);

  const taskkillCalls = [];
  await stopServerTree({
    pid: 4343,
    posixGroup: false,
    closePromise: Promise.resolve({ code: 0, signal: null }),
    isClosed: () => true,
  }, {
    runTaskkill(pid, force) { taskkillCalls.push([pid, force]); return true; },
    termGraceMs: 5,
    killGraceMs: 5,
  });
  assert.deepEqual(taskkillCalls, [[4343, false]]);

  await assert.rejects(
    stopServerTree({
      pid: null,
      posixGroup: false,
      closePromise: new Promise(() => {}),
      isClosed: () => false,
    }, { killGraceMs: 1 }),
    { message: 'server process close could not be verified' },
  );

  const scratchRoot = fixedOperation(
    'self-test temporary root could not be resolved',
    () => fs.realpathSync(os.tmpdir()),
  );
  const scratchPrefix = path.join(scratchRoot, 'agent-os-live-');
  const scratch = fixedOperation(
    'self-test workspace could not be created',
    () => fs.mkdtempSync(scratchPrefix),
  );
  let resolvedScratch = null;
  try {
    resolvedScratch = canonicalGeneratedScratch(scratch, scratchRoot, scratchPrefix);
    fixedOperation('self-test fixture could not be created', () => {
      fs.writeFileSync(path.join(resolvedScratch, 'fixture'), 'fixture', 'utf8');
    });
    await assert.rejects(
      removeScratch(scratchRoot, { expectedTarget: resolvedScratch, scratchRoot }),
      { message: 'refusing unsafe live-smoke cleanup' },
    );
    throw new Error('synthetic preflight failure');
  } catch (error) {
    assert.equal(error?.message, 'synthetic preflight failure');
  } finally {
    if (resolvedScratch === null && fs.existsSync(scratch)) {
      resolvedScratch = canonicalGeneratedScratch(scratch, scratchRoot, scratchPrefix);
    }
    if (resolvedScratch !== null) {
      await removeScratch(resolvedScratch, {
        expectedTarget: path.join(scratchRoot, path.basename(scratch)),
        scratchRoot,
      });
    }
  }
  assert.equal(fs.existsSync(scratch), false,
    'self-test workspace cleanup did not complete');
  console.log('LIVE_SMOKE_SELF_TEST=ok');
}

if (process.argv.includes('--self-test')) await runSelfTests();
else await runLiveSmoke();
