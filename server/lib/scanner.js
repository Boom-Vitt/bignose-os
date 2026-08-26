// server/lib/scanner.js — Slice B.
//
// Builds the Second Brain graph from explicit Claude/Codex source descriptors.
//
// DESIGN NOTE — why this is an aggregated tree, not a file listing:
// ~/.claude holds ~21,000 files on a live install. Drawing one node per file
// produces an unreadable hairball and a payload no canvas renderer can lay out.
// So directories are the primary nodes and carry bottom-up rollup counts
// (files / mdFiles / bytes); individual files only become nodes when their
// parent directory is small enough to be interesting. Total nodes are hard
// capped, dropping file nodes deepest-first, and whatever was dropped is
// reported in stats.droppedFileNodes so the UI can say so out loud.
//
// Pinned interface (other slices import these exact names):
//   startScanner() -> void
//   getGraph()     -> Promise<{nodes, edges, stats}>
//   rescan()       -> Promise<void>

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

import { CONFIG, IGNORE_DIRS, DEPTH_CAP } from './config.js';
import { redact } from './redact.js';
import { getCatalog } from './catalog.js';
import { compareApplications, onCodexMetadataChange } from './codex-metadata.js';
import { codexPaths, isDeniedCodexRelativePath } from './providers.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard ceiling on total nodes. Excess file nodes are dropped deepest-first. */
const MAX_NODES = 4000;

/** A directory only contributes file nodes if it holds at most this many files. */
const FILE_NODE_DIR_LIMIT = 40;

/**
 * Aggregation boundaries — subtrees that are structurally deep but semantically
 * shallow. Below the given ABSOLUTE node depth (root = 0) nothing is emitted;
 * everything is still walked and still counted into the boundary node's
 * files/mdFiles/bytes rollups. "Aggregate first, expand on demand."
 *
 * Which subtrees get bounded is driven by what DESIGN.md renders each ring AS,
 * not merely by node count:
 *
 *   plugins -> depth 3.  Feeds the `applications` ring, drawn as "blue hexagon
 *              badges (MCP servers) on a thin blue orbit" — a handful of heavy
 *              marks. Unbounded this subtree is 2,080 nodes (55% of the graph),
 *              which renders as a solid blue band. Depth 3 keeps `plugins`, its
 *              immediate children (marketplaces/, repos/, data/, the *.json
 *              manifests) and one node per marketplace -> ~38 nodes.
 *
 *   skills  -> depth 3.  Feeds the `skills` ring, drawn as "orange 4-point star
 *              glyphs" — also heavy marks. Unbounded it is 658 nodes and becomes
 *              the same solid-band problem in orange. Depth 3 keeps one node per
 *              skill plus its immediate contents (SKILL.md, references/,
 *              scripts/), which is the granularity the UI's Expand/Collapse
 *              controls are there to drill past.
 *
 * `projects` is deliberately NOT bounded. It feeds the `memory` ring, which
 * DESIGN.md draws as "dot arcs coloured by department" — the one ring designed
 * to carry volume, where individual labels are never read. Bounding it would
 * both empty the ring the design wants full and drop the graph below the 800
 * floor.
 */
const AGGREGATION_BOUNDARIES = new Map([
  ['plugins', 3],
  ['skills', 3],
]);

/**
 * Deepest ABSOLUTE depth at which a node under this id may be emitted.
 * @param {string} id
 * @returns {number}
 */
function emitDepthCapFor(id) {
  if (id === '') return DEPTH_CAP;
  const top = id.indexOf('/') === -1 ? id : id.slice(0, id.indexOf('/'));
  const bounded = AGGREGATION_BOUNDARIES.get(top);
  return bounded === undefined ? DEPTH_CAP : bounded;
}

/** Only these extensions are ever worth a node of their own. */
const MEANINGFUL_EXTS = new Set([
  '.md', '.json', '.js', '.ts', '.py', '.sh',
  '.txt', '.yaml', '.yml', '.toml', '.jsonl',
]);

/** Cache is served without rebuilding while younger than this. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Bumped whenever node shape, aggregation, or redaction changes. A cache
 * written by an older build is rejected rather than served: the cache file is a
 * shared on-disk surface, and serving one produced by a build with weaker
 * redaction rules would leak data the current rules would have masked.
 */
const CACHE_SCHEMA = 3;

/** fs events are noisy under an active Claude Code install — coalesce hard. */
const DEBOUNCE_MS = 2500;

/**
 * DEPTH_CAP (8) governs which nodes are EMITTED. The walk itself goes deeper so
 * that a directory's rollups genuinely "include everything beneath it" rather
 * than truncating at the cap. This safety depth only exists to bound a
 * pathological tree; real content here bottoms out around depth 15.
 */
const WALK_SAFETY_DEPTH = 24;

/** Dotfiles that are allowed through the dotfile filter (spec: .md / .json). */
const DOTFILE_ALLOWED_EXTS = new Set(['.md', '.json']);

/**
 * Dotfiles that match the allow rule but are pointless-to-plot and sensitive by
 * name. Contents are never read, but there is no reason to plot the credential
 * store at all.
 */
const SENSITIVE_BASENAMES = new Set([
  '.credentials.json',
  '.credentials',
  'credentials.json',
]);

