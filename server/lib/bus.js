// server/lib/bus.js — Slice A · in-process event bus + SSE fan-out.
//
// CONTRACT.md §2. Every server-side emission goes through emit(type, payload).
// Node builtins only; no express, no chokidar.
//
// Public surface (pinned interface table):
//   emit(type, payload) -> void
//   attach(res)         -> detachFn
//   clientCount()       -> number
// Additive hardening helper:
//   scrubForClient(value) -> JSON-safe, recursively redacted clone | null

import { CONFIG } from './config.js';
import { redact } from './redact.js';

/** Epoch-ms at module load. Single source of truth for `hello` + /api/health. */
export const serverStartedAt = Date.now();

/** Hard cap on concurrent SSE clients — a runaway tab should not eat the box. */
export const MAX_CLIENTS = 32;

/** Comment ping interval. Keeps proxies and sleepy sockets from hanging up. */
const KEEPALIVE_MS = 25_000;

/** @type {Set<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout|null, closed: boolean}>} */
const clients = new Set();

/** Optional in-process listeners (server-side taps that are not SSE clients). */
const listeners = new Set();

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const REDACTION_FAILURE = '[redacted]';
const ERROR_DESCRIPTION_FAILURE = '[unavailable error]';

function scrubString(value) {
  try {
    const out = redact(value);
    return typeof out === 'string' ? out : REDACTION_FAILURE;
  } catch {
    return REDACTION_FAILURE;
  }
}

function describeError(error) {
  let candidate = error;
  try {
    const message = error === null || error === undefined ? undefined : error.message;
    if (message !== undefined) candidate = message;
  } catch { /* fall back to coercing the thrown value */ }

  try {
    return scrubString(typeof candidate === 'string' ? candidate : String(candidate));
  } catch {
    return ERROR_DESCRIPTION_FAILURE;
  }
}

function collisionSafeKey(base, object) {
  if (!Object.prototype.hasOwnProperty.call(object, base)) return base;
  let ordinal = 2;
  let candidate = `${base}#${ordinal}`;
  while (Object.prototype.hasOwnProperty.call(object, candidate)) {
    ordinal += 1;
    candidate = `${base}#${ordinal}`;
  }
  return candidate;
}

function makeEnvelope(type, ts, payload) {
  const envelope = Object.create(null);
  Object.defineProperties(envelope, {
    type: { enumerable: true, value: type },
    ts: { enumerable: true, value: ts },
    payload: { enumerable: true, value: payload },
  });
  return envelope;
}

function makeSafeArray() {
  const array = [];
  Object.defineProperty(array, 'toJSON', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: undefined,
  });
  return array;
}

/**
 * Clone JSON-shaped data while scrubbing every string value and object key.
 * The clone is also what listeners receive, keeping one outbound boundary for
 * SSE clients and in-process taps. Circular/unserialisable payloads are handled
 * by frame()'s existing null-payload fallback.
 */
function scrubOutbound(value, seen = new WeakMap(), circularAsNull = false) {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'bigint') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return circularAsNull ? null : seen.get(value);

  if (Array.isArray(value)) {
    const out = makeSafeArray();
    seen.set(value, out);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const item = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
      const cleanItem = scrubOutbound(item, seen, circularAsNull);
      out.push(cleanItem === undefined ? null : cleanItem);
    }
    return out;
  }

  const out = Object.create(null);
  seen.set(value, out);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
    const cleanValue = scrubOutbound(descriptor.value, seen, circularAsNull);
    if (cleanValue === undefined) continue;
    const cleanKey = collisionSafeKey(scrubString(key), out);
    Object.defineProperty(out, cleanKey, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cleanValue,
    });
  }
  return out;
}

/**
 * Clone a value for an HTTP/client boundary using the exact same redaction and
 * descriptor-only traversal as SSE. Unlike frame(), repeated/circular
 * references degrade at their point of recurrence so the returned clone is
 * always JSON-safe while preserving the rest of the DTO.
 *
 * Accessors, executable values, inherited properties, and serializer hooks are
 * never copied. Any hostile descriptor trap fails closed to null.
 * @param {unknown} value
 * @returns {unknown}
 */
