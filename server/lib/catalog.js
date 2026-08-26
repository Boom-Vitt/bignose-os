// server/lib/catalog.js — Slice D · catalog
//
// Builds the CONTRACT.md §5 catalog: { skills, agents, routines, mcpServers }.
// Everything degrades to empty/null rather than throwing. Every name,
// description and path that leaves this module passes through redact().

import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { CONFIG } from './config.js';
import { emit } from './bus.js';
import { redact } from './redact.js';
import { parseFrontmatter } from './frontmatter.js';
import { readSidecar } from './sidecar.js';
import {
  codexPaths, isDeniedCodexRelativePath, normalizeProvider, readSkillOverride, skillIdentity,
} from './providers.js';
import {
  compareApplications, getCodexMetadata, parseCodexAutomation,
} from './codex-metadata.js';

const CACHE_TTL_MS = 60_000;
const WATCH_DEBOUNCE_MS = 1500;
const REDACTION_FAILURE = '[redacted]';
const rawSourcePaths = new WeakMap();

let cached = null;         // last built catalog
let cachedAt = 0;          // epoch ms of that build
let invalidated = true;    // set by the watcher / sidecar writes
let inFlight = null;       // shared promise so concurrent calls build once
let invalidationGeneration = 0;
let watcher = null;
let debounceTimer = null;
let watcherClearTimer = clearTimeout;

const EMPTY = Object.freeze({
  skills: Object.freeze([]),
  agents: Object.freeze([]),
  routines: Object.freeze([]),
  mcpServers: Object.freeze([]),
  applications: Object.freeze([]),
});

// ---------------------------------------------------------------- helpers

/**
 * redact() comes from slice B. Guard it: if it is missing or throws, replace
 * the entire string rather than allowing an unredacted value to escape.
 */
