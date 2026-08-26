#!/usr/bin/env node
// hooks/dispatch.js — Slice H. The script Claude Code invokes on every hook event.
//
// Contract: CONTRACT.md §3 — POST http://127.0.0.1:4317/api/hooks, body = the
// raw Claude Code hook JSON, `Authorization: Bearer <token>` → 202.
//
// THIS RUNS ON EVERY SINGLE TOOL CALL. Two rules dominate every other concern:
//
//   1. Never fail Claude Code. Exit code is ALWAYS 0 — server down, connection
//      refused, timeout, malformed stdin, missing token, unreadable file, any
//      thrown error. A non-zero exit blocks the tool call (exit 2 = "deny").
//      A missing dashboard event is a nothing; a broken session is a disaster.
//   2. Never write to stdout. Claude Code interprets hook stdout (for
//      UserPromptSubmit it is injected into the model's context). Diagnostics
//      go to fd 2, and only when CLAUDEOS_HOOK_DEBUG=1.
//
// Deliberately does NOT import server/lib/config.js. That module mkdir's the
// state dir, reads package.json, imports node:crypto and will GENERATE the hook
// token as a side effect. All of that is fine once, in a server; none of it is
// acceptable on every tool call. The three paths we need are inlined below and
// must stay in sync with config.js (TOKEN_PATH, PORT).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where server/lib/config.js persists the 0600 bearer token. */
export const TOKEN_PATH = path.join(os.homedir(), '.boombignose_claudeos', 'hook-token');

/** CONTRACT.md: port 4317, loopback only. */
export const ENDPOINT = `http://127.0.0.1:${process.env.CLAUDEOS_PORT || 4317}/api/hooks`;

/** Hard cap on the fetch itself, per spec. */
export const FETCH_TIMEOUT_MS = 400;

/**
 * Hard cap on total wall time inside our own code. Fires only if something
 * upstream wedges (e.g. stdin never reaches EOF). Chosen so that the absolute
 * observed ceiling — node's own ~25-35ms startup plus this budget — stays
 * comfortably under the 500ms the hook is allowed to cost a tool call.
 */
export const WATCHDOG_MS = 430;

/** Stop reading stdin past this; hook payloads are small, a huge one is a bug. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const DEBUG = process.env.CLAUDEOS_HOOK_DEBUG === '1';

/**
 * Diagnostics — stderr only, and only under CLAUDEOS_HOOK_DEBUG=1.
 * Uses fs.writeSync so the message cannot be lost to the process.exit(0) that
 * follows it (async stderr writes to a pipe can be dropped on exit).
 */
export function debug(msg) {
  if (!DEBUG) return;
  try {
    fs.writeSync(2, `[claudeos-hook] ${msg}\n`);
  } catch {
    /* stderr closed — nothing we can or should do */
  }
}

/** Exit 0, always, no matter what. The single exit point. */
function done(why) {
  debug(why);
  process.exit(0);
}

/**
 * Bearer token: env override first (matches config.js precedence), then the
 * 0600 file. Returns null when unavailable — caller then no-ops.
 */
export function readToken() {
  const fromEnv = process.env.CLAUDEOS_HOOK_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Drain stdin. Resolves with '' rather than rejecting on any error, and
 * resolves immediately when stdin is a TTY (no payload is coming).
 */
export function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    if (stream.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch {
        resolve('');
      }
    };
    stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(c);
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

/**
 * POST the raw hook JSON. Never throws. Returns the status code, or null when
 * the request could not be completed (server down, timeout, refused).
 */
export async function postHook(body, token, { endpoint = ENDPOINT, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch (err) {
    debug(`post failed: ${err && err.name ? err.name : 'Error'}: ${err && err.message}`);
    return null;
  }
}

export async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return done('empty stdin — no-op');

  // Validate only. We forward the ORIGINAL bytes: CONTRACT.md §3 says the body
  // is the raw Claude Code hook JSON, and the server derives its own fields.
  try {
    JSON.parse(raw);
  } catch {
    return done('stdin is not valid JSON — no-op');
  }

  const token = readToken();
  if (!token) return done(`no token at ${TOKEN_PATH} — no-op`);

  const status = await postHook(raw, token);
  return done(status === null ? 'dashboard unreachable — no-op' : `posted, status ${status}`);
}

// ---- entry point ------------------------------------------------------------
// Only self-executes when run directly, so the module can be imported by tests
// without firing a request or exiting the process.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  // Belt and braces: nothing below may ever produce a non-zero exit or a hang.
  process.on('uncaughtException', (err) => done(`uncaught: ${err && err.message}`));
  process.on('unhandledRejection', (err) => done(`unhandled: ${err && err.message}`));
  // Armed before any I/O. If stdin never closes or fetch wedges, we still leave
  // on time and with status 0. Intentionally NOT unref'd — it must be able to fire.
  const watchdog = setTimeout(() => done(`watchdog ${WATCHDOG_MS}ms — no-op`), WATCHDOG_MS);
  main()
    .then(() => {
      clearTimeout(watchdog);
      process.exit(0);
    })
    .catch((err) => {
      clearTimeout(watchdog);
      done(`main threw: ${err && err.message}`);
    });
}
