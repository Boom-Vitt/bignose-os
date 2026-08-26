// server/lib/config.js — shared, read-only for every slice.
//
// Central configuration. Other slices import CONFIG (and the scan-root/ignore
// constants) from here rather than recomputing paths themselves.
// COMPLETE — do not edit. Add nothing; if you need a new path, hardcode it in
// your own module rather than mutating this shared surface.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/lib -> server -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readVersion() {
  try {
    const pkgRaw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PORT = Number(process.env.CLAUDEOS_PORT) || 4317;
const HOST = '127.0.0.1';
const VERSION = readVersion();

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const STATE_DIR = path.join(HOME, '.boombignose_claudeos');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// Ensure STATE_DIR exists (registry, sidecar store, caches all live here).
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch (err) {
  console.warn('[claudeos] could not create STATE_DIR:', err.message);
}

// ---- derived paths every slice needs ----
const JOBS_DIR         = path.join(CLAUDE_DIR, 'jobs');
const SKILLS_DIR       = path.join(CLAUDE_DIR, 'skills');
const AGENTS_DIR       = path.join(CLAUDE_DIR, 'agents');
const COMMANDS_DIR     = path.join(CLAUDE_DIR, 'commands');
const PLUGINS_DIR      = path.join(CLAUDE_DIR, 'plugins');
const SCHEDULED_DIR    = path.join(CLAUDE_DIR, 'scheduled-tasks');
const SETTINGS_PATH    = path.join(CLAUDE_DIR, 'settings.json');
const SIDECAR_PATH     = path.join(STATE_DIR, 'sidecar.json');
const GRAPH_CACHE_PATH = path.join(STATE_DIR, 'graph-cache.json');
const TOKEN_PATH       = path.join(STATE_DIR, 'hook-token');

// ---- hook auth token ----
// Generated once, persisted 0600, read by both the server (to verify the
// Bearer header on POST /api/hooks) and hooks/install.js (to bake into the
// hook command). Env override wins so the user can pin one.
function loadOrCreateToken() {
  if (process.env.CLAUDEOS_HOOK_TOKEN) return process.env.CLAUDEOS_HOOK_TOKEN;
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch { /* not written yet */ }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn('[claudeos] could not persist hook token:', err.message);
  }
  return token;
}
const HOOK_TOKEN = loadOrCreateToken();

// CONTRACT.md §6 — ignored directory names during scanning, depth-capped walk.
const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'backups',
  'security',
  'session-env',
  'shell-snapshots',
  'paste-cache',
  'cache',
  '.DS_Store',
];

// CONTRACT.md §6 — scan roots default to ~/.claude only.
const SCAN_ROOTS = [CLAUDE_DIR];
const DEPTH_CAP = 8;

export const CONFIG = {
  PORT,
  HOST,
  VERSION,
  HOME,
  REPO_ROOT,
  CLAUDE_DIR,
  STATE_DIR,
  PUBLIC_DIR,
  JOBS_DIR,
  SKILLS_DIR,
  AGENTS_DIR,
  COMMANDS_DIR,
  PLUGINS_DIR,
  SCHEDULED_DIR,
  SETTINGS_PATH,
  SIDECAR_PATH,
  GRAPH_CACHE_PATH,
  TOKEN_PATH,
  HOOK_TOKEN,
  DEPTH_CAP,
};

export { IGNORE_DIRS, SCAN_ROOTS, DEPTH_CAP, HOOK_TOKEN };