export function scrubForClient(value) {
  try {
    const clean = scrubOutbound(value, new WeakMap(), true);
    return clean === undefined ? null : clean;
  } catch {
    return null;
  }
}

function frame(type, payload) {
  const ts = Date.now();
  try {
    const scrubbedPayload = scrubOutbound(payload);
    const envelope = makeEnvelope(
      scrubOutbound(type),
      ts,
      scrubbedPayload === undefined ? null : scrubbedPayload,
    );
    const json = JSON.stringify(envelope);
    return {
      chunk: `data: ${json}\n\n`,
      envelope,
    };
  } catch (err) {
    // Circular / unserialisable payload from a misbehaving slice. Degrade to a
    // typed envelope with a null payload rather than throwing into their code.
    const safeType = typeof type === 'string' ? scrubString(type) : '';
    console.warn('[claudeos] bus: unserialisable payload for', safeType, '-', describeError(err));
    try {
      const envelope = makeEnvelope(
        safeType,
        ts,
        null,
      );
      const json = JSON.stringify(envelope);
      return {
        chunk: `data: ${json}\n\n`,
        envelope,
      };
    } catch {
      return null;
    }
  }
}

function drop(client) {
  if (client.closed) return;
  client.closed = true;
  if (client.timer) {
    clearInterval(client.timer);
    client.timer = null;
  }
  clients.delete(client);
  try {
    client.res.end();
  } catch { /* already gone */ }
}

function write(client, chunk) {
  if (client.closed) return false;
  try {
    if (client.res.write(chunk) === false) {
      drop(client);
      return false;
    }
    return true;
  } catch {
    drop(client);
    return false;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Broadcast an SSE envelope to every attached client. Never throws.
 * @param {string} type one of CONTRACT.md §2's frozen type values
 * @param {unknown} payload
 */
export function emit(type, payload) {
  const outbound = frame(type, payload);
  if (outbound === null) return;

  // Snapshot: drop() mutates `clients` while we iterate.
  for (const client of [...clients]) write(client, outbound.chunk);

  for (const fn of [...listeners]) {
    try {
      fn(outbound.envelope.type, outbound.envelope.payload);
    } catch (err) {
      console.warn('[claudeos] bus listener threw:', describeError(err));
    }
  }
}

/**
 * Register an SSE client. Sets stream headers, sends `hello` immediately,
 * starts the keepalive ping.
 * @param {import('node:http').ServerResponse} res
 * @returns {() => void} detach — idempotent
 */
export function attach(res) {
  if (clients.size >= MAX_CLIENTS) {
    try {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many event stream clients', max: MAX_CLIENTS }));
    } catch { /* client already hung up */ }
    return () => {};
  }

  const client = { res, timer: null, closed: false };
  let detached = false;

  const detach = () => {
    if (detached) return;
    detached = true;
    drop(client);
  };

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // SSE is many small writes; Nagle would batch them into visible lag.
    res.socket?.setNoDelay?.(true);
    res.setTimeout?.(0);
  } catch (err) {
    console.warn('[claudeos] bus: could not open event stream:', describeError(err));
    detach();
    return detach;
  }

  clients.add(client);

  // Belt and braces — index.js also wires req.on('close'). detach is idempotent.
  res.on?.('close', detach);
  res.on?.('error', detach);

  const hello = frame('hello', { serverStartedAt, version: CONFIG.VERSION });
  if (hello !== null && !write(client, hello.chunk)) return detach;

  client.timer = setInterval(() => {
    write(client, ': keepalive\n\n');
  }, KEEPALIVE_MS);
  client.timer.unref?.();

  return detach;
}

/** @returns {number} currently attached SSE clients */
export function clientCount() {
  return clients.size;
}

/**
 * Tap the bus from inside the process (not an SSE client).
 * @param {(type: string, payload: unknown) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onEvent(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** End every stream. Used by index.js on SIGINT/SIGTERM so close() can finish. */
export function closeAll() {
  for (const client of [...clients]) drop(client);
}