function scrub(value) {
  let s;
  try {
    s = value === null || value === undefined ? '' : String(value);
  } catch {
    return REDACTION_FAILURE;
  }
  if (s === '') return '';
  try {
    const out = redact(s);
    if (typeof out === 'string') return out;
  } catch { /* fail closed below */ }
  return REDACTION_FAILURE;
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJsonSafe(p) {
  const raw = readTextSafe(p);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readDirSafe(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .sort((a, b) => lexicalCompare(a.name, b.name));
  } catch { return []; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Dirent.isDirectory()/isFile() both report false for a SYMLINK, and a large
 * share of real skills are symlinked in (7 of 67 on this machine, pointing at
 * npm caches and ~/.agents). Fall back to statSync, which follows the link.
 */
function entryKind(full, ent) {
  if (ent.isDirectory()) return 'dir';
  if (ent.isFile()) return 'file';
  if (ent.isSymbolicLink()) {
    try {
      const st = fs.statSync(full);            // follows the link
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch { return null; }                   // dangling symlink
  }
  return null;
}

/** Stable identity for dedup: the real path when resolvable, else as given. */
function identity(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function lexicalCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rawSourcePath(filePath) {
  try {
    const real = identity(filePath);
    return typeof real === 'string' ? path.normalize(real) : '';
  } catch {
    return typeof filePath === 'string' ? filePath : '';
  }
}

function rememberRawSource(dto, filePath) {
  rawSourcePaths.set(dto, rawSourcePath(filePath));
  return dto;
}

function plainRecordOrEmpty(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : {};
  } catch {
    return {};
  }
}

/** Pick the first defined value among several frontmatter spellings. */
function pick(data, ...keys) {
  for (const k of keys) {
    if (data && Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) return data[k];
  }
  return undefined;
}

function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** `a, b, c` or `[a, b]` -> ["a","b","c"]; anything empty -> null. */
function toListOrNull(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof v === 'string') {
    const out = v.split(',').map((x) => x.trim()).filter(Boolean);
    return out.length ? out : null;
  }
  return null;
}

function scrubStringOrNull(value) {
  const string = toStringOrNull(value);
  return string === null ? null : scrub(string);
}

function scrubListOrNull(value) {
  const list = toListOrNull(value);
  return list === null ? null : list.map(scrub);
}

function toBool(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return fallback;
}

function compareByNameThenPath(a, b) {
  return lexicalCompare(a.name, b.name) ||
    lexicalCompare(a.provider ?? '', b.provider ?? '') ||
    lexicalCompare(a.path, b.path) ||
    lexicalCompare(rawSourcePaths.get(a) ?? '', rawSourcePaths.get(b) ?? '');
}

/**
 * Pick one deterministic row per exposed name. Earlier groups have higher
 * precedence; path is the stable tie-break within one source group.
 */
export function dedupeCatalogEntries(groups) {
  const selected = new Map();
  for (const group of groups) {
    for (const entry of [...group].sort(compareByNameThenPath)) {
      const entryIdentity = skillIdentity(entry.provider, entry.name);
      if (!selected.has(entryIdentity)) selected.set(entryIdentity, entry);
    }
  }
  return [...selected.values()].sort(compareByNameThenPath);
}

// ---------------------------------------------------------------- skills

/**
 * Build one Skill from a markdown file. All ten CONTRACT §5 fields are always
 * present. `model`/`effort` come from the sidecar only — never frontmatter.
 */
export function buildSkill(filePath, fallbackName, scope, sidecar, provider = 'claude') {
  const text = readTextSafe(filePath);
  const { data } = parseFrontmatter(text ?? '');
  const providerId = normalizeProvider(provider);

  const rawName = toStringOrNull(pick(data, 'name')) ?? fallbackName;
  const name = scrub(rawName);
  const side = readSkillOverride(sidecar, providerId, name);

  return rememberRawSource({
    name,
    description: scrub(toStringOrNull(pick(data, 'description')) ?? ''),
    scope: scrub(scope),
    path: scrub(filePath),
    argumentHint: scrubStringOrNull(pick(data, 'argument-hint', 'argumentHint', 'argument_hint')),
    allowedTools: scrubListOrNull(pick(data, 'allowed-tools', 'allowedTools', 'allowed_tools')),
    // Both spellings are accepted; default true.
    userInvokable: toBool(pick(data, 'user-invokable', 'user-invocable', 'userInvokable', 'userInvocable'), true),
    disableModelInvocation: toBool(
      pick(data, 'disable-model-invocation', 'disableModelInvocation', 'disable_model_invocation'), false),
    model:  side ? scrubStringOrNull(side.model) : null,
    effort: side ? scrubStringOrNull(side.effort) : null,
    provider: providerId,
  }, filePath);
}

/**
 * Scan one directory for skills. A skill is a directory containing SKILL.md,
 * or a bare `.md` file. One level only — nested skill bundles (e.g.
 * skills/heygen-skills/heygen-avatar/SKILL.md) are intentionally not recursed.
 */
function scanSkillDir(dir, scope, sidecar, out, seen) {
  for (const ent of readDirSafe(dir)) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    const kind = entryKind(full, ent);
    if (kind === 'dir') {
      const skillMd = path.join(full, 'SKILL.md');
      if (!isFile(skillMd)) continue;
      const id = identity(skillMd);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(buildSkill(skillMd, ent.name, scope, sidecar));
      continue;
    }
    if (kind === 'file' && ent.name.toLowerCase().endsWith('.md')) {
      const base = ent.name.slice(0, -3);
      if (/^(readme|changelog|license|contributing|install)$/i.test(base)) continue;
      const id = identity(full);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(buildSkill(full, base, scope, sidecar));
    }
  }
}

/** Commands may be namespaced one directory deep (commands/<ns>/<cmd>.md). */
function scanCommandDir(dir, scope, sidecar, out, seen) {
  scanSkillDir(dir, scope, sidecar, out, seen);
  for (const ent of readDirSafe(dir)) {
    const subFull = path.join(dir, ent.name);
    if (!ent.name.startsWith('.') && entryKind(subFull, ent) === 'dir') {
      const sub = subFull;
      if (isFile(path.join(sub, 'SKILL.md'))) continue;   // already taken as a skill
      scanSkillDir(sub, scope, sidecar, out, seen);
    }
  }
}

/**
 * Plugin skills. `~/.claude/plugins/` holds two very different trees:
 *   marketplaces/ — the marketplace CATALOG (every plugin offered, mostly not installed)
 *   cache/        — the installed version store
 * Using the machine's own manifest (installed_plugins.json) plus the
 * enabledPlugins flags is the only defensible definition of "installed and on".
 */
function pluginTimestamp(entry) {
  for (const field of ['lastUpdated', 'installedAt']) {
    const raw = entry[field];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function pluginCandidate(key, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.installPath !== 'string' || entry.installPath.trim() === '') return null;
  let normalizedInstallPath = entry.installPath;
  try { normalizedInstallPath = path.normalize(entry.installPath); }
  catch { /* retain the raw string as an internal deterministic key */ }
  return {
    key,
    installPath: entry.installPath,
    normalizedInstallPath,
    sourcePath: rawSourcePath(entry.installPath),
    timestamp: pluginTimestamp(entry),
    version: toStringOrNull(entry.version),
  };
}

function comparePluginVersions(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? -1 : 1;
  return lexicalCompare(a.normalizedInstallPath, b.normalizedInstallPath) ||
    lexicalCompare(a.sourcePath, b.sourcePath) ||
    lexicalCompare(a.key, b.key);
}

function comparePluginCandidates(a, b) {
  return lexicalCompare(a.normalizedInstallPath, b.normalizedInstallPath) ||
    lexicalCompare(a.sourcePath, b.sourcePath) ||
    lexicalCompare(a.key, b.key);
}

function scanPluginSkills(sidecar, enabledPlugins, out, seen) {
  const manifest = readJsonSafe(path.join(CONFIG.PLUGINS_DIR, 'installed_plugins.json'));
  const plugins = plainRecordOrEmpty(plainRecordOrEmpty(manifest).plugins);
  const chosen = [];

  for (const [key, entries] of Object.entries(plugins)) {
    if (enabledPlugins[key] !== true) continue;            // disabled or unknown -> skip
    if (!Array.isArray(entries) || entries.length === 0) continue;

    // One plugin key can have several versions. Newest valid timestamp wins;
    // equal/missing timestamps break by normalized raw path, never array order.
    let best = null;
    for (const entry of entries) {
      const candidate = pluginCandidate(key, entry);
      if (candidate && (!best || comparePluginVersions(candidate, best) < 0)) best = candidate;
    }
    if (best) chosen.push(best);
  }

  // Sort before scanning because scanSkillDir identity-dedupes symlink aliases.
  // Whichever candidate scans first owns a shared real SKILL.md identity.
  chosen.sort(comparePluginCandidates);
  for (const candidate of chosen) {
    const skillsDir = path.join(candidate.installPath, 'skills');
    scanSkillDir(skillsDir, 'plugin', sidecar, out, seen);
  }
}

// ---------------------------------------------------------------- agents

export function buildAgent(filePath, fallbackName) {
  const { data } = parseFrontmatter(readTextSafe(filePath) ?? '');
  return rememberRawSource({
    name: scrub(toStringOrNull(pick(data, 'name')) ?? fallbackName),
    description: scrub(toStringOrNull(pick(data, 'description')) ?? ''),
    model: scrubStringOrNull(pick(data, 'model')),
    tools: scrubListOrNull(pick(data, 'tools')),
    memory: scrubStringOrNull(pick(data, 'memory')),
    path: scrub(filePath),
    provider: 'claude',
  }, filePath);
}

function scanAgentDir(dir) {
  const out = [];
  for (const ent of readDirSafe(dir)) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    const kind = entryKind(full, ent);
    if (kind === 'file' && ent.name.toLowerCase().endsWith('.md')) {
      out.push(buildAgent(full, ent.name.slice(0, -3)));
    } else if (kind === 'dir') {
      // Some setups nest agents one level deep.
      for (const sub of readDirSafe(full)) {
        const subFull = path.join(full, sub.name);
        if (sub.name.startsWith('.') || !sub.name.toLowerCase().endsWith('.md')) continue;
        if (entryKind(subFull, sub) !== 'file') continue;
        out.push(buildAgent(subFull, sub.name.slice(0, -3)));
      }
    }
  }
  out.sort(compareByNameThenPath);
  return out;
}

function scanAgents() {
  return scanAgentDir(CONFIG.AGENTS_DIR);
}

/**
 * Discover only the project-local Claude catalog roots. Missing, malformed or
 * unreadable roots degrade independently to empty lists.
 */
export function discoverProjectCatalog(projectRoot, sidecar) {
  const empty = { skills: [], agents: [] };
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return empty;

  const claudeDir = path.join(projectRoot, '.claude');
  const skills = [];
  try {
    scanSkillDir(path.join(claudeDir, 'skills'), 'project', sidecar, skills, new Set());
  } catch {
    skills.length = 0;
  }

  let agents = [];
  try { agents = scanAgentDir(path.join(claudeDir, 'agents')); }
  catch { agents = []; }

  return {
    skills: dedupeCatalogEntries([skills]),
    agents: dedupeCatalogEntries([agents]),
  };
}

// ---------------------------------------------------------------- routines

const CRON_FIELDS = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week
];

/** Expand one cron field into a Set of matching numbers, or null if unparseable. */
function cronField(spec, { min, max }) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step <= 0) return null;
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) { const [a, b] = m[1].split('-').map(Number); lo = a; hi = b; }
    else { lo = Number(m[1]); hi = m[2] ? max : Number(m[1]); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/**
 * Next firing time for a standard 5-field cron expression, or null.
 * Steps minute-by-minute with a 366-day cap — plenty fast for a handful of
 * routines and far simpler than a full cron library we are not allowed to add.
 */
function nextCronRun(expr, from = Date.now()) {
  if (typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => cronField(p, CRON_FIELDS[i]));
  if (sets.some((s) => s === null)) return null;
  const [mins, hours, doms, months, dows] = sets;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 366 * 86400000;
  while (d.getTime() <= limit) {
    if (!months.has(d.getMonth() + 1)) { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!doms.has(d.getDate()) || !dows.has(d.getDay())) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hours.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!mins.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

function toEpochOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num > 1e12 ? num : num * 1000;
  }
  return null;
}

function isSameLocalDay(ts, now) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) ||
      typeof now !== 'number' || !Number.isFinite(now)) return false;
  const a = new Date(ts); const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function hasSchedule(row) {
  return typeof row?.schedule === 'string' && row.schedule.trim() !== '';
}

