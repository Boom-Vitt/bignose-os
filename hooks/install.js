#!/usr/bin/env node
// hooks/install.js — Slice H. Idempotent installer for the claudeos hook entries.
//
//   npm run install-hooks              # dry run (default — prints, writes nothing)
//   npm run install-hooks -- --yes     # actually write ~/.claude/settings.json
//   npm run install-hooks -- --uninstall --yes
//
// This edits the user's LIVE Claude Code config, so:
//   * dry run is the default; --yes is required to write (for uninstall too)
//   * settings.json is backed up to settings.json.claudeos-backup-<timestamp>
//   * the write is atomic (tmp file in the same dir + rename)
//   * every unrelated key and every pre-existing hook is preserved — we only
//     ever add or remove entries whose command points at our own dispatch.js
//
// The bearer token is NEVER inlined into the command string: settings.json is
// 0644, the token file is 0600. dispatch.js reads the token itself at runtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../server/lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the dispatcher Claude Code will invoke. */
export const DISPATCH_PATH = path.join(__dirname, 'dispatch.js');

/**
 * Events registered by the public BIGNOSE OS hook contract.
 * `matcher: ''` applies to lifecycle/tool events; UserPromptSubmit is not
 * tool-scoped, so its matcher is omitted.
 */
export const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: '' },
  { event: 'UserPromptSubmit', matcher: null },
  { event: 'PreToolUse', matcher: '' },
  { event: 'PostToolUse', matcher: '' },
  { event: 'Stop', matcher: '' },
];

/** Seconds. Matches the timeout the neighbouring hooks in settings.json use. */
export const HOOK_TIMEOUT_S = 5;

const clone = (v) => JSON.parse(JSON.stringify(v));

/** The exact command string we install. */
export function buildCommand(dispatchPath = DISPATCH_PATH) {
  return `node "${dispatchPath}"`;
}

export function buildEntry(dispatchPath = DISPATCH_PATH) {
  return { type: 'command', command: buildCommand(dispatchPath), timeout: HOOK_TIMEOUT_S };
}

export function buildGroup(spec, dispatchPath = DISPATCH_PATH) {
  const group = {};
  if (spec.matcher !== null && spec.matcher !== undefined) group.matcher = spec.matcher;
  group.hooks = [buildEntry(dispatchPath)];
  return group;
}

/**
 * Is this hook entry one of ours?
 *
 * Primary test is the absolute dispatch path; the fallback is the
 * `/hooks/dispatch.js` path substring so that entries left behind by an install
 * from a previous repo location are still recognised (and thus replaced or
 * removed rather than duplicated).
 *
 * Deliberately narrow: the user's existing hooks point at
 * `/Users/.../.pixel-agents/hooks/claude-hook.js` and
 * `/Users/.../.claude/hooks/check-token-usage.sh` — neither matches.
 */
export function isOurEntry(entry, dispatchPath = DISPATCH_PATH) {
  const cmd = entry && typeof entry.command === 'string' ? entry.command : '';
  if (!cmd) return false;
  if (dispatchPath && cmd.includes(dispatchPath)) return true;
  return cmd.includes(`${path.sep}hooks${path.sep}dispatch.js`);
}

function asGroups(value) {
  return Array.isArray(value) ? value : [];
}

function groupHooks(group) {
  return group && Array.isArray(group.hooks) ? group.hooks : [];
}

/**
 * Pure. Returns { settings, changes } where `settings` is a new object with our
 * entries installed and everything else byte-for-byte preserved.
 *
 * Existing entries of ours are replaced in place (same group, same index) so a
 * re-run never duplicates and never reorders the user's hooks.
 */
export function mergeHooks(input, dispatchPath = DISPATCH_PATH) {
  const settings = clone(input ?? {});
  const changes = [];
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  for (const spec of HOOK_EVENTS) {
    const { event } = spec;
    const existed = Object.prototype.hasOwnProperty.call(settings.hooks, event);
    const groups = asGroups(settings.hooks[event]);
    const desired = buildEntry(dispatchPath);

    let placed = false;
    let replacedCount = 0;
    let removedDupes = 0;

    for (const group of groups) {
      const hooks = groupHooks(group);
      for (let i = hooks.length - 1; i >= 0; i -= 1) {
        if (!isOurEntry(hooks[i], dispatchPath)) continue;
        if (!placed) {
          const before = JSON.stringify(hooks[i]);
          hooks[i] = desired;
          if (before !== JSON.stringify(desired)) replacedCount += 1;
          placed = true;
        } else {
          hooks.splice(i, 1); // stray duplicate from an older install
          removedDupes += 1;
        }
      }
    }

    if (!placed) {
      groups.push(buildGroup(spec, dispatchPath));
      changes.push({ event, action: existed ? 'added-group' : 'created-event' });
    } else if (replacedCount) {
      changes.push({ event, action: 'updated-command' });
    } else {
      changes.push({ event, action: 'already-present' });
    }
    if (removedDupes) changes.push({ event, action: `removed-${removedDupes}-duplicate` });

    settings.hooks[event] = groups;
  }

  return { settings, changes };
}

