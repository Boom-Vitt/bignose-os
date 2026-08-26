import fs from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalSessionId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function createResumeRegistry({
  now = Date.now,
  ttlMs = 3_600_000,
  max = 50,
} = {}) {
  const records = new Map();
  const boundedTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 3_600_000;
  const boundedMax = Number.isSafeInteger(max) && max > 0 ? Math.min(max, 50) : 50;

  function evictExpired(at = now()) {
    for (const [sessionId, record] of records) {
      if (at - record.capturedAt >= boundedTtl) records.delete(sessionId);
    }
  }

  function capture(sessionId, cwd) {
    if (!isCanonicalSessionId(sessionId)) {
      throw new Error('sessionId must be a valid Codex session UUID');
    }
    let realCwd;
    try {
      realCwd = fs.realpathSync(cwd);
      if (!fs.statSync(realCwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('cwd must be a valid real directory');
    }
    const capturedAt = now();
    evictExpired(capturedAt);
    records.delete(sessionId);
    const record = Object.freeze({ provider: 'codex', cwd: realCwd, capturedAt });
    records.set(sessionId, record);
    while (records.size > boundedMax) records.delete(records.keys().next().value);
    return { ...record };
  }

  function lookup(sessionId) {
    if (!isCanonicalSessionId(sessionId)) return null;
    evictExpired(now());
    const record = records.get(sessionId);
    return record ? { ...record } : null;
  }

  function clear() {
    records.clear();
  }

  return { capture, lookup, clear };
}