function compareRoutineTie(a, b) {
  const aId = typeof a?.id === 'string' ? a.id : '';
  const bId = typeof b?.id === 'string' ? b.id : '';
  const byId = lexicalCompare(aId, bId);
  if (byId !== 0) return byId;
  const aName = typeof a?.name === 'string' ? a.name : '';
  const bName = typeof b?.name === 'string' ? b.name : '';
  return lexicalCompare(aName, bName);
}

/**
 * Derive display statuses without mutating the source rows. The row with the
 * earliest finite future nextRunAt is the sole `next` row; equal times break
 * by id/name. With no eligible future run there is no fake `next`.
 */
export function deriveRoutineStatuses(rows, now) {
  const source = Array.isArray(rows) ? rows : [];
  const at = typeof now === 'number' && Number.isFinite(now) ? now : null;
  let nextIdx = -1;
  let soonest = Infinity;

  if (at !== null) {
    for (let i = 0; i < source.length; i++) {
      const row = source[i];
      const candidate = row?.nextRunAt;
      if (typeof candidate !== 'number' ||
          !Number.isFinite(candidate) || candidate <= at) continue;
      if (candidate < soonest ||
          (candidate === soonest && (nextIdx === -1 || compareRoutineTie(row, source[nextIdx]) < 0))) {
        soonest = candidate;
        nextIdx = i;
      }
    }
  }

  return source.map((row, index) => {
    const copy = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
    const lastRunAt = row?.lastRunAt;
    if (index === nextIdx) copy.status = scrub('next');
    else if (at !== null && lastRunAt <= at && isSameLocalDay(lastRunAt, at)) {
      copy.status = scrub('fired');
    } else if (hasSchedule(row)) copy.status = scrub('queued');
    else copy.status = scrub('idle');
    return copy;
  });
}