/**
 * Pure. Removes every entry of ours from every event — including events we no
 * longer register — and prunes containers that we emptied. Everything else is
 * left exactly as found.
 */
export function removeHooks(input, dispatchPath = DISPATCH_PATH) {
  const settings = clone(input ?? {});
  const changes = [];
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    return { settings, changes };
  }

  for (const event of Object.keys(settings.hooks)) {
    const groups = asGroups(settings.hooks[event]);
    if (!Array.isArray(settings.hooks[event])) continue;
    let removed = 0;

    for (let g = groups.length - 1; g >= 0; g -= 1) {
      const group = groups[g];
      const hooks = groupHooks(group);
      const had = hooks.length;
      for (let i = hooks.length - 1; i >= 0; i -= 1) {
        if (isOurEntry(hooks[i], dispatchPath)) {
          hooks.splice(i, 1);
          removed += 1;
        }
      }
      // Only prune a group we emptied ourselves — never one that arrived empty.
      if (had > 0 && hooks.length === 0) groups.splice(g, 1);
    }

    if (removed) {
      changes.push({ event, action: `removed-${removed}` });
      if (groups.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = groups;
    }
  }

  if (Object.keys(settings.hooks).length === 0 && changes.length) delete settings.hooks;
  return { settings, changes };
}

// ---- reporting --------------------------------------------------------------

/** Count hook entries per event, for the before/after survival table. */
export function countEntries(settings) {
  const out = {};
  const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  for (const [event, value] of Object.entries(hooks)) {
    const groups = asGroups(value);
    out[event] = {
      groups: groups.length,
      entries: groups.reduce((n, g) => n + groupHooks(g).length, 0),
    };
  }
  return out;
}

/** Minimal unified diff (LCS + 3 lines of context). No dependencies. */
export function diffLines(beforeText, afterText, context = 3) {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i], i, j]); i += 1; j += 1; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) { ops.push(['-', a[i], i, j]); i += 1; }
    else { ops.push(['+', b[j], i, j]); j += 1; }
  }
  while (i < n) { ops.push(['-', a[i], i, j]); i += 1; }
  while (j < m) { ops.push(['+', b[j], i, j]); j += 1; }

  // Group changed ops into hunks with context.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op[0] === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x += 1) keep[x] = true;
  });

  const lines = [];
  let k = 0;
  let emitted = false;
  while (k < ops.length) {
    if (!keep[k]) { k += 1; continue; }
    let end = k;
    while (end < ops.length && keep[end]) end += 1;
    const slice = ops.slice(k, end);
    const aStart = slice[0][2] + 1;
    const bStart = slice[0][3] + 1;
    const aLen = slice.filter((o) => o[0] !== '+').length;
    const bLen = slice.filter((o) => o[0] !== '-').length;
    lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const op of slice) lines.push(`${op[0]}${op[1]}`);
    emitted = true;
    k = end;
  }
  return emitted ? lines.join('\n') : '(no textual change)';
}

// ---- file I/O ---------------------------------------------------------------

function readSettings(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { raw: null, parsed: {}, missing: true, endsWithNewline: true };
    throw new Error(`cannot read ${settingsPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${err.message}).\n` +
      'Refusing to touch it. Fix the file by hand and re-run.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} does not contain a JSON object. Refusing to touch it.`);
  }
  return { raw, parsed, missing: false, endsWithNewline: raw.endsWith('\n') };
}

function serialize(settings, endsWithNewline) {
  return JSON.stringify(settings, null, 2) + (endsWithNewline ? '\n' : '');
}

function writeAtomic(settingsPath, text) {
  const dir = path.dirname(settingsPath);
  const tmp = path.join(dir, `.settings.json.claudeos-tmp-${process.pid}`);
  let mode = 0o644;
  try { mode = fs.statSync(settingsPath).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, settingsPath);
}

