// public/js/app.js — Slice F · shell boot, hash router, shared fetch helpers.
//
// DESIGN.md §Icons asks for one exported icon map that slice G can import from
// app.js. The map itself is hand-authored in ./icons.js (read-only for both
// slices); this is the re-export, so `import { icon } from './app.js'` and
// `from './icons.js'` are the same objects. Never duplicate the map.

export { icon, iconEl, ICONS, ICON_NAMES } from './icons.js';

import { connect, subscribe, connectionState } from './sse.js';
import { mountDashboard } from './views/dashboard.js';
import { icon } from './icons.js';
import { fetchLocalApi } from './local-api.js';

export { connect, subscribe, connectionState };

// ---------------------------------------------------------------------------
// fetch helpers — every panel degrades to its empty state, nothing throws
// ---------------------------------------------------------------------------

/**
 * GET JSON. Returns null on ANY failure: network down, non-2xx (the server
 * answers 503 with a JSON body while a slice is still landing — that body is
 * an error, not data), or unparseable payload.
 *
 * @param {string} path
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<any|null>}
 */
export async function getJSON(path, opts = {}) {
  try {
    const res = await fetchLocalApi(path, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: opts.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Send JSON with a method that carries a body. Same contract as getJSON —
 * null on any failure — so callers can render a quiet failure instead of
 * exploding the page.
 *
 * @param {'POST'|'PATCH'|'PUT'} method
 * @param {string} path
 * @param {any} body
 * @returns {Promise<any|null>}
 */
export async function sendJSON(method, path, body) {
  try {
    const res = await fetchLocalApi(path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) return null;
    // 202/204 legitimately carry no body.
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const ROUTE_BRAIN = 'brain';

/** @type {{destroy: () => void}|null} */
let current = null;
let currentRoute = null;
/** Monotonic token so a slow async mount can tell it has been superseded. */
let mountToken = 0;

function routeFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  return raw === ROUTE_BRAIN ? ROUTE_BRAIN : 'dashboard';
}

function teardown() {
  if (current && typeof current.destroy === 'function') {
    try {
      current.destroy();
    } catch (err) {
      console.warn('[app] view destroy threw:', err);
    }
  }
  current = null;
}

/**
 * Slice G may not have landed. A missing module must read as a designed panel,
 * not a blank screen or a console explosion.
 */
function renderBrainUnavailable(root, reason) {
  root.innerHTML = `
    <div class="fallback">
      <section class="fallback-card">
        <header class="fallback-head">
          <span class="fallback-glyph">${icon('brain', { size: 18 })}</span>
          <span class="label">Second Brain unavailable</span>
        </header>
        <hr class="hairline">
        <p class="fallback-body">
          The memory graph view has not been installed in this build.
        </p>
        <p class="fallback-reason mono">${escapeHtml(reason)}</p>
        <a class="btn btn-accent fallback-back" href="#">Back to the OS</a>
      </section>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function mountRoute(root, route) {
  const token = ++mountToken;
  teardown();
  root.replaceChildren();
  document.body.dataset.route = route;

  if (route !== ROUTE_BRAIN) {
    current = mountDashboard(root) ?? null;
    return;
  }

  // Lazy + defensive: slice G owns ./views/brain.js and may not exist yet.
  try {
    const mod = await import('./views/brain.js');
    if (token !== mountToken) return; // navigated away mid-import
    if (typeof mod?.mountBrain !== 'function') {
      throw new Error('brain.js does not export mountBrain()');
    }
    current = mod.mountBrain(root) ?? null;
  } catch (err) {
    if (token !== mountToken) return;
    renderBrainUnavailable(root, err?.message ?? String(err));
    current = null;
  }
}

function onHashChange(root) {
  const next = routeFromHash();
  if (next === currentRoute) return;
  currentRoute = next;
  mountRoute(root, next);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

export function boot() {
  const root = document.getElementById('app');
  if (!root) {
    console.warn('[app] #app root missing — nothing to mount');
    return;
  }

  connect(); // one EventSource for the whole app

  currentRoute = routeFromHash();
  mountRoute(root, currentRoute);

  window.addEventListener('hashchange', () => onHashChange(root));
}

boot();