/** Read whatever config a routine directory happens to carry. */
function routineConfig(dir) {
  for (const file of ['config.json', 'schedule.json', 'task.json', 'routine.json', 'meta.json']) {
    const j = readJsonSafe(path.join(dir, file));
    if (j && typeof j === 'object') return j;
  }
  return {};
}

function inferRunner(cfg, fm) {
  const hay = JSON.stringify(cfg ?? {}).toLowerCase() + ' ' +
    String(fm?.runner ?? '').toLowerCase() + ' ' + String(fm?.platform ?? '').toLowerCase();
  if (hay.includes('hermes')) return 'hermes';
  if (hay.includes('desktop')) return 'desktop';
  return 'local';
}

function scanRoutines() {
  const rows = [];
  for (const ent of readDirSafe(CONFIG.SCHEDULED_DIR)) {
    if (ent.name.startsWith('.')) continue;
    const dir = path.join(CONFIG.SCHEDULED_DIR, ent.name);
    if (entryKind(dir, ent) !== 'dir') continue;
    const cfg = routineConfig(dir);
    const skillMd = path.join(dir, 'SKILL.md');
    const { data: fm } = parseFrontmatter(isFile(skillMd) ? (readTextSafe(skillMd) ?? '') : '');

    const schedule = scrubStringOrNull(
      cfg.schedule ?? cfg.cron ?? cfg.when ?? cfg.interval ??
      pick(fm, 'schedule', 'cron', 'when', 'interval'));

    const lastRunAt = toEpochOrNull(cfg.lastRunAt ?? cfg.lastRun ?? cfg.last_run_at ?? cfg.lastRunTime);
    let nextRunAt = toEpochOrNull(cfg.nextRunAt ?? cfg.nextRun ?? cfg.next_run_at);
    if (nextRunAt === null && schedule) nextRunAt = nextCronRun(schedule);

    rows.push({
      id: scrub(ent.name),
      name: scrub(toStringOrNull(pick(fm, 'name')) ?? toStringOrNull(cfg.name) ?? ent.name),
      schedule,
      runner: scrub(inferRunner(cfg, fm)),
      lastRunAt,
      nextRunAt,
      status: scrub('idle'),
      provider: 'claude',
    });
  }

  const derived = deriveRoutineStatuses(rows, Date.now());
  derived.sort((a, b) => lexicalCompare(a.id, b.id));
  return derived;
}

