// server/lib/runner.js — Slice E · run manager.
//
// Spawns the selected Claude or Codex CLI headlessly and streams normalized output as
// the four CONTRACT.md §2 run.* events. Nothing in here may throw at the
// caller: startRun() always returns {runId, sessionId} and every terminal
// path emits exactly one `run.done`.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG } from './config.js';
import { emit, scrubForClient } from './bus.js';
import { normalizeProvider, resolveCodexBin, validateSkillPatch } from './providers.js';
import { redact } from './redact.js';
import { createResumeRegistry } from './resume-registry.js';
import {
  buildClaudeArgs,
  createClaudeEventState,
  normalizeClaudeEvent,
} from './run-adapters/claude.js';
import {
  buildCodexArgs,
  createCodexEventState,
  normalizeCodexEvent,
} from './run-adapters/codex.js';

// Compatibility: existing callers import this from runner.js. Re-export the
// adapter binding itself so reference identity remains stable.
export { buildClaudeArgs } from './run-adapters/claude.js';

// ---- tunables -------------------------------------------------------------
const RUN_TIMEOUT_MS   = 10 * 60 * 1000; // hard wall per run
const SIGKILL_GRACE_MS = 5000;           // SIGTERM -> SIGKILL
const REAP_GRACE_MS    = 1000;           // SIGKILL -> settle anyway
const MAX_CONCURRENT   = 3;
const MAX_TRANSCRIPT   = 500;            // entries per run, oldest dropped
const MAX_RUNS         = 50;
const RUN_TTL_MS       = 60 * 60 * 1000; // evict finished runs after 1h
const MAX_TOOL_INPUT   = 500;            // chars of redacted tool input
const MAX_LINE_CHARS   = 1024 * 1024;    // pending NDJSON line cap
const MAX_STDERR       = 8 * 1024;       // rolling stderr window
const STDERR_TAIL      = 800;            // chars appended to a failed result

// ---- guarded helpers ------------------------------------------------------
// Slices A and B own bus.js / redact.js. A bug in either must never take a run
// down, and redaction fails CLOSED — we never fall back to the raw string.

function emitSafe(type, payload) {
  try {
    emit(type, payload);
  } catch {
    /* bus unavailable — a run must outlive it */
  }
}

function safeRedact(value) {
  const str = typeof value === 'string' ? value : '';
  if (!str) return '';
  try {
    const out = redact(str);
    return typeof out === 'string' ? out : '[redaction failed]';
  } catch {
    return '[redaction failed]';
  }
}

function safeErrorMessage(error) {
  if (typeof error === 'string') return safeRedact(error);
  try {
    if (error && typeof error === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return typeof descriptor.value === 'string'
          ? safeRedact(descriptor.value)
          : '[unavailable error]';
      }
    }
  } catch {
    /* hostile proxy/descriptor — fail closed below */
  }
  return '[unavailable error]';
}

// ---- binary resolution ----------------------------------------------------
// CLAUDEOS_CLAUDE_BIN -> `claude` on PATH -> ~/.claude/local/claude.
// An explicit override that is not executable does NOT fall through: the
// operator asked for that binary, so a typo must surface as "not found".

let binCacheKey;
let binCacheValue;

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findClaudeBin(override) {
  if (override) return isExecutableFile(override) ? override : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (isExecutableFile(candidate)) return candidate;
  }
  const local = path.join(CONFIG.HOME, '.claude', 'local', 'claude');
  return isExecutableFile(local) ? local : null;
}

function resolveClaudeBin() {
  const override = String(process.env.CLAUDEOS_CLAUDE_BIN || '');
  const key = `${override}\u0000${process.env.PATH || ''}`;
  if (binCacheKey === key) return binCacheValue;
  binCacheKey = key;
  try {
    binCacheValue = findClaudeBin(override);
  } catch {
    binCacheValue = null;
  }
  return binCacheValue;
}

// ---- cwd confinement ------------------------------------------------------
// This endpoint is reachable from a browser page, so the caller's cwd is
// hostile input. It must resolve to a real directory at or below $HOME;
// realpath() defeats a symlink under $HOME that points somewhere else.

let realHomeCache;
function realHome() {
  if (realHomeCache) return realHomeCache;
  try {
    realHomeCache = fs.realpathSync(CONFIG.HOME);
  } catch {
    realHomeCache = CONFIG.HOME;
  }
  return realHomeCache;
}

export function resolveCwd(requested) {
  const fallback = CONFIG.REPO_ROOT;
  if (typeof requested !== 'string' || !requested.trim()) return fallback;
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(requested));
    if (!fs.statSync(resolved).isDirectory()) return fallback;
  } catch {
    return fallback; // missing, unreadable, or not a path we can vouch for
  }
  const home = realHome();
  // Separator-aware: "/Users/alice-other" must not pass a "/Users/alice" check.
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return fallback;
  return resolved;
}