function backup(settingsPath, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${settingsPath}.claudeos-backup-${stamp}`;
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  return dest;
}

// ---- CLI --------------------------------------------------------------------

const USAGE = `claudeos hook installer

  npm run install-hooks                      dry run (default)
  npm run install-hooks -- --yes             install
  npm run install-hooks -- --uninstall --yes remove our entries only
  npm run install-hooks -- --dry-run         force dry run

Events registered: ${HOOK_EVENTS.map((h) => h.event).join(', ')}
`;

export function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const uninstall = flags.has('--uninstall');
  // Dry run unless --yes. --dry-run always wins, even alongside --yes.
  const apply = flags.has('--yes') && !flags.has('--dry-run');

  const settingsPath = CONFIG.SETTINGS_PATH;
  const log = (s = '') => process.stdout.write(`${s}\n`);

  let file;
  try {
    file = readSettings(settingsPath);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  if (!fs.existsSync(DISPATCH_PATH)) {
    process.stderr.write(`dispatch.js not found at ${DISPATCH_PATH} — aborting.\n`);
    return 1;
  }

  const before = file.parsed;
  const { settings: after, changes } = uninstall
    ? removeHooks(before, DISPATCH_PATH)
    : mergeHooks(before, DISPATCH_PATH);

  const beforeText = file.missing ? '{}\n' : serialize(before, file.endsWithNewline);
  const afterText = serialize(after, file.endsWithNewline);
  const unchanged = beforeText === afterText;

  log(`mode        : ${uninstall ? 'UNINSTALL' : 'INSTALL'}${apply ? '' : '  (DRY RUN)'}`);
  log(`settings    : ${settingsPath}${file.missing ? '  (does not exist yet)' : ''}`);
  log(`dispatch    : ${DISPATCH_PATH}`);
  log(`command     : ${buildCommand(DISPATCH_PATH)}`);
  log(`endpoint    : http://${CONFIG.HOST}:${CONFIG.PORT}/api/hooks`);
  log(`token file  : ${CONFIG.TOKEN_PATH} (${fs.existsSync(CONFIG.TOKEN_PATH) ? 'present' : 'MISSING'})`);
  log('');

  // Survival table — proves every pre-existing entry is still there.
  const cb = countEntries(before);
  const ca = countEntries(after);
  const events = [...new Set([...Object.keys(cb), ...Object.keys(ca)])].sort();
  log('hook entries per event (groups/entries):');
  log('  event                    before      after');
  for (const e of events) {
    const b = cb[e] ? `${cb[e].groups}/${cb[e].entries}` : '-';
    const a = ca[e] ? `${ca[e].groups}/${ca[e].entries}` : '-';
    const mark = b === a ? ' ' : '*';
    log(`  ${mark} ${e.padEnd(22)} ${String(b).padEnd(11)} ${a}`);
  }
  log('');

  log('changes:');
  if (changes.length === 0) log('  (none)');
  for (const c of changes) log(`  ${c.event.padEnd(18)} ${c.action}`);
  log('');

  log('diff:');
  log(diffLines(beforeText, afterText));
  log('');

  const otherKeys = Object.keys(before).filter((k) => k !== 'hooks');
  const preserved = otherKeys.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]));
  log(`top-level keys preserved: ${preserved ? 'yes' : 'NO'} (${otherKeys.join(', ') || 'none'})`);
  log('');

  if (unchanged) {
    log('Nothing to do — settings.json is already in the desired state.');
    return 0;
  }
  if (!preserved) {
    process.stderr.write('Refusing to write: a non-hooks key would change. This is a bug.\n');
    return 1;
  }

  if (!apply) {
    log('DRY RUN — nothing was written.');
    log(`Re-run with --yes to apply:  npm run install-hooks -- ${uninstall ? '--uninstall ' : ''}--yes`);
    return 0;
  }

  try {
    if (!file.missing) log(`backup      : ${backup(settingsPath, file.raw)}`);
    writeAtomic(settingsPath, afterText);
    log(`wrote       : ${settingsPath}`);
    log(uninstall
      ? 'Uninstalled. Restart Claude Code sessions for the change to take effect.'
      : 'Installed. Restart Claude Code sessions for the change to take effect.');
  } catch (err) {
    process.stderr.write(`write failed: ${err.message}\n`);
    return 1;
  }
  return 0;
}

const isDirectRun = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (isDirectRun) process.exitCode = main();