// ---------------------------------------------------------------- Codex catalog

function isWithinRealRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function allowedCanonicalCodexPath(rootReal, candidate) {
  const real = fs.realpathSync(candidate);
  if (!isWithinRealRoot(rootReal, real)) return null;
  const relative = path.relative(rootReal, real);
  if (relative === '' || isDeniedCodexRelativePath(relative)) return null;
  return real;
}

function realDirectoryWithin(rootReal, candidate) {
  try {
    const real = allowedCanonicalCodexPath(rootReal, candidate);
    return real !== null && fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function realFileWithin(rootReal, candidate) {
  try {
    const real = allowedCanonicalCodexPath(rootReal, candidate);
    return real !== null && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function scanCodexSkillLevel(root, rootReal, relativeParent, scope, sidecar, out) {
  const parent = relativeParent ? path.join(root, relativeParent) : root;
  for (const ent of readDirSafe(parent)) {
    if (ent.name.startsWith('.') || (!ent.isDirectory() && !ent.isSymbolicLink())) continue;
    const relativeDir = relativeParent ? path.join(relativeParent, ent.name) : ent.name;
    const relativeFile = path.join(relativeDir, 'SKILL.md');
    if (isDeniedCodexRelativePath(relativeDir) || isDeniedCodexRelativePath(relativeFile)) continue;
    const directory = path.join(root, relativeDir);
    if (!realDirectoryWithin(rootReal, directory)) continue;
    const skillFile = path.join(directory, 'SKILL.md');
    const realSkillFile = realFileWithin(rootReal, skillFile);
    if (!realSkillFile) continue;
    try { out.push(buildSkill(realSkillFile, ent.name, scope, sidecar, 'codex')); }
    catch { /* one malformed or unreadable skill cannot hide its siblings */ }
  }
}

function scanCodexSkills(paths, sidecar) {
  const out = [];
  let rootReal;
  try {
    rootReal = fs.realpathSync(paths.skillsDir);
    if (!fs.statSync(rootReal).isDirectory()) return out;
  } catch {
    return out;
  }

  scanCodexSkillLevel(paths.skillsDir, rootReal, '', 'user', sidecar, out);
  const systemRelative = '.system';
  if (!isDeniedCodexRelativePath(systemRelative)) {
    const systemDir = path.join(paths.skillsDir, systemRelative);
    if (realDirectoryWithin(rootReal, systemDir)) {
      scanCodexSkillLevel(paths.skillsDir, rootReal, systemRelative, 'system', sidecar, out);
    }
  }
  return dedupeCatalogEntries([out]);
}

function scanCodexAutomations(paths) {
  const out = [];
  let rootReal;
  try {
    rootReal = fs.realpathSync(paths.automationsDir);
    if (!fs.statSync(rootReal).isDirectory()) return out;
  } catch {
    return out;
  }

  for (const ent of readDirSafe(paths.automationsDir)) {
    if (ent.name.startsWith('.') || (!ent.isDirectory() && !ent.isSymbolicLink())) continue;
    const relativeDir = ent.name;
    const relativeFile = path.join(relativeDir, 'automation.toml');
    if (isDeniedCodexRelativePath(relativeDir) || isDeniedCodexRelativePath(relativeFile)) continue;
    const directory = path.join(paths.automationsDir, relativeDir);
    if (!realDirectoryWithin(rootReal, directory)) continue;
    const automationFile = path.join(directory, 'automation.toml');
    const realAutomationFile = realFileWithin(rootReal, automationFile);
    if (!realAutomationFile) continue;
    const text = readTextSafe(realAutomationFile);
    if (text === null) continue;
    try {
      const routine = parseCodexAutomation(text, ent.name);
      if (routine) out.push(routine);
    } catch { /* one malformed automation cannot hide its siblings */ }
  }
  out.sort((a, b) => lexicalCompare(a.id, b.id));
  return out;
}

export function discoverCodexCatalog(home, sidecar) {
  const paths = codexPaths(home);
  return {
    skills: scanCodexSkills(paths, sidecar),
    routines: scanCodexAutomations(paths),
  };
}

// ---------------------------------------------------------------- settings

/** Merge settings.json over settings.local.json (local wins on conflict). */
function readSettings() {
  const base = plainRecordOrEmpty(readJsonSafe(CONFIG.SETTINGS_PATH));
  const localPath = path.join(path.dirname(CONFIG.SETTINGS_PATH), 'settings.local.json');
  const local = plainRecordOrEmpty(readJsonSafe(localPath));
  const merged = { ...base, ...local };
  merged.enabledPlugins = {
    ...plainRecordOrEmpty(base.enabledPlugins),
    ...plainRecordOrEmpty(local.enabledPlugins),
  };
  merged.mcpServers = {
    ...plainRecordOrEmpty(base.mcpServers),
    ...plainRecordOrEmpty(local.mcpServers),
  };
  return merged;
}

// ~/.claude.json is a large, live file that Claude Code rewrites constantly
// (~240KB here, almost all of it `projects`). Cap what we are willing to read so
// a pathological file can never blow up the catalog.
const CLAUDE_JSON_MAX_BYTES = 32 * 1024 * 1024;

/**
 * MCP server NAMES declared in ~/.claude.json. Claude Code genuinely splits MCP
 * config across settings.json and this file, so reading only one is incomplete.
 *
 * Strictly read-only, and only the key names escape this function — the parsed
 * body goes out of scope immediately rather than being retained. Missing,
 * corrupt, unreadable or oversized all degrade to [] for this source alone,
 * never failing the wider catalog build.
 */
function readClaudeJsonMcpNames() {
  const p = path.join(CONFIG.HOME, '.claude.json');
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > CLAUDE_JSON_MAX_BYTES) return [];
    const parsed = plainRecordOrEmpty(JSON.parse(fs.readFileSync(p, 'utf8')));
    return Object.keys(plainRecordOrEmpty(parsed.mcpServers));
  } catch {
    return [];
  }
}

/**
 * mcpServers: the UNION of every real source — settings.json, settings.local.json
 * (both merged in readSettings) and names already read from ~/.claude.json —
 * deduped and sorted. This helper is pure and never treats enabled plugins as
 * MCP declarations.
 */
export function buildMcpServers(settings, claudeJsonNames) {
  let declaredNames = [];
  try {
    const root = plainRecordOrEmpty(settings);
    declaredNames = Object.keys(plainRecordOrEmpty(root.mcpServers));
  } catch { /* malformed record -> no names from this source */ }

  const direct = new Set();
  const add = (name) => {
    if (typeof name !== 'string') return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    const clean = scrub(trimmed);
    if (clean) direct.add(clean);
  };
  for (const name of declaredNames) add(name);
  if (Array.isArray(claudeJsonNames)) {
    for (const name of claudeJsonNames) add(name);
  }
  return [...direct].sort(lexicalCompare);
}

function unionNames(...groups) {
  const names = new Set();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const name of group) {
      if (typeof name !== 'string' || name.trim() === '') continue;
      const clean = scrub(name.trim());
      if (clean) names.add(clean);
    }
  }
  return [...names].sort(lexicalCompare);
}

