import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { redact } from './redact.js';
import { resolveCodexBin } from './providers.js';

const TTL_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;
const AUTOMATION_TOKEN = /^[A-Za-z0-9._:;=,+/-]+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._@:+()'-]{0,159}$/u;
const PROVIDER_ORDER = new Map([['claude', 0], ['codex', 1]]);
const KIND_ORDER = new Map([['plugin', 0], ['mcp', 1]]);
const listeners = new Set();

let cache = null;
let inFlight = null;
let generation = 0;
let baselineFingerprint = null;

const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function ownValue(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeScalar(value, pattern) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) return null;
  return trimmed;
}

function scrub(value) {
  try {
    const clean = redact(value);
    return typeof clean === 'string' ? clean : '[redacted]';
  } catch {
    return '[redacted]';
  }
}

function uniqueApplications(rows) {
  const selected = new Map();
  for (const row of [...rows].sort(compareApplications)) {
    if (!selected.has(row.id)) selected.set(row.id, row);
  }
  return [...selected.values()];
}

function metadataFingerprint(applications) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([...applications].sort(compareApplications)
      .map(({ id, name, provider, kind, version }) => ({ id, name, provider, kind, version }))))
    .digest('hex');
}

function emptyMetadata() {
  const applications = [];
  return { applications, mcpNames: [], fingerprint: metadataFingerprint(applications) };
}

export function execCodexJson(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      timeout: 2000,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export function compareApplications(left, right) {
  return ((PROVIDER_ORDER.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
      - (PROVIDER_ORDER.get(right.provider) ?? Number.MAX_SAFE_INTEGER))
    || ((KIND_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER)
      - (KIND_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER))
    || lexical(left.name, right.name)
    || lexical(left.id, right.id)
    || lexical(left.version ?? '', right.version ?? '');
}

export function parseCodexPluginJson(value) {
  const installed = ownValue(value, 'installed');
  if (!Array.isArray(installed)) return [];
  const rows = [];
  for (const entry of installed) {
    if (ownValue(entry, 'installed') !== true || ownValue(entry, 'enabled') !== true) continue;
    const pluginId = safeScalar(ownValue(entry, 'pluginId'), SAFE_ID);
    const name = safeScalar(ownValue(entry, 'name'), SAFE_NAME);
    if (!pluginId || !name) continue;
    const rawVersion = ownValue(entry, 'version');
    const version = rawVersion === null || rawVersion === undefined
      ? null
      : safeScalar(rawVersion, SAFE_VERSION);
    rows.push({
      id: `codex:plugin:${pluginId}`,
      name: scrub(name),
      provider: 'codex',
      kind: 'plugin',
      version,
    });
  }
  return uniqueApplications(rows);
}

export function parseCodexMcpJson(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const entry of value) {
    if (ownValue(entry, 'enabled') !== true) continue;
    const name = safeScalar(ownValue(entry, 'name'), SAFE_ID);
    if (!name) continue;
    rows.push({
      id: `codex:mcp:${name}`,
      name: scrub(name),
      provider: 'codex',
      kind: 'mcp',
      version: null,
    });
  }
  return uniqueApplications(rows);
}

function parseAutomationScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' && !/[\u0000-\u001f\u007f]/.test(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return AUTOMATION_TOKEN.test(trimmed) ? trimmed : null;
}

export function parseCodexAutomation(text, fallbackId) {
  if (typeof text !== 'string') return null;
  const fields = Object.create(null);
  let accepted = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(id|name|status|rrule)\s*=\s*(.+)$/);
    if (!match) continue;
    const value = parseAutomationScalar(match[2]);
    if (value === null) return null;
    fields[match[1]] = value;
    accepted += 1;
  }
  if (accepted === 0) return null;

  const id = safeScalar(fields.id ?? fallbackId, SAFE_ID);
  if (!id) return null;
  const rawName = fields.name ?? id;
  if (typeof rawName !== 'string' || rawName.trim() === '' || rawName.length > 160) return null;
  const schedule = fields.rrule === undefined ? null : safeScalar(fields.rrule, AUTOMATION_TOKEN);
  if (fields.rrule !== undefined && schedule === null) return null;

  return {
    id: `codex:${scrub(id)}`,
    name: scrub(rawName.trim()),
    schedule: schedule === null ? null : scrub(schedule),
    runner: 'desktop',
    lastRunAt: null,
    nextRunAt: null,
    status: 'idle',
    provider: 'codex',
  };
}

function publishFingerprint(fingerprint) {
  const previousFingerprint = baselineFingerprint;
  baselineFingerprint = fingerprint;
  if (previousFingerprint === null || previousFingerprint === fingerprint) return;
  const notice = { previousFingerprint, fingerprint };
  for (const listener of [...listeners]) {
    try { listener(notice); } catch { /* one listener cannot break a refresh */ }
  }
}

async function refreshMetadata({ bin, execJson, loadedAt }) {
  let execute = execJson;
  if (typeof execute !== 'function') {
    const resolvedBin = bin ?? resolveCodexBin();
    if (resolvedBin === null) return emptyMetadata();
    execute = (args) => execCodexJson(resolvedBin, args);
  }

  const [pluginResult, mcpResult] = await Promise.allSettled([
    Promise.resolve().then(() => execute(['plugin', 'list', '--json'])),
    Promise.resolve().then(() => execute(['mcp', 'list', '--json'])),
  ]);
  const plugins = pluginResult.status === 'fulfilled' ? parseCodexPluginJson(pluginResult.value) : [];
  const mcps = mcpResult.status === 'fulfilled' ? parseCodexMcpJson(mcpResult.value) : [];
  const applications = uniqueApplications([...plugins, ...mcps]);
  return {
    applications,
    mcpNames: mcps.map((row) => row.name).sort(lexical),
    fingerprint: metadataFingerprint(applications),
    loadedAt,
  };
}

export async function getCodexMetadata({ bin, execJson, now = Date.now, force = false } = {}) {
  const at = now();
  if (!force && cache && at >= cache.loadedAt && at - cache.loadedAt < TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  const startedGeneration = generation;
  const refresh = (async () => {
    const refreshed = await refreshMetadata({ bin, execJson, loadedAt: at });
    const loadedAt = Object.hasOwn(refreshed, 'loadedAt') ? refreshed.loadedAt : at;
    const value = {
      applications: refreshed.applications,
      mcpNames: refreshed.mcpNames,
      fingerprint: refreshed.fingerprint,
    };
    if (startedGeneration === generation) {
      cache = { loadedAt, value };
      publishFingerprint(value.fingerprint);
    }
    return value;
  })();
  inFlight = refresh.finally(() => { inFlight = null; });
  return inFlight;
}

export function clearCodexMetadataCache() {
  generation += 1;
  cache = null;
  baselineFingerprint = null;
}

export function onCodexMetadataChange(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
