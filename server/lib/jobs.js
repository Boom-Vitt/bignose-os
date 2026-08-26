// server/lib/jobs.js — Slice C · jobs watcher.
//
// Reads ~/.claude/jobs/<id>/{state.json,timeline.jsonl}, normalises each job to
// the frozen shape in CONTRACT.md §4, keeps an in-memory snapshot, and pushes
// changes onto the bus as `job.state` / `job.removed`.
//
// Invariants:
//  - Never throws out of startJobs()/listJobs(); degrade to empty/null instead.
//  - Never emits `undefined` for a contract field — the 15 keys are written
//    explicitly, never spread from the parsed JSON (state.json carries extra
//    keys such as `output.result`, `intent`, `linkScanPath` and `respawnFlags`
//    that must never reach the browser).
//  - Every user-visible string goes through redact() first.

import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

import { CONFIG } from './config.js';
import { emit } from './bus.js';
import { redact } from './redact.js';

const DAY_MS = 86400000;
const TIMELINE_LIMIT = 50;   // CONTRACT §4 — last 50 entries only
const DEBOUNCE_MS = 250;     // Claude Code rewrites state.json rapidly mid-run
const WATCHED_FILES = new Set(['state.json', 'timeline.jsonl']);
const CLIENT_JOB_ID_PREFIX = 'claudeos-job-id:v1:';
const NIBBLE_ALPHABET = 'ABCDEFGHIJKLMNOP';

/** @type {Map<string, object>} job id -> normalised Job */
const jobs = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} job id -> pending re-read */
const pendingReads = new Map();

let watcher = null;
let started = false;

// ------------------------------------------------------------------ logging

function warn(...args) {
  console.warn('[claudeos:jobs]', ...args);
}

function safeEmit(type, payload) {
  try {
    emit(type, payload);
  } catch (err) {
    warn(`emit(${type}) failed:`, err?.message || err);
  }
}

// --------------------------------------------------------------- primitives

/**
 * The only path a user-visible string may take to the browser. On failure we
 * drop the string rather than leak an unredacted one.
 */
function redactOrNull(value) {
  if (typeof value !== 'string') return null;
  try {
    const out = redact(value);
    return typeof out === 'string' ? out : null;
  } catch (err) {
    warn('redact() threw:', err?.message || err);
    return null;
  }
}

/** Same, for contract fields typed as a non-nullable string. */
function redactOrEmpty(value) {
  const out = redactOrNull(value);
  return out === null ? '' : out;
}

function encodeOpaque(bytes) {
  let out = '';
  for (const byte of bytes) {
    out += NIBBLE_ALPHABET[byte >>> 4];
    out += NIBBLE_ALPHABET[byte & 0x0f];
  }
  return out;
}

function namespacedClientJobId(kind, bytes) {
  return redactOrEmpty(`${CLIENT_JOB_ID_PREFIX}${kind}:Z${encodeOpaque(bytes)}`);
}

function clientJobId(id) {
  const raw = typeof id === 'string' ? id : String(id ?? '');
  const redacted = redactOrEmpty(raw);
  if (redacted !== raw) {
    const digest = createHmac('sha256', String(CONFIG.HOOK_TOKEN ?? ''))
      .update('claudeos:job-id\0', 'utf8')
      .update(raw, 'utf8')
      .digest();
    return namespacedClientJobId('r', digest);
  }
  if (raw.startsWith(CLIENT_JOB_ID_PREFIX)) {
    return namespacedClientJobId('s', Buffer.from(raw, 'utf8'));
  }
  return redacted;
}

function toFiniteNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toNumberOrNull(value) {
  return toFiniteNumber(value, null);
}

/**
 * CONTRACT §4 wants epoch ms. The real state.json stores ISO-8601 strings
 * ("2026-07-01T23:28:45.487Z"), so accept both, then fall back to fs.stat.
 * Date.parse on garbage yields NaN, which would survive JSON.stringify as
 * `null` but corrupt the updatedAt sort — hence the isFinite guard.
 */
function toEpochMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.isFinite(fallback) ? fallback : null;
}

/** First positive, finite candidate — birthtimeMs is 0 on some filesystems. */
function firstMs(...candidates) {
  for (const c of candidates) {
    // fs.stat gives fractional ms; epoch ms in the contract should be whole.
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.round(c);
  }
  return null;
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- normalisers

function normaliseInFlight(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    tasks: toFiniteNumber(src.tasks, 0),
    queued: toFiniteNumber(src.queued, 0),
    kinds: Array.isArray(src.kinds)
      ? src.kinds.filter((k) => typeof k === 'string').map(redactOrEmpty)
      : [],
  };
}

function normaliseFan(raw, now) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // Real data: fan entries todo:21..23 omit startedAt/doneAt entirely, and
    // the rest carry startedAt: 0. Both must land on 0, never undefined.
    const startedAt = toFiniteNumber(entry.startedAt, 0);
    const doneAt = toFiniteNumber(entry.doneAt, 0);
    out.push({
      id: redactOrEmpty(typeof entry.id === 'string' ? entry.id : String(entry.id ?? '')),
      kind: redactOrEmpty(typeof entry.kind === 'string' ? entry.kind : ''),
      label: redactOrEmpty(entry.label),
      startedAt,
      doneAt,
      // CONTRACT §4, verbatim. Without the falsy guard, startedAt: 0 renders
      // as ~20329 days old on every node.
      ageDays: startedAt ? Math.floor((now - startedAt) / DAY_MS) : 0,
    });
  }
  return out;
}

function toAtString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Timeline source on this machine is <dir>/timeline.jsonl — one JSON object
 * per line, already shaped { at, state, detail, text }. Slice the tail before
 * parsing so a long-running job's history stays cheap.
 */