function buildClaudeApplications(settings, mcpServers) {
  const applications = mcpServers.map((name) => ({
    id: `claude:mcp:${name}`,
    name,
    provider: 'claude',
    kind: 'mcp',
    version: null,
  }));

  const enabledPlugins = plainRecordOrEmpty(plainRecordOrEmpty(settings).enabledPlugins);
  const manifest = plainRecordOrEmpty(readJsonSafe(path.join(CONFIG.PLUGINS_DIR, 'installed_plugins.json')));
  const plugins = plainRecordOrEmpty(manifest.plugins);
  for (const [key, entries] of Object.entries(plugins)) {
    if (enabledPlugins[key] !== true || !Array.isArray(entries)) continue;
    let best = null;
    for (const entry of entries) {
      const candidate = pluginCandidate(key, entry);
      if (candidate && (!best || comparePluginVersions(candidate, best) < 0)) best = candidate;
    }
    if (!best) continue;
    const cleanId = scrub(key);
    const cleanName = scrub(key.includes('@') ? key.slice(0, key.indexOf('@')) : key);
    if (!cleanId || !cleanName) continue;
    applications.push({
      id: `claude:plugin:${cleanId}`,
      name: cleanName,
      provider: 'claude',
      kind: 'plugin',
      version: best.version === null ? null : scrub(best.version),
    });
  }
  return applications.sort(compareApplications);
}