// ---- NDJSON line parser ---------------------------------------------------
// The CLI's stdout is newline-delimited JSON, and a single object WILL be
// split across two `data` events. Buffer partial lines, ignore anything that
// is not JSON (the CLI prints occasional plain-text warnings), and flush the
// tail on close so a final line without a trailing newline is not lost.
// Exported so the split behaviour can be tested without spawning anything.

export function createNdjsonParser(onMessage) {
  let buf = '';
  let discarding = false;

  function handle(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-JSON warning line — ignore silently
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      onMessage(msg);
    } catch {
      /* a bad handler must not kill the stream */
    }
  }

  function feed(chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (discarding) {
        discarding = false; // this newline terminates the oversized line
        continue;
      }
      if (line.length > MAX_LINE_CHARS) continue;
      handle(line);
    }
    if (buf.length > MAX_LINE_CHARS) {
      buf = '';
      discarding = true; // resync at the next newline
    }
  }

  function flush() {
    const line = buf;
    buf = '';
    if (discarding) {
      discarding = false;
      return;
    }
    if (line) handle(line);
  }

  return { feed, flush };
}

// ---- provider-aware run manager ------------------------------------------

export function isInsideGitWorktree(workdir) {
  let current;
  try { current = fs.realpathSync(workdir); } catch { return false; }
  const home = realHome();
  if (current !== home && !current.startsWith(home + path.sep)) return false;
  while (true) {
    try {
      const marker = fs.statSync(path.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) return true;
    } catch { /* keep walking */ }
    if (current === home) return false;
    const parent = path.dirname(current);
    if (parent === current || (parent !== home && !parent.startsWith(home + path.sep))) return false;
    current = parent;
  }
}