function readTimeline(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8');
  } catch {
    return [];   // no timeline source for this job
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const out = [];
  for (const line of lines.slice(-TIMELINE_LIMIT)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;  // skip a torn/partial line, keep the rest
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out.push({
      at: redactOrEmpty(toAtString(entry.at)),
      state: redactOrEmpty(typeof entry.state === 'string' ? entry.state : ''),
      detail: redactOrEmpty(entry.detail),
      text: redactOrEmpty(entry.text),
    });
  }
  return out;
}

/**
 * Build the Job for one directory. Malformed/absent state.json degrades to
 * id + nulls; the container fields (inFlight/fan/timeline) keep their
 * non-nullable contract shape so the UI can dereference them unconditionally.
 */
function readJob(id) {
  const dir = path.join(CONFIG.JOBS_DIR, id);
  const statePath = path.join(dir, 'state.json');
  const now = Date.now();

  const dirStat = statOrNull(dir);
  const fileStat = statOrNull(statePath);

  let raw = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      warn(`unreadable/malformed state.json for ${id}: ${err?.message || err}`);
    }
  }

  const src = raw || {};
  const createdFallback = firstMs(dirStat?.birthtimeMs, fileStat?.birthtimeMs);
  const updatedFallback = firstMs(fileStat?.mtimeMs, dirStat?.mtimeMs);

  return {
    id: clientJobId(id),
    name: redactOrNull(src.name),
    state: redactOrNull(src.state),
    tempo: redactOrNull(src.tempo),
    detail: redactOrNull(src.detail),
    cwd: redactOrNull(src.cwd),
    sessionId: redactOrNull(src.sessionId),
    createdAt: toEpochMs(src.createdAt, createdFallback),
    updatedAt: toEpochMs(src.updatedAt, updatedFallback),
    tokens: toNumberOrNull(src.tokens),
    inFlight: normaliseInFlight(src.inFlight),
    fan: normaliseFan(src.fan, now),
    needs: redactOrNull(src.needs),
    suggestedReply: redactOrNull(src.suggestedReply),
    timeline: readTimeline(dir),
  };
}

// ------------------------------------------------------------------- map ops

function upsertJob(id) {
  try {
    const job = readJob(id);
    jobs.set(id, job);
    return job;
  } catch (err) {
    warn(`failed to read job ${id}: ${err?.message || err}`);
    return null;
  }
}

function isJobDir(entry, parent) {
  if (entry.name.startsWith('.')) return false;
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    return Boolean(statOrNull(path.join(parent, entry.name))?.isDirectory());
  }
  return false;   // pins.json and any other regular file
}

/** `<JOBS_DIR>/<id>/state.json` -> `<id>`; anything else -> null. */
function jobIdForFile(filePath) {
  const rel = path.relative(CONFIG.JOBS_DIR, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;   // a file sitting directly in JOBS_DIR
  return parts[0] || null;
}

// ------------------------------------------------------------------ watching

function scheduleRefresh(id) {
  const existing = pendingReads.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingReads.delete(id);
    if (!statOrNull(path.join(CONFIG.JOBS_DIR, id))?.isDirectory()) {
      // Directory vanished between the event and the debounce firing.
      if (jobs.delete(id)) safeEmit('job.removed', { id: clientJobId(id) });
      return;
    }
    const job = upsertJob(id);
    if (job) safeEmit('job.state', job);
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingReads.set(id, timer);
}

function onFileEvent(filePath) {
  try {
    if (!WATCHED_FILES.has(path.basename(filePath))) return;
    const id = jobIdForFile(filePath);
    if (id) scheduleRefresh(id);
  } catch (err) {
    warn('file event failed:', err?.message || err);
  }
}

function onDirRemoved(dirPath) {
  try {
    const rel = path.relative(CONFIG.JOBS_DIR, dirPath);
    // Only a direct child of JOBS_DIR is a job. `<id>/tmp` must not remove it.
    if (!rel || rel.startsWith('..') || rel.split(path.sep).length !== 1) return;
    const timer = pendingReads.get(rel);
    if (timer) {
      clearTimeout(timer);
      pendingReads.delete(rel);
    }
    if (jobs.delete(rel)) safeEmit('job.removed', { id: clientJobId(rel) });
  } catch (err) {
    warn('unlinkDir handling failed:', err?.message || err);
  }
}

// -------------------------------------------------------------------- public

/**
 * Initial synchronous scan (so listJobs() is populated the moment this
 * returns), then a chokidar watch for incremental updates.
 */
export function startJobs() {
  if (started) return;
  started = true;

  const dir = CONFIG.JOBS_DIR;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warn(`jobs directory unavailable (${dir}): ${err?.message || err} — watching nothing`);
    return;
  }

  for (const entry of entries) {
    if (!isJobDir(entry, dir)) continue;
    const job = upsertJob(entry.name);
    if (job) safeEmit('job.state', job);
  }

  try {
    watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    watcher
      .on('add', onFileEvent)
      .on('change', onFileEvent)
      .on('unlink', onFileEvent)
      .on('unlinkDir', onDirRemoved)
      // macOS fsevents can hand back EMFILE; warn, never crash the server.
      .on('error', (err) => warn('watcher error:', err?.message || err));
  } catch (err) {
    warn(`could not watch ${dir}: ${err?.message || err}`);
    watcher = null;
  }
}

/** Synchronous snapshot, newest first, jobs with no updatedAt last. */
export function listJobs() {
  const out = Array.from(jobs.values());
  out.sort((a, b) => {
    const av = typeof a.updatedAt === 'number' ? a.updatedAt : null;
    const bv = typeof b.updatedAt === 'number' ? b.updatedAt : null;
    if (av === null && bv === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
  return out;
}