const IGNORE_SET = new Set(IGNORE_DIRS);

// ---------------------------------------------------------------------------
// Event bus (slice A). Imported lazily so a missing/late bus.js can never break
// the graph endpoint — only event broadcast degrades, and it warns once.
// ---------------------------------------------------------------------------

let busPromise = null;
let busWarned = false;

async function emitSafe(type, payload) {
  try {
    if (!busPromise) busPromise = import('./bus.js').catch(() => null);
    const bus = await busPromise;
    if (bus && typeof bus.emit === 'function') {
      bus.emit(type, payload);
      return;
    }
    if (!busWarned) {
      busWarned = true;
      console.warn('[scanner] bus.emit unavailable — graph events not broadcast');
    }
  } catch (err) {
    if (!busWarned) {
      busWarned = true;
      console.warn('[scanner] bus emit failed:', err && err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Ring assignment — drives the Second Brain visual.
// ---------------------------------------------------------------------------

const RING_BY_TOP = new Map([
  ['skills', 'skills'],
  ['commands', 'skills'],
  ['agents', 'skills'],

  ['agent-memory', 'memory'],
  ['projects', 'memory'],
  ['sessions', 'memory'],
  ['plans', 'memory'],
  ['history.jsonl', 'memory'],
  ['memories', 'memory'],

  ['scheduled-tasks', 'routines'],
  ['jobs', 'routines'],
  ['hooks', 'routines'],
  ['automations', 'routines'],

  ['plugins', 'applications'],
  ['ide', 'applications'],

  ['AGENTS.md', 'core'],
  ['rules', 'core'],
  ['config.toml', 'core'],
]);

/**
 * @param {string} id   relative id, '' for the scan root
 * @param {number} depth
 * @returns {'core'|'skills'|'memory'|'routines'|'applications'}
 */
function ringFor(id, depth) {
  if (id === '') return 'core';

  const top = id.indexOf('/') === -1 ? id : id.slice(0, id.indexOf('/'));

  // Explicit subtree mappings win over the "directly at the root" rule, so that
  // e.g. history.jsonl lands in `memory` rather than `core`.
  const mapped = RING_BY_TOP.get(top);
  if (mapped) return mapped;
  if (top.toLowerCase().startsWith('mcp')) return 'applications';

  // "anything directly at the root" — CLAUDE.md, settings.json, and the
  // handful of unmapped top-level entries form the hub.
  if (depth === 1) return 'core';

  return 'memory';
}

// ---------------------------------------------------------------------------
// Department assignment.
//
// The spec's token lists are used verbatim, but short/ambiguous tokens are
// anchored to token boundaries. Without that, `ui` matches "build", `hr`
// matches "chrome", and `api` matches "rapid" — which paints most of the graph
// and produces exactly the noise the spec warns against.
// ---------------------------------------------------------------------------

/**
 * Three matching modes, chosen per token by how ambiguous the token is:
 *
 *   loose  — bare substring. Only for long, distinctive words ("hostinger").
 *   prefix — must start at a word boundary, suffixes allowed. This is what makes
 *            "statement" match "all-statements" and "book" match "Books-by-…"
 *            while still refusing to fire inside "notebook".
 *   strict — must be a whole token, both sides. Required for anything that could
 *            occur inside a hex id: "3d" would otherwise match the "-3d8f-" in
 *            session UUIDs like 74408a00-3d8f-423f-…
 */
function buildDeptRegex({ loose = [], prefix = [], strict = [] }) {
  const parts = [];
  if (loose.length) parts.push('(?:' + loose.join('|') + ')');
  if (prefix.length) parts.push('(?:(?:^|[^a-z0-9])(?:' + prefix.join('|') + '))');
  if (strict.length) parts.push('(?:(?:^|[^a-z0-9])(?:' + strict.join('|') + ')(?:[^a-z0-9]|$))');
  return new RegExp(parts.join('|'), 'i');
}

const DEPARTMENT_RULES = [
  ['BUSINESS', buildDeptRegex({
    loose:  ['business', 'invoice', 'financ', 'client', 'hostinger', 'partnership', 'legal'],
    prefix: ['erp', 'statement', 'proposal', 'affiliate', 'trade', 'payroll',
             'accounting', 'planner', 'express', 'skool', 'company', 'ceo'],
    strict: ['sale', 'sales', 'hr'],
  })],
  ['CONTENT', buildDeptRegex({
    loose:  ['content', 'article', 'news', 'blog', 'writ', 'seo', 'marketing',
             'slide', 'video', 'hyperframe', 'brand'],
    // 'book' is prefix, not loose: it must catch "Books-by-…" without firing
    // inside "notebook", which belongs to PERSONAL.
    prefix: ['youtube', 'tiktok', 'workshop', 'book', 'series', 'recap',
             'presentation', 'course'],
    strict: ['ppt'],
  })],
  ['COMMUNITY', buildDeptRegex({
    loose: ['community', 'social', 'email', 'collab', 'postiz', 'slack', 'discord'],
  })],
  ['PRODUCT', buildDeptRegex({
    loose:  ['product', 'plugin', 'design', 'build', 'code'],
    prefix: ['web', 'demo', 'n8n', 'agentic', 'pixel', 'automation'],
    // '3d' is strict, not prefix: both characters are hex digits, so a prefix
    // match would fire on the "-3d8f-" inside session UUIDs.
    strict: ['app', 'apps', 'dev', 'devs', 'develop', 'developer', 'development',
             'mcp', 'api', 'ui', 'ux', '3d'],
  })],
  ['PERSONAL', buildDeptRegex({
    loose:  ['personal', 'memory', 'daily', 'journal', 'obsidian'],
    prefix: ['vault', 'certification'],
    strict: ['note', 'notes', 'notebook', 'para'],
  })],
];

/**
 * Department is inferred from the node's OWN name; when nothing matches it
 * inherits the parent's. Inheritance keeps subtrees visually coherent without
 * letting one generic token in a deep path paint everything.
 * @returns {string|null}
 */
function departmentFor(name, inherited) {
  for (let i = 0; i < DEPARTMENT_RULES.length; i++) {
    if (DEPARTMENT_RULES[i][1].test(name)) return DEPARTMENT_RULES[i][0];
  }
  return inherited === undefined ? null : inherited;
}

// ---------------------------------------------------------------------------
// Entry filtering
// ---------------------------------------------------------------------------

function isIgnoredName(name) {
  return IGNORE_SET.has(name);
}

/**
 * Excluded outright: never walked, never counted, never emitted.
 * (.DS_Store arrives via IGNORE_DIRS.)
 */
function isExcludedFile(name) {
  return SENSITIVE_BASENAMES.has(name) || isIgnoredName(name);
}

/**
 * Emittable as a node of its own. Files that fail this still count toward their
 * parent's rollups — the spec requires rollups to include everything beneath a
 * directory, "including nodes you chose not to emit".
 *
 * Dotfile policy: skip dotfiles except .md / .json ones.
 */
function isEmittableFile(name) {
  if (name.charCodeAt(0) === 46 /* '.' */) {
    return DOTFILE_ALLOWED_EXTS.has(path.extname(name).toLowerCase());
  }
  return true;
}

function isSkippedDir(name) {
  if (isIgnoredName(name)) return true;
  // Dot-directories are noise (.git, .cc-writes, probe dirs). The scan ROOT is
  // itself a dot-dir but is entered directly, never through this filter.
  return name.charCodeAt(0) === 46;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function makeNode(fields) {
  return {
    id: fields.id,
    label: fields.label,
    path: fields.path,
    kind: fields.kind,
    ring: fields.ring,
    department: fields.department,
    ext: fields.ext,
    size: fields.size,
    mtime: fields.mtime,
    claudeOnly: fields.claudeOnly,
    provider: fields.provider,
    resourceKind: fields.resourceKind,
    files: fields.files,
    mdFiles: fields.mdFiles,
    bytes: fields.bytes,
    depth: fields.depth,
  };
}

/**
 * Build one redacted, collision-free path segment for a node id.
 *
 * Ids ship to the browser like every other string, so they must be redacted —
 * ~/.claude/projects encodes each project's cwd as a directory name, which
 * embeds the username. But ids are also the join keys for edges, so redaction
 * has to happen per-segment and stay stable: a child's id is its parent's id
 * plus its own redacted segment, which keeps parent<-child joins exact.
 *
 * Redaction is many-to-one, so two siblings can collapse to the same segment
 * (e.g. "-Users-bob" and "-Users-bob-" both -> "~"). `used` disambiguates them
 * so ids stay unique and no node silently overwrites another.
 *
 * @param {string} rawName  real basename on disk
 * @param {Set<string>} used  segments already taken in this directory
 * @returns {string}
 */
function uniqueSegment(rawName, used) {
  let seg = redact(rawName);
  if (!seg) seg = 'node';
  // A redacted segment must never introduce a separator, or it would forge a
  // parent id that does not exist.
  seg = seg.split('/').join('_').split('\\').join('_');
  let candidate = seg;
  let n = 2;
  while (used.has(candidate)) candidate = seg + '~' + n++;
  used.add(candidate);
  return candidate;
}

function safeMtime(stat) {
  const t = stat && typeof stat.mtimeMs === 'number' ? Math.round(stat.mtimeMs) : 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Recursive directory walk.
 *
 * Emits a node for this directory, recurses into children, and returns this
 * subtree's rollups. Rollups count EVERY file beneath the directory, including
 * files that were deliberately not emitted as nodes and files below DEPTH_CAP.
 *
 * @returns {Promise<{files:number, mdFiles:number, bytes:number}>}
 */
function idJoin(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

function relativeDepth(sourceId) {
  return sourceId === '' ? 0 : sourceId.split('/').filter(Boolean).length;
}

function providerUri(provider, sourceId = '') {
  const relative = redact(sourceId).split('\\').join('/').replace(/^\/+/, '');
  return relative ? `${provider}://${relative}` : `${provider}://`;
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

async function canonicalStat(absPath, canonicalRoot, kind) {
  try {
    const linkStat = await fs.lstat(absPath);
    if (linkStat.isSymbolicLink()) return null;
    const real = await fs.realpath(absPath);
    if (!pathWithin(canonicalRoot, real)) return null;
    const valid = kind === 'dir' ? linkStat.isDirectory() : linkStat.isFile();
    return valid ? { stat: linkStat, real } : null;
  } catch {
    return null;
  }
}

function deniedSourcePath(provider, sourceId) {
  return provider === 'codex' && sourceId !== '' && isDeniedCodexRelativePath(sourceId);
}

/** Walk one already-approved directory without following any symlink. */
async function walkDir(absPath, id, sourceId, depth, parentDept, parentId, ctx, options = {}) {
  const rollup = { files: 0, mdFiles: 0, bytes: 0 };
  const { provider, canonicalRoot } = options;
  if (deniedSourcePath(provider, sourceId)) return rollup;

  const checked = await canonicalStat(absPath, canonicalRoot, 'dir');
  if (!checked) return rollup;

  let entries;
  try {
    entries = await fs.readdir(checked.real, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch {
    return rollup;
  }

  const rawName = path.basename(absPath) || absPath;
  const dept = departmentFor(rawName, parentDept);
  const emitHere = relativeDepth(sourceId) <= emitDepthCapFor(sourceId);
  let node = null;
  if (emitHere) {
    node = makeNode({
      id,
      label: options.label ?? redact(rawName),
      path: options.path ?? providerUri(provider, sourceId),
      kind: 'dir',
      ring: ringFor(sourceId, relativeDepth(sourceId)),
      department: dept,
      ext: null,
      size: 0,
      mtime: safeMtime(checked.stat),
      claudeOnly: provider === 'claude',
      provider,
      resourceKind: 'filesystem',
      files: 0,
      mdFiles: 0,
      bytes: 0,
      depth,
    });
    ctx.nodes.set(id, node);
    ctx.dirCount += 1;
    if (parentId) ctx.edges.push({ source: parentId, target: id });
  }

  const fileEnts = [];
  const dirEnts = [];
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const childSourceId = idJoin(sourceId, ent.name);
    if (deniedSourcePath(provider, childSourceId)) continue;
    if (ent.isDirectory()) {
      if (!isSkippedDir(ent.name)
        || (provider === 'codex' && childSourceId === 'skills/.system')) dirEnts.push(ent);
    } else if (ent.isFile() && !isExcludedFile(ent.name)) {
      fileEnts.push(ent);
    }
  }

  const emitFileNodes = emitHere && fileEnts.length <= FILE_NODE_DIR_LIMIT;
  const usedSegments = new Set(options.reservedSegments ?? []);
  for (const ent of fileEnts) {
    const childAbs = path.join(checked.real, ent.name);
    const childSourceId = idJoin(sourceId, ent.name);
    const child = await canonicalStat(childAbs, canonicalRoot, 'file');
    if (!child) continue;
    const size = Number.isFinite(child.stat.size) ? child.stat.size : 0;
    const ext = path.extname(ent.name).toLowerCase();

    rollup.files += 1;
    rollup.bytes += size;
    if (ext === '.md') rollup.mdFiles += 1;
    ctx.fileCount += 1;
    if (!emitFileNodes || !MEANINGFUL_EXTS.has(ext) || !isEmittableFile(ent.name)) continue;

    const seg = uniqueSegment(ent.name, usedSegments);
    const childId = idJoin(id, seg);
    const childDepth = depth + 1;
    if (relativeDepth(childSourceId) > emitDepthCapFor(childSourceId)) continue;
    ctx.nodes.set(childId, makeNode({
      id: childId,
      label: redact(ent.name),
      path: providerUri(provider, childSourceId),
      kind: 'file',
      ring: ringFor(childSourceId, relativeDepth(childSourceId)),
      department: departmentFor(ent.name, dept),
      ext: ext || null,
      size,
      mtime: safeMtime(child.stat),
      claudeOnly: provider === 'claude',
      provider,
      resourceKind: 'filesystem',
      files: 0,
      mdFiles: 0,
      bytes: 0,
      depth: childDepth,
    }));
    ctx.edges.push({ source: id, target: childId });
  }

  if (depth < WALK_SAFETY_DEPTH) {
    for (const ent of dirEnts) {
      const childSourceId = idJoin(sourceId, ent.name);
      const seg = uniqueSegment(ent.name, usedSegments);
      const childId = idJoin(id, seg);
      const sub = await walkDir(path.join(checked.real, ent.name), childId, childSourceId,
        depth + 1, dept, id, ctx, { provider, canonicalRoot });
      rollup.files += sub.files;
      rollup.mdFiles += sub.mdFiles;
      rollup.bytes += sub.bytes;
    }
  }

  if (node) Object.assign(node, rollup);
  return rollup;
}

async function walkFileMount(mount, provider, providerId, canonicalRoot, ctx) {
  if (deniedSourcePath(provider, mount.id)) return { files: 0, mdFiles: 0, bytes: 0 };
  const checked = await canonicalStat(mount.absPath, canonicalRoot, 'file');
  if (!checked || isExcludedFile(path.basename(mount.absPath))) {
    return { files: 0, mdFiles: 0, bytes: 0 };
  }
  const name = path.basename(mount.absPath);
  const ext = path.extname(name).toLowerCase();
  const size = Number.isFinite(checked.stat.size) ? checked.stat.size : 0;
  const rollup = { files: 1, mdFiles: ext === '.md' ? 1 : 0, bytes: size };
  ctx.fileCount += 1;
  if (!MEANINGFUL_EXTS.has(ext) || !isEmittableFile(name)) return rollup;
  const id = idJoin(providerId, uniqueSegment(mount.id, new Set()));
  ctx.nodes.set(id, makeNode({
    id,
    label: redact(name),
    path: providerUri(provider, mount.id),
    kind: 'file',
    ring: ringFor(mount.id, relativeDepth(mount.id)),
    department: departmentFor(name, null),
    ext: ext || null,
    size,
    mtime: safeMtime(checked.stat),
    claudeOnly: provider === 'claude',
    provider,
    resourceKind: 'filesystem',
    files: 0,
    mdFiles: 0,
    bytes: 0,
    depth: 2,
  }));
  ctx.edges.push({ source: providerId, target: id });
  return rollup;
}

/**
 * Enforce MAX_NODES by dropping file nodes deepest-first. Directory nodes are
 * never dropped — they carry the rollups, so removing one would silently lose
 * the weight of everything beneath it.
 * @returns {number} how many file nodes were dropped
 */
function enforceNodeCap(ctx) {
  if (ctx.nodes.size <= MAX_NODES) return 0;

  const fileNodes = [];
  for (const node of ctx.nodes.values()) {
    if (node.kind === 'file') fileNodes.push(node);
  }
  // Deepest first; within a depth, largest id last so ordering is stable.
  fileNodes.sort((a, b) => (b.depth - a.depth) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  let toDrop = ctx.nodes.size - MAX_NODES;
  let dropped = 0;
  for (let i = 0; i < fileNodes.length && toDrop > 0; i++) {
    ctx.nodes.delete(fileNodes[i].id);
    toDrop--;
    dropped++;
  }
  return dropped;
}

/**
 * Full rebuild. Defensive throughout: a malformed or unreadable tree degrades
 * to a smaller graph rather than throwing.
 */
export function buildGraphSources({ home = CONFIG.HOME, claudeDir = path.join(home, '.claude') } = {}) {
  const paths = codexPaths(home);
  return [
    {
      provider: 'claude',
      id: 'claude',
      label: 'CLAUDE',
      mounts: [{ id: '', absPath: claudeDir, kind: 'dir' }],
    },
    {
      provider: 'codex',
      id: 'codex',
      label: 'CODEX',
      mounts: [
        { id: 'AGENTS.md', absPath: paths.agentsFile, kind: 'file' },
        { id: 'rules', absPath: paths.rulesDir, kind: 'dir' },
        { id: 'skills', absPath: paths.skillsDir, kind: 'dir' },
        { id: 'memories', absPath: paths.memoriesDir, kind: 'dir' },
        { id: 'automations', absPath: paths.automationsDir, kind: 'dir' },
        { id: 'config.toml', absPath: paths.configFile, kind: 'file' },
      ],
    },
  ];
}

function syntheticNode({ id, label, provider, ring = 'core', depth, pathValue }) {
  return makeNode({
    id, label, path: pathValue, kind: 'dir', ring, department: null, ext: null,
    size: 0, mtime: 0, claudeOnly: provider === 'claude', provider,
    resourceKind: undefined, files: 0, mdFiles: 0, bytes: 0, depth,
  });
}

function safeApplications(applications) {
  if (!Array.isArray(applications)) return [];
  return applications.filter((entry) => entry && typeof entry === 'object'
    && (entry.provider === 'claude' || entry.provider === 'codex')
    && (entry.kind === 'plugin' || entry.kind === 'mcp')
    && typeof entry.id === 'string' && entry.id.startsWith(`${entry.provider}:${entry.kind}:`)
    && typeof entry.name === 'string' && entry.name.trim() !== '');
}

function safeApplicationSegment(rawId, used) {
  const bounded = redact(rawId).slice(0, 160).replace(/[^A-Za-z0-9._@:+-]/g, '_');
  const base = bounded === '' || bounded === '.' || bounded === '..' ? 'application' : bounded;
  return uniqueSegment(base, used);
}

export async function buildGraphFromSources(sourceDescriptors, {
  applications = [], now = Date.now,
} = {}) {
  const startedAt = now();
  const ctx = {
    nodes: new Map(),
    edges: [],
    fileCount: 0,
    dirCount: 0,
  };

  ctx.nodes.set('agent-core', syntheticNode({
    id: 'agent-core', label: 'AGENT CORE', provider: 'unified', depth: 0,
    pathValue: 'agent://core',
  }));
  ctx.dirCount = 1;

  const descriptors = Array.isArray(sourceDescriptors) ? sourceDescriptors : [];
  const apps = safeApplications(applications).slice().sort(compareApplications);
  const appsByProvider = new Map([['claude', []], ['codex', []]]);
  for (const app of apps) appsByProvider.get(app.provider).push(app);

  const ensureProviderRoot = (descriptor) => {
    if (ctx.nodes.has(descriptor.id)) return ctx.nodes.get(descriptor.id);
    const node = syntheticNode({
      id: descriptor.id, label: descriptor.label, provider: descriptor.provider,
      depth: 1, pathValue: `${descriptor.provider}://`,
    });
    ctx.nodes.set(descriptor.id, node);
    ctx.edges.push({ source: 'agent-core', target: descriptor.id });
    ctx.dirCount += 1;
    return node;
  };

  for (const descriptor of descriptors) {
    if (!descriptor || (descriptor.provider !== 'claude' && descriptor.provider !== 'codex')
      || typeof descriptor.id !== 'string' || !Array.isArray(descriptor.mounts)) continue;
    const existingMounts = [];
    for (const mount of descriptor.mounts) {
      if (!mount || typeof mount.absPath !== 'string' || typeof mount.id !== 'string'
        || (mount.kind !== 'dir' && mount.kind !== 'file')) continue;
      if (deniedSourcePath(descriptor.provider, mount.id)) continue;
      try {
        const linkStat = await fs.lstat(mount.absPath);
        if (linkStat.isSymbolicLink()) continue;
        if (mount.kind === 'dir' ? !linkStat.isDirectory() : !linkStat.isFile()) continue;
        existingMounts.push({ mount, canonicalRoot: await fs.realpath(mount.absPath) });
      } catch { /* one missing approved mount does not hide another */ }
    }
    if (existingMounts.length === 0 && appsByProvider.get(descriptor.provider).length === 0) continue;
    const hasProviderRootMount = existingMounts.some(({ mount }) => mount.id === '' && mount.kind === 'dir');
    let providerRoot = hasProviderRootMount ? null : ensureProviderRoot(descriptor);

    for (const { mount, canonicalRoot } of existingMounts) {
      let rollup;
      if (mount.kind === 'dir') {
        const isProviderRoot = mount.id === '';
        rollup = await walkDir(mount.absPath,
          isProviderRoot ? descriptor.id : idJoin(descriptor.id, mount.id),
          mount.id,
          isProviderRoot ? 1 : 2,
          null,
          isProviderRoot ? 'agent-core' : descriptor.id,
          ctx,
          {
            provider: descriptor.provider,
            canonicalRoot,
            label: isProviderRoot ? descriptor.label : undefined,
            path: isProviderRoot ? `${descriptor.provider}://` : undefined,
            reservedSegments: isProviderRoot && appsByProvider.get(descriptor.provider).length > 0
              ? ['applications'] : undefined,
          });
        if (isProviderRoot) providerRoot = ctx.nodes.get(descriptor.id);
      } else {
        if (!providerRoot) providerRoot = ensureProviderRoot(descriptor);
        rollup = await walkFileMount(mount, descriptor.provider, descriptor.id,
          path.dirname(canonicalRoot), ctx);
      }
      if (mount.id !== '' && providerRoot) {
        providerRoot.files += rollup.files;
        providerRoot.mdFiles += rollup.mdFiles;
        providerRoot.bytes += rollup.bytes;
      }
    }
  }

  for (const descriptor of descriptors) {
    if (!descriptor || !appsByProvider.has(descriptor.provider)) continue;
    const providerApps = appsByProvider.get(descriptor.provider);
    if (providerApps.length === 0) continue;
    ensureProviderRoot(descriptor);
    const containerId = `${descriptor.id}/applications`;
    if (!ctx.nodes.has(containerId)) {
      ctx.nodes.set(containerId, syntheticNode({
        id: containerId, label: 'Applications', provider: descriptor.provider,
        ring: 'applications', depth: 2,
        pathValue: `${descriptor.provider}://applications`,
      }));
      ctx.edges.push({ source: descriptor.id, target: containerId });
      ctx.dirCount += 1;
    }
    const usedByKind = new Map();
    for (const app of providerApps) {
      let used = usedByKind.get(app.kind);
      if (!used) { used = new Set(); usedByKind.set(app.kind, used); }
      const rawId = app.id.slice(`${app.provider}:${app.kind}:`.length);
      const segment = safeApplicationSegment(rawId, used);
      const appId = `${containerId}/${app.kind}/${segment}`;
      ctx.nodes.set(appId, makeNode({
        id: appId,
        label: redact(app.name),
        path: `${app.provider}://applications/${app.kind}/${encodeURIComponent(segment)}`,
        kind: 'dir',
        ring: 'applications',
        department: null,
        ext: null,
        size: 0,
        mtime: 0,
        claudeOnly: app.provider === 'claude',
        provider: app.provider,
        resourceKind: app.kind,
        files: 0,
        mdFiles: 0,
        bytes: 0,
        depth: 3,
      }));
      ctx.edges.push({ source: containerId, target: appId });
      ctx.dirCount += 1;
    }
  }

  const providerRoots = [...ctx.nodes.values()].filter((node) => node.depth === 1);
  const totalBytes = providerRoots.reduce((sum, node) => sum + node.bytes, 0);
  const core = ctx.nodes.get('agent-core');
  core.files = providerRoots.reduce((sum, node) => sum + node.files, 0);
  core.mdFiles = providerRoots.reduce((sum, node) => sum + node.mdFiles, 0);
  core.bytes = totalBytes;

  const preCapNodes = ctx.nodes.size;
  const droppedFileNodes = enforceNodeCap(ctx);

  // Edges may now reference dropped targets — keep only joinable ones.
  const edges = ctx.edges.filter(
    (e) => ctx.nodes.has(e.target) && ctx.nodes.has(e.source)
  );
  const nodes = Array.from(ctx.nodes.values());

  const builtAt = now();
  return {
    schema: CACHE_SCHEMA,
    builtAt,
    nodes,
    edges,
    stats: {
      schemaVersion: 2,
      nodes: nodes.length,
      edges: edges.length,
      files: ctx.fileCount,
      dirs: ctx.dirCount,
      bytes: totalBytes,
      droppedFileNodes,
      preCapNodes,
      maxNodes: MAX_NODES,
      depthCap: DEPTH_CAP,
      builtAt,
      ms: builtAt - startedAt,
    },
  };
}

async function buildGraph() {
  let applications = [];
  try {
    const catalog = await getCatalog();
    if (catalog && Array.isArray(catalog.applications)) applications = catalog.applications;
  } catch {
    applications = [];
  }
  return buildGraphFromSources(buildGraphSources(), { applications });
}

// ---------------------------------------------------------------------------
// Cache + concurrency
// ---------------------------------------------------------------------------

let memCache = null;      // { builtAt, nodes, edges, stats }
let memCacheGeneration = -1;
let buildPromise = null;  // in-flight build, shared by all callers
let invalidatedAt = 0;    // caches older than this are dead
let invalidationGeneration = 0;

function isFresh(entry, entryGeneration = null) {
  if (!entry || typeof entry.builtAt !== 'number') return false;
  if (entry.schema !== CACHE_SCHEMA) return false;   // older/newer build -> rebuild
  if (!Array.isArray(entry.nodes) || !Array.isArray(entry.edges)) return false;
  const age = Date.now() - entry.builtAt;
  if (!Number.isFinite(age)) return false;
  if (age < 0) return false;               // clock skew / future stamp -> rebuild
  if (age > CACHE_TTL_MS) return false;
  if (entryGeneration === null || entryGeneration !== invalidationGeneration) {
    if (entry.builtAt <= invalidatedAt) return false;
  }
  return true;
}

function shape(entry) {
  return { nodes: entry.nodes, edges: entry.edges, stats: entry.stats };
}

async function readCache() {
  try {
    const raw = await fs.readFile(CONFIG.GRAPH_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    if (typeof parsed.builtAt !== 'number') return null;
    if (!parsed.stats || typeof parsed.stats !== 'object') return null;
    return parsed;
  } catch {
    // Missing or corrupt — rebuild silently, exactly as specified.
    return null;
  }
}

async function writeCache(entry) {
  const tmp = CONFIG.GRAPH_CACHE_PATH + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
    await fs.rename(tmp, CONFIG.GRAPH_CACHE_PATH);
  } catch (err) {
    console.warn('[scanner] could not persist graph cache:', err && err.message);
    try { await fs.unlink(tmp); } catch { /* nothing to clean */ }
  }
}

async function discardDiskCache() {
  try { await fs.unlink(CONFIG.GRAPH_CACHE_PATH); } catch { /* absent or already replaced */ }
  try { await fs.unlink(CONFIG.GRAPH_CACHE_PATH + '.tmp'); } catch { /* absent */ }
}

function startBuild() {
  buildPromise = (async () => {
    while (true) {
      const startedGeneration = invalidationGeneration;
      const built = await buildGraph();
      if (startedGeneration !== invalidationGeneration) continue;

      await writeCache(built);
      if (startedGeneration !== invalidationGeneration) {
        // The write may have renamed a now-stale schema-3 entry. Remove it
        // before rebuilding so a restart cannot accept it through the TTL.
        await discardDiskCache();
        continue;
      }

      // No await occurs between this final generation check and publication.
      // Every caller sharing buildPromise therefore receives the same fresh
      // graph, never the superseded attempt.
      memCache = built;
      memCacheGeneration = startedGeneration;
      return shape(built);
    }
  })().finally(() => {
    buildPromise = null;
  });
  return buildPromise;
}

export function invalidateGraph() {
  invalidationGeneration += 1;
  invalidatedAt = Date.now();
  memCache = null;
  memCacheGeneration = -1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serve the graph, rebuilding only when the cache is stale, invalidated, or
 * unreadable. Concurrent callers share a single in-flight build.
 * @returns {Promise<{nodes:Array, edges:Array, stats:Object}>}
 */
export async function getGraph() {
  if (buildPromise) return buildPromise;
  if (isFresh(memCache, memCacheGeneration)) return shape(memCache);

  const disk = await readCache();
  if (isFresh(disk)) {
    memCache = disk;
    memCacheGeneration = invalidationGeneration;
    return shape(disk);
  }
  // Another caller may have started a build while we were reading the cache.
  if (buildPromise) return buildPromise;
  return startBuild();
}

/**
 * Force-invalidate, rebuild now, and announce it.
 * @returns {Promise<void>}
 */
export async function rescan() {
  invalidateGraph();
  if (buildPromise) {
    // Let any pre-invalidation build settle so we don't run two walks at once.
    try { await buildPromise; } catch { /* superseded anyway */ }
  }
  try {
    await startBuild();
  } catch (err) {
    console.warn('[scanner] rescan failed:', err && err.message);
  }
  await emitSafe('graph.invalidated', { reason: 'manual' });
}

let watcher = null;
let debounceTimer = null;
let watcherClearTimer = clearTimeout;
let metadataUnsubscribe = null;
let scannerStarted = false;

function buildIgnoredRegex() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = IGNORE_DIRS.map(esc).concat([
    '\\.DS_Store',
    '\\.cc-writes',
    '\\.__probe.*',
    '.*\\.tmp',
    '.*\\.swp',
    '.*\\.lock',
    '.*~',
  ]);
  // Matches an ignored path SEGMENT. Deliberately not a blanket dotfile rule —
  // the scan root itself (~/.claude) is a dot-directory.
  return new RegExp('(^|[\\\\/])(' + names.join('|') + ')([\\\\/]|$)');
}

/**
 * Watch the scan roots and invalidate (never rebuild) on change.
 * Idempotent — calling twice is a no-op.
 * @returns {void}
 */
export function startScanner({
  home = CONFIG.HOME,
  claudeDir = CONFIG.CLAUDE_DIR,
  watch = chokidar.watch,
  onMetadataChange = onCodexMetadataChange,
  emitEvent = emitSafe,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (scannerStarted) return;
  scannerStarted = true;

  // Provider metadata is an independent source: an Applications-only graph
  // remains live even when there is nothing on disk to watch or chokidar fails.
  try {
    metadataUnsubscribe = onMetadataChange(() => {
      invalidateGraph();
      try { emitEvent('graph.invalidated', { reason: 'provider-metadata' }); }
      catch { /* event transport failure cannot break scanning */ }
    });
  } catch {
    metadataUnsubscribe = null;
    console.warn('[scanner] provider metadata listener unavailable');
  }

  const descriptors = buildGraphSources({ home, claudeDir });
  const roots = [];
  for (const descriptor of descriptors) {
    for (const mount of descriptor.mounts) {
      try {
        const stat = fsSync.lstatSync(mount.absPath);
        if (stat.isSymbolicLink()) continue;
        if (mount.kind === 'dir' ? stat.isDirectory() : stat.isFile()) roots.push(mount.absPath);
      } catch { /* only existing approved mounts are watched */ }
    }
  }
  if (roots.length === 0) {
    console.warn('[scanner] no approved graph sources to watch');
    return;
  }

  const genericIgnored = buildIgnoredRegex();
  const codexMounts = descriptors
    .filter((descriptor) => descriptor.provider === 'codex')
    .flatMap((descriptor) => descriptor.mounts);
  const ignored = (candidate) => {
    if (typeof candidate !== 'string' || genericIgnored.test(candidate)) return true;
    for (const mount of codexMounts) {
      if (!pathWithin(mount.absPath, candidate)) continue;
      const relative = path.relative(mount.absPath, candidate);
      return relative === '' ? false : isDeniedCodexRelativePath(relative);
    }
    return false;
  };

  const scheduleInvalidation = (changedPath) => {
    if (typeof changedPath !== 'string' || !roots.some((root) => pathWithin(root, changedPath))) return;
    if (ignored(changedPath)) return;
    if (debounceTimer) clearTimer(debounceTimer);
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      invalidateGraph();
      try { emitEvent('graph.invalidated', { reason: 'fs' }); }
      catch { /* event transport failure cannot break scanning */ }
    }, DEBOUNCE_MS);
    if (typeof debounceTimer?.unref === 'function') debounceTimer.unref();
  };

  try {
    watcher = watch(roots, {
      ignoreInitial: true,
      depth: 4,
      ignored,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      usePolling: false,
      followSymlinks: false,
    });
    watcherClearTimer = clearTimer;

    for (const evt of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      watcher.on(evt, scheduleInvalidation);
    }

    let watcherWarned = false;
    watcher.on('error', () => {
      if (watcherWarned) return;
      watcherWarned = true;
      console.warn('[scanner] watcher error');
    });
  } catch {
    try { watcher?.close(); } catch { /* partially-created watcher */ }
    watcher = null;
    console.warn('[scanner] could not start watcher');
    return;
  }
}

/** Stop graph watchers/listeners. Used by tests and graceful shutdown. */
export function stopScanner() {
  if (debounceTimer) {
    watcherClearTimer(debounceTimer);
    debounceTimer = null;
  }
  if (metadataUnsubscribe) {
    try { metadataUnsubscribe(); } catch { /* already removed */ }
    metadataUnsubscribe = null;
  }
  if (watcher) {
    try { watcher.close(); } catch { /* already closed */ }
    watcher = null;
  }
  watcherClearTimer = clearTimeout;
  scannerStarted = false;
}

// ---------------------------------------------------------------------------
// CLI:  node server/lib/scanner.js --once   (wired to `npm run scan`)
// ---------------------------------------------------------------------------

if (process.argv.includes('--once')) {
  getGraph()
    .then((g) => {
      console.log(JSON.stringify(g.stats, null, 2));
    })
    .catch((err) => {
      console.warn('[scanner] scan failed:', err && err.message);
      process.exitCode = 1;
    });
}
