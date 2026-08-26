// server/lib/sidecar.js — Slice D · catalog
//
// The sidecar store is the ONLY source of per-skill `model` / `effort`.
// CONTRACT.md §5: those two fields never come from SKILL.md frontmatter.
//
// Shape at CONFIG.SIDECAR_PATH (~/.boombignose_claudeos/sidecar.json):
//   { "<skill-name>": { "model": string|null, "effort": string|null } }

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import {
  normalizeProvider, readSkillOverride, skillIdentity, validateSkillPatch,
} from './providers.js';

let cache = null;      // last parsed object
let cacheMtime = -1;   // mtimeMs of the file when `cache` was built
let cacheSize = -1;

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/**
 * readSidecar() -> object
 * Missing or corrupt file degrades to `{}`. Cached in memory, revalidated
 * against the file's mtime+size so external edits are picked up.
 */
export function readSidecar() {
  const st = statSafe(CONFIG.SIDECAR_PATH);
  if (!st) { cache = {}; cacheMtime = -1; cacheSize = -1; return cache; }
  if (cache && st.mtimeMs === cacheMtime && st.size === cacheSize) return cache;
  let parsed = {};
  try {
    const raw = fs.readFileSync(CONFIG.SIDECAR_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json;
  } catch {
    parsed = {};   // corrupt on disk -> behave as empty, never throw
  }
  cache = parsed;
  cacheMtime = st.mtimeMs;
  cacheSize = st.size;
  return cache;
}

/** Write the whole store atomically: tmp file -> rename. */
function persist(store) {
  const tmp = `${CONFIG.SIDECAR_PATH}.tmp`;
  try { fs.mkdirSync(path.dirname(CONFIG.SIDECAR_PATH), { recursive: true }); } catch { /* already there */ }
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG.SIDECAR_PATH);
}

/**
 * writeSidecar(name, patch, { provider }) -> merged entry { model, effort }
 * Shallow-merges `{model?, effort?}` into the entry for `name`, persists the
 * whole file atomically, returns the merged entry.
 * Rejects unknown keys and invalid values with a plain Error -> 400.
 */
export function writeSidecar(name, patch, { provider = 'claude' } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('invalid skill name');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('invalid body: expected an object with model and/or effort');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'model' && key !== 'effort') {
      throw new Error(`unknown field "${key}" (allowed: model, effort)`);
    }
  }

  const providerId = normalizeProvider(provider);
  const cleanPatch = validateSkillPatch(providerId, patch);
  const key = skillIdentity(providerId, name);
  const store = { ...readSidecar() };
  const previous = readSkillOverride(store, providerId, name) ?? {};
  const merged = {
    model: Object.hasOwn(cleanPatch, 'model') ? cleanPatch.model : (previous.model ?? null),
    effort: Object.hasOwn(cleanPatch, 'effort') ? cleanPatch.effort : (previous.effort ?? null),
  };

  store[key] = merged;
  persist(store);

  // Refresh the cache from what we just wrote so readers see it immediately.
  const st = statSafe(CONFIG.SIDECAR_PATH);
  cache = store;
  cacheMtime = st ? st.mtimeMs : -1;
  cacheSize = st ? st.size : -1;

  return merged;
}