export function createRunManager({
  spawnProcess = spawn,
  resolveClaudeBinary = resolveClaudeBin,
  resolveCodexBinary = () => resolveCodexBin(),
  resumeRegistry = createResumeRegistry(),
  now = Date.now,
  runTimeoutMs = RUN_TIMEOUT_MS,
  sigkillGraceMs = SIGKILL_GRACE_MS,
  reapGraceMs = REAP_GRACE_MS,
} = {}) {
  const runs = new Map();

  function pushTranscript(run, entry) {
    let clean = scrubForClient(entry);
    if (!clean || typeof clean !== 'object' || Array.isArray(clean)) {
      clean = Object.create(null);
      Object.defineProperty(clean, 'kind', { enumerable: true, value: 'unavailable' });
    }
    run.transcript.push(clean);
    if (run.transcript.length > MAX_TRANSCRIPT) {
      run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT);
    }
  }

  function countRunning(exceptId) {
    let count = 0;
    for (const run of runs.values()) {
      if (run.state === 'running' && run.runId !== exceptId) count += 1;
    }
    return count;
  }

  function evict() {
    const at = now();
    for (const [id, run] of runs) {
      if (run.state !== 'running' && at - run.startedAt > RUN_TTL_MS) runs.delete(id);
    }
    if (runs.size <= MAX_RUNS) return;
    const ordered = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const run of ordered) {
      if (runs.size <= MAX_RUNS) break;
      if (run.state !== 'running') runs.delete(run.runId);
    }
  }

  function clearTimers(run) {
    for (const timer of run.timers) {
      try { clearTimeout(timer); } catch { /* ignore */ }
    }
    run.timers.length = 0;
  }

  function ensureStarted(run) {
    if (run.startedEmitted) return;
    run.startedEmitted = true;
    emitSafe('run.started', run.startedPayload);
  }

  function captureSession(run, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (run.provider === 'codex') {
      try { resumeRegistry.capture(sessionId, run.cwd); } catch { return; }
    }
    run.sessionId = sessionId;
    run.sessionIdReal = true;
  }

  function publishDelta(run, rawText) {
    if (typeof rawText !== 'string' || !rawText) return;
    ensureStarted(run);
    const text = safeRedact(rawText);
    pushTranscript(run, { kind: 'delta', text });
    emitSafe('run.delta', { runId: run.runId, text });
  }

  function publishTool(run, rawToolName, rawInput) {
    ensureStarted(run);
    const toolName = typeof rawToolName === 'string' && rawToolName
      ? safeRedact(rawToolName)
      : 'unknown';
    let input = safeRedact(typeof rawInput === 'string' ? rawInput : '');
    if (input.length > MAX_TOOL_INPUT) input = input.slice(0, MAX_TOOL_INPUT);
    pushTranscript(run, { kind: 'tool', toolName, input });
    emitSafe('run.tool', { runId: run.runId, toolName, input });
  }

  function applyAction(run, action) {
    if (!action || typeof action !== 'object') return;
    if (action.type === 'session') return captureSession(run, action.sessionId);
    if (action.type === 'delta') return publishDelta(run, action.text);
    if (action.type === 'tool') return publishTool(run, action.toolName, action.input);
    if (action.type !== 'complete' && action.type !== 'fail') return;
    if (run.pending?.ok === false) return;
    run.pending = {
      ok: action.type === 'complete' && action.ok === true,
      result: safeRedact(typeof action.result === 'string' ? action.result : ''),
      usage: scrubForClient(action.usage ?? null),
      costUsd: typeof action.costUsd === 'number' ? action.costUsd : null,
      errorCode: action.type === 'fail' && action.errorCode === 'authentication-required'
        ? 'authentication-required'
        : (action.type === 'fail' ? 'run-failed' : null),
    };
  }

  function settle(run, { ok, result, usage, costUsd, errorCode = null }) {
    if (run.settled) return;
    run.settled = true;
    clearTimers(run);
    ensureStarted(run);
    run.state = ok ? 'done' : 'error';
    run.endedAt = now();
    run.child = null;
    const boundedCode = ok
      ? null
      : (errorCode === 'cli-unavailable' || errorCode === 'authentication-required'
        ? errorCode
        : 'run-failed');
    const payload = {
      runId: run.runId,
      ok: !!ok,
      result: safeRedact(typeof result === 'string' ? result : ''),
      usage: scrubForClient(usage ?? null),
      costUsd: typeof costUsd === 'number' ? costUsd : null,
      provider: run.provider,
      sessionId: run.sessionIdReal ? run.sessionId : null,
      errorCode: boundedCode,
    };
    pushTranscript(run, { kind: 'done', ...payload });
    emitSafe('run.done', payload);
    run.pending = null;
    run.spawnErr = null;
    run.stderr = '';
    evict();
  }

  function failAsync(run, message, errorCode = 'run-failed') {
    const safeMessage = safeRedact(message);
    const timer = setTimeout(() => {
      settle(run, {
        ok: false, result: safeMessage, usage: null, costUsd: null, errorCode,
      });
    }, 0);
    if (timer.unref) timer.unref();
    run.timers.push(timer);
  }

  function handleMessage(run, message) {
    let actions;
    try { actions = run.normalizeEvent(message, run.eventState); } catch { return; }
    if (!Array.isArray(actions)) return;
    for (const action of actions) applyAction(run, action);
  }

  function startRun({
    prompt,
    provider = 'claude',
    model = null,
    effort = null,
    cwd = null,
    resumeSessionId = null,
  } = {}) {
    const runId = crypto.randomUUID();
    let providerId;
    try { providerId = normalizeProvider(provider); } catch { providerId = null; }
    const run = {
      runId,
      provider: providerId || 'claude',
      sessionId: runId,
      sessionIdReal: false,
      state: 'running', transcript: [], startedAt: now(), endedAt: null,
      settled: false, startedEmitted: false, startedPayload: null,
      pending: null, spawnErr: null, timedOut: false, stderr: '', child: null,
      eventState: null, normalizeEvent: null, cwd: null, timers: [],
    };
    runs.set(runId, run);
    evict();

    const promptStr = typeof prompt === 'string' ? prompt : '';
    const cliLabel = providerId === 'codex' ? 'Codex' : 'claude';
    let modelValue = model;
    let effortValue = effort;
    try {
      if (!providerId) throw new Error('invalid provider');
      const requested = {};
      if (model !== undefined) requested.model = model;
      if (effort !== undefined) requested.effort = effort;
      const validated = validateSkillPatch(providerId, requested);
      modelValue = validated.model ?? null;
      effortValue = validated.effort ?? null;
    } catch {
      run.startedPayload = {
        runId, sessionId: run.sessionId, prompt: safeRedact(promptStr),
        model: null, effort: null, provider: run.provider,
      };
      failAsync(run, 'invalid run request');
      return { runId, sessionId: run.sessionId };
    }

    run.startedPayload = {
      runId, sessionId: run.sessionId, prompt: safeRedact(promptStr),
      model: modelValue, effort: effortValue, provider: providerId,
    };
    const ret = { runId, sessionId: run.sessionId };

    if (countRunning(runId) >= MAX_CONCURRENT) {
      failAsync(run, 'too many concurrent runs');
      return ret;
    }

    let resumeRecord = null;
    if (resumeSessionId != null) {
      if (providerId !== 'codex' || !(resumeRecord = resumeRegistry.lookup(resumeSessionId))) {
        failAsync(run, 'Codex session could not be resumed');
        return ret;
      }
      run.sessionId = resumeSessionId;
      run.sessionIdReal = true;
      run.startedPayload.sessionId = resumeSessionId;
      ret.sessionId = resumeSessionId;
    }
    const workdir = resumeRecord ? resumeRecord.cwd : resolveCwd(cwd);
    run.cwd = workdir;

    const isCodex = providerId === 'codex';
    let bin;
    try { bin = isCodex ? resolveCodexBinary() : resolveClaudeBinary(); } catch { bin = null; }
    if (!bin) {
      failAsync(run, `${cliLabel} CLI not found`, 'cli-unavailable');
      return ret;
    }

    run.eventState = isCodex ? createCodexEventState() : createClaudeEventState();
    run.normalizeEvent = isCodex ? normalizeCodexEvent : normalizeClaudeEvent;
    let args;
    try {
      args = isCodex
        ? buildCodexArgs({
          model: modelValue,
          effort: effortValue,
          resumeSessionId,
          skipGitRepoCheck: !isInsideGitWorktree(workdir),
        })
        : buildClaudeArgs({ runId, model: modelValue, effort: effortValue });
    } catch {
      failAsync(run, 'invalid run request');
      return ret;
    }

    let child;
    try {
      child = spawnProcess(bin, args, {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      failAsync(run, `${cliLabel} CLI failed to start: ${safeErrorMessage(error)}`);
      return ret;
    }
    run.child = child;
    const parser = createNdjsonParser((message) => handleMessage(run, message));

    const finish = (code, signal) => {
      if (run.settled) return;
      try { parser.flush(); } catch { /* ignore */ }
      const tail = run.stderr.trim().slice(-STDERR_TAIL);
      const stderrNote = tail ? `[stderr] ${safeRedact(tail)}` : '';
      if (run.spawnErr) {
        settle(run, {
          ok: false,
          result: `${cliLabel} CLI failed to start: ${run.spawnErr}`,
          usage: null, costUsd: null, errorCode: 'run-failed',
        });
        return;
      }
      if (run.timedOut) {
        settle(run, {
          ok: false,
          result: [`run timed out after ${Math.round(runTimeoutMs / 60000)} minutes`, stderrNote]
            .filter(Boolean).join('\n'),
          usage: run.pending?.usage ?? null,
          costUsd: run.pending?.costUsd ?? null,
          errorCode: 'run-failed',
        });
        return;
      }
      if (run.pending) {
        const badExit = code !== 0 && code !== null && code !== undefined;
        const result = badExit && stderrNote
          ? [run.pending.result, stderrNote].filter(Boolean).join('\n')
          : run.pending.result;
        settle(run, { ...run.pending, result });
        return;
      }
      const how = signal
        ? `${cliLabel} CLI terminated by ${signal}`
        : `${cliLabel} CLI exited with code ${code}`;
      settle(run, {
        ok: false,
        result: [how, stderrNote].filter(Boolean).join('\n'),
        usage: null, costUsd: null, errorCode: 'run-failed',
      });
    };

    if (child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.end(promptStr); } catch { /* child lifecycle settles */ }
    }
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        try { parser.feed(chunk); } catch { /* ignore */ }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('error', () => {});
      child.stderr.on('data', (chunk) => {
        run.stderr += chunk;
        if (run.stderr.length > MAX_STDERR) run.stderr = run.stderr.slice(-MAX_STDERR);
      });
    }
    child.on('error', (error) => {
      run.spawnErr = safeErrorMessage(error);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    const timeout = setTimeout(() => {
      if (run.settled) return;
      run.timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        const reaper = setTimeout(() => finish(null, 'SIGKILL'), reapGraceMs);
        if (reaper.unref) reaper.unref();
        run.timers.push(reaper);
      }, sigkillGraceMs);
      if (killer.unref) killer.unref();
      run.timers.push(killer);
    }, runTimeoutMs);
    if (timeout.unref) timeout.unref();
    run.timers.push(timeout);
    const kick = setTimeout(() => ensureStarted(run), 0);
    if (kick.unref) kick.unref();
    run.timers.push(kick);
    return ret;
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    const dto = scrubForClient({ runId: run.runId, state: run.state, transcript: run.transcript });
    if (dto && typeof dto === 'object' && !Array.isArray(dto)) return dto;
    const fallback = Object.create(null);
    Object.defineProperties(fallback, {
      runId: { enumerable: true, value: safeRedact(run.runId) },
      state: { enumerable: true, value: safeRedact(run.state) },
      transcript: { enumerable: true, value: [] },
    });
    Object.defineProperty(fallback.transcript, 'toJSON', { enumerable: false, value: undefined });
    return fallback;
  }

  function getRunSessionId(runId) {
    const run = runs.get(runId);
    return run ? run.sessionId : null;
  }

  function getResumableSession(sessionId) {
    return resumeRegistry.lookup(sessionId);
  }

  return { startRun, getRun, getRunSessionId, getResumableSession };
}

const defaultManager = createRunManager();

export const startRun = defaultManager.startRun;
export const getRun = defaultManager.getRun;
export const getRunSessionId = defaultManager.getRunSessionId;
export const getResumableSession = defaultManager.getResumableSession;