function safeCodexApplications(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.provider !== 'codex') continue;
    if (entry.kind !== 'plugin' && entry.kind !== 'mcp') continue;
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
    const version = entry.version === null || typeof entry.version === 'string' ? entry.version : null;
    rows.push({
      id: scrub(entry.id),
      name: scrub(entry.name),
      provider: 'codex',
      kind: entry.kind,
      version: version === null ? null : scrub(version),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- build

export async function buildCatalog({ metadataLoader = getCodexMetadata } = {}) {
  const sidecar = readSidecar();
  const settings = readSettings();
  const enabledPlugins = settings.enabledPlugins ?? {};

  const userSkills = [];
  const seen = new Set();
  try { scanSkillDir(CONFIG.SKILLS_DIR, 'user', sidecar, userSkills, seen); } catch (err) { warn('skills', err); }
  try { scanCommandDir(CONFIG.COMMANDS_DIR, 'user', sidecar, userSkills, seen); } catch (err) { warn('commands', err); }

  let project = { skills: [], agents: [] };
  try { project = discoverProjectCatalog(CONFIG.REPO_ROOT, sidecar); }
  catch (err) { warn('project', err); }

  const pluginSkills = [];
  try { scanPluginSkills(sidecar, enabledPlugins, pluginSkills, seen); } catch (err) { warn('plugins', err); }

  // PATCH /catalog/skill/:name keys on exposed name. Source ordering is the
  // contract: user > project > plugin, with a stable path tie-break per source.
  let codexCatalog = { skills: [], routines: [] };
  try { codexCatalog = discoverCodexCatalog(CONFIG.HOME, sidecar); }
  catch { /* Codex filesystem failures never suppress Claude data */ }

  const skillsOut = dedupeCatalogEntries([
    userSkills, project.skills, pluginSkills, codexCatalog.skills,
  ]);

  let userAgents = [];
  try { userAgents = scanAgents(); } catch (err) { warn('agents', err); }
  const agents = dedupeCatalogEntries([userAgents, project.agents]);

  let routines = [];
  try { routines = scanRoutines(); } catch (err) { warn('routines', err); }
  routines = [...routines, ...codexCatalog.routines]
    .sort((a, b) => lexicalCompare(a.id, b.id));

  let claudeMcpServers = [];
  try { claudeMcpServers = buildMcpServers(settings, readClaudeJsonMcpNames()); }
  catch (err) { warn('mcpServers', err); }

  let codexMetadata = { applications: [], mcpNames: [] };
  try {
    const loaded = await metadataLoader();
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) codexMetadata = loaded;
  } catch {
    // Do not log metadata errors: exec failures may embed stdout/stderr or paths.
  }

  const mcpServers = unionNames(claudeMcpServers, codexMetadata.mcpNames);
  const applications = [
    ...buildClaudeApplications(settings, claudeMcpServers),
    ...safeCodexApplications(codexMetadata.applications),
  ].sort(compareApplications);

  return { skills: skillsOut, agents, routines, mcpServers, applications };
}

function warn(what, err) {
  console.warn(`[claudeos:catalog] ${what} scan failed:`, err && err.message ? err.message : err);
}

/**
 * getCatalog() -> Promise<{skills, agents, routines, mcpServers, applications}>
 * Rebuilds only when the cache was invalidated or is older than 60s.
 * Concurrent callers share one in-flight promise.
 */
export async function getCatalog({ build = buildCatalog } = {}) {
  const fresh = cached && !invalidated && (Date.now() - cachedAt) < CACHE_TTL_MS;
  if (fresh) return cached;
  if (inFlight) return inFlight;

  const startedGeneration = invalidationGeneration;
  const buildPromise = (async () => {
    try {
      const next = await build();
      cached = next;
      cachedAt = Date.now();
      if (startedGeneration === invalidationGeneration) invalidated = false;
      return next;
    } catch (err) {
      warn('build', err);
      // Never throw out of getCatalog: serve the previous good build, else empty.
      return cached ?? EMPTY;
    }
  })();

  inFlight = buildPromise.finally(() => { inFlight = null; });
  return inFlight;
}

/** Drop the cache so the next getCatalog() rebuilds. Used by the PATCH route. */
export function invalidateCatalog() {
  invalidated = true;
  invalidationGeneration += 1;
}

/**
 * startCatalogWatch() -> void
 * chokidar over existing approved Claude/Codex catalog dirs. ignoreInitial, depth 3, debounced
 * 1500ms. Invalidates the cache and emits catalog.invalidated — it does NOT
 * rebuild eagerly; the next getCatalog() pays for that.
 */
export function catalogWatchRoots({ home = CONFIG.HOME, repoRoot = CONFIG.REPO_ROOT } = {}) {
  const claudeRoot = path.join(home, '.claude');
  const projectDirs = typeof repoRoot === 'string'
    ? [path.join(repoRoot, '.claude', 'skills'), path.join(repoRoot, '.claude', 'agents')]
    : [];
  const paths = codexPaths(home);
  return [...new Set([
    path.join(claudeRoot, 'skills'),
    path.join(claudeRoot, 'agents'),
    path.join(claudeRoot, 'commands'),
    path.join(claudeRoot, 'scheduled-tasks'),
    ...projectDirs,
    paths.skillsDir,
    paths.automationsDir,
  ])];
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function startCatalogWatch({
  home = CONFIG.HOME,
  repoRoot = CONFIG.REPO_ROOT,
  watch = chokidar.watch,
  emitEvent = emit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (watcher) return;
  const approvedRoots = catalogWatchRoots({ home, repoRoot });
  const dirs = approvedRoots
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (dirs.length === 0) {
    console.warn('[claudeos:catalog] no catalog directories to watch');
    return;
  }

  const paths = codexPaths(home);
  const codexRoots = [paths.skillsDir, paths.automationsDir];
  const isIgnored = (candidate) => {
    if (typeof candidate !== 'string') return true;
    for (const root of codexRoots) {
      if (!pathWithin(root, candidate)) continue;
      const relative = path.relative(root, candidate);
      return relative === '' ? false : isDeniedCodexRelativePath(relative);
    }
    return false;
  };

  try {
    watcher = watch(dirs, {
      ignoreInitial: true,
      depth: 3,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: isIgnored,
    });
  } catch (err) {
    console.warn('[claudeos:catalog] watcher error');
    watcher = null;
    return;
  }
  watcherClearTimer = clearTimer;
  let watcherErrorWarned = false;

  const bump = (changedPath) => {
    if (typeof changedPath !== 'string' || !dirs.some((root) => pathWithin(root, changedPath))) return;
    if (isIgnored(changedPath)) return;
    invalidateCatalog();
    if (debounceTimer) clearTimer(debounceTimer);
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      try { emitEvent('catalog.invalidated', { reason: 'fs' }); }
      catch (err) { warn('emit', err); }
    }, WATCH_DEBOUNCE_MS);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  };

  watcher.on('add', bump).on('change', bump).on('unlink', bump)
    .on('addDir', bump).on('unlinkDir', bump)
    .on('error', () => {
      if (watcherErrorWarned) return;
      watcherErrorWarned = true;
      console.warn('[claudeos:catalog] watcher error');
    });
}

/** Stop the watcher (tests / shutdown). Safe to call when not watching. */
export function stopCatalogWatch() {
  if (debounceTimer) { watcherClearTimer(debounceTimer); debounceTimer = null; }
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  watcherClearTimer = clearTimeout;
}
