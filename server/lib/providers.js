import fs from 'node:fs';
import path from 'node:path';

const IDS = new Set(['claude', 'codex']);
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const CODEX_DENIED_SEGMENTS = new Set([
  'sessions', 'archived_sessions', 'archived-sessions',
  'session-indexes', 'session_indexes',
  'histories', 'transcripts', 'transcription-histories', 'transcription_histories',
  'log', 'logs', 'attachments', 'credentials', 'secrets', 'tokens',
  'generated-media', 'generated_media', 'generated-images', 'generated_images',
  'browser', 'browser-state', 'browser_state',
  'computer-use', 'computer_use', 'computer-use-state', 'computer_use_state',
  'dictation-state', 'dictation_state', 'ipc', 'locks',
  'process-manager', 'process_manager', 'shell-snapshots', 'shell_snapshots',
  'cache', 'caches', '.cache', 'tmp', 'temp',
  'plugin-cache', 'plugin_cache',
  'marketplace-staging', 'marketplace_staging', 'staging',
  'worktrees', 'vendor', 'vendor-imports', 'vendor_imports',
  'migration-backups', 'migration_backups',
]);
const CODEX_DENIED_FILE = [
  /(?:^|[._-])(?:auth|credential(?:s)?|secret(?:s)?|token(?:s)?)(?:[._-]|$)/i,
  /(?:^|[._-])(?:history|transcript)(?:[._-]|$)/i,
  /\.(?:log|sqlite(?:3)?|db)(?:-(?:journal|wal|shm))?$/i,
  /\.(?:wal|shm)$/i,
];

export function normalizeProvider(value, fallback = 'claude') {
  const raw = value == null || value === '' ? fallback : String(value).trim().toLowerCase();
  if (!IDS.has(raw)) throw new Error('provider must be claude or codex');
  return raw;
}

export function skillIdentity(provider, name) {
  return `${normalizeProvider(provider)}:${String(name)}`;
}

export function isDeniedCodexRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return true;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.includes('..')) return true;
  return segments.some((segment) => {
    const folded = segment.toLowerCase();
    return CODEX_DENIED_SEGMENTS.has(folded)
      || CODEX_DENIED_FILE.some((pattern) => pattern.test(segment));
  });
}

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexBin({
  override = process.env.CLAUDEOS_CODEX_BIN,
  pathValue = process.env.PATH,
  isExecutable = isExecutableFile,
} = {}) {
  if (typeof override === 'string' && override.length > 0) {
    return isExecutable(override) ? override : null;
  }
  for (const dir of String(pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codex');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function normalizePatchValue(field, value, provider) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`invalid ${field}: expected a string or null`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (field === 'model') {
    if (provider === 'claude') {
      const model = trimmed.toLowerCase();
      if (CLAUDE_MODELS.has(model)) return model;
    } else if (CODEX_MODEL.test(trimmed)) return trimmed;
  } else {
    const effort = trimmed.toLowerCase();
    const allowed = provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
    if (allowed.has(effort)) return effort;
  }
  throw new Error(`invalid ${field}`);
}

export function validateSkillPatch(provider, patch) {
  const providerId = normalizeProvider(provider);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('invalid body: expected an object with model and/or effort');
  }
  const out = {};
  for (const field of ['model', 'effort']) {
    if (Object.hasOwn(patch, field)) out[field] = normalizePatchValue(field, patch[field], providerId);
  }
  return out;
}

function sidecarEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    model: Object.hasOwn(value, 'model') ? value.model : null,
    effort: Object.hasOwn(value, 'effort') ? value.effort : null,
  };
}

export function readSkillOverride(store, provider, name) {
  const providerId = normalizeProvider(provider);
  if (!store || typeof store !== 'object' || Array.isArray(store)) return null;
  const composite = sidecarEntry(store[skillIdentity(providerId, name)]);
  if (composite) return composite;
  return providerId === 'claude' ? sidecarEntry(store[String(name)]) : null;
}

export function codexPaths(home) {
  const root = path.join(home, '.codex');
  return {
    root,
    agentsFile: path.join(root, 'AGENTS.md'),
    rulesDir: path.join(root, 'rules'),
    skillsDir: path.join(root, 'skills'),
    memoriesDir: path.join(root, 'memories'),
    automationsDir: path.join(root, 'automations'),
    configFile: path.join(root, 'config.toml'),
  };
}
