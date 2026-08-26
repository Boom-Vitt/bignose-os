// public/js/sse.js — Slice F · the single SSE pipe for the whole app.
//
// CONTRACT.md §2: the server sends UNNAMED messages whose `data` line is a
// single JSON object `{ type, ts, payload }`. It never sets an event name, so
// everything arrives on `onmessage` and is dispatched here by `msg.type`.
// Using addEventListener(type) against this stream would silently receive
// nothing — do not "fix" it that way.

/** Frozen list from CONTRACT.md §2. Anything else is logged once and dropped. */
export const EVENT_TYPES = Object.freeze([
  'hello',
  'job.state',
  'job.removed',
  'hook.event',
  'run.started',
  'run.delta',
  'run.tool',
  'run.done',
  'graph.invalidated',
  'catalog.invalidated',
]);

export const EVENTS_ENDPOINT = '/api/events';
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;

/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();

/** @type {EventSource|null} */
let source = null;
let state = 'closed';
let attempt = 0;
let retryTimer = null;
let started = false;

const unknownTypesSeen = new Set();

function setState(next) {
  if (state === next) return;
  state = next;
  dispatch('__state', { state: next });
}

/** Deliver to one subscriber set; a throwing callback must never break its peers. */
function fanOut(set, payload, type) {
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(payload, type);
    } catch (err) {
      console.warn(`[sse] subscriber for "${type}" threw:`, err);
    }
  }
}

function dispatch(type, payload) {
  fanOut(subscribers.get(type), payload, type);
  if (type !== '__state') fanOut(subscribers.get('*'), payload, type);
}

/** Exponential backoff, 1s to 30s, jittered so many tabs never resynchronise. */
function scheduleReconnect() {
  if (retryTimer !== null) return;
  const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
  const delay = base * (0.7 + Math.random() * 0.6);
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, Math.min(delay, BACKOFF_MAX));
}

function open() {
  if (source) return;
  setState('connecting');
  try {
    source = new EventSource(EVENTS_ENDPOINT);
  } catch (err) {
    // EventSource construction itself failed (bad URL, blocked scheme).
    source = null;
    setState('closed');
    console.warn('[sse] could not open stream:', err?.message ?? err);
    scheduleReconnect();
    return;
  }

  source.onopen = () => {
    attempt = 0;
    setState('open');
  };

  source.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // a malformed frame is dropped, never thrown
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (!EVENT_TYPES.includes(msg.type)) {
      if (!unknownTypesSeen.has(msg.type)) {
        unknownTypesSeen.add(msg.type);
        console.warn(`[sse] ignoring event type outside CONTRACT.md §2: "${msg.type}"`);
      }
      return;
    }
    dispatch(msg.type, msg.payload);
  };

  source.onerror = () => {
    // EventSource retries on its own, but with no backoff ceiling we control.
    // Close it and drive reconnection ourselves so a dead server never spins.
    try { source.close(); } catch { /* already closed */ }
    source = null;
    setState('closed');
    scheduleReconnect();
  };
}

/**
 * Open the shared stream. Idempotent — safe to call from every module that
 * needs events; only the first call creates the EventSource.
 */
export function connect() {
  if (started) return;
  started = true;
  open();
}

/**
 * Listen for one CONTRACT.md §2 event type.
 * `'*'` receives every event (debugging), `'__state'` receives connection
 * changes as `{ state }`.
 *
 * @param {string} type
 * @param {(payload: any, type: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(type, fn) {
  if (typeof fn !== 'function') return () => {};
  let set = subscribers.get(type);
  if (!set) {
    set = new Set();
    subscribers.set(type, set);
  }
  set.add(fn);
  connect(); // subscribing implies wanting the stream
  return () => {
    const s = subscribers.get(type);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(type);
  };
}

/** @returns {'connecting'|'open'|'closed'} */
export function connectionState() {
  return state;
}
