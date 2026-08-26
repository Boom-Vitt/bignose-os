// public/js/graph-render.js — Slice G · canvas drawing for the Second Brain graph.
//
// Performance notes that are measured, not guessed (DPR 2):
//   node glow via ctx.shadowBlur ............ 106.8 ms / 10k, 476 ms / 50k
//   node glow via gradient-per-node .........  100.6 ms / 10k, 449 ms / 50k
//   node glow via offscreen sprite stamp ....   18.0 ms / 10k,  63.8 ms / 50k
// So the halo is baked once into a small offscreen canvas per hue bucket and
// stamped with drawImage under 'lighter'. The atlas is deliberately capped at
// 12 sprites — past ~16 the texture switching costs about 40%.
//
// We never set willReadFrequently: it forces a software backend here.
//
// Colours are resolved once from tokens.css via getComputedStyle and cached.
// Nothing in this file hardcodes a colour.

import { ICONS } from './icons.js';
import {
  RING_ORDER, RING_LABEL, RING_TOKEN, DEPT_TOKEN,
  ringGeometry, departmentAnchors, isProviderRoot, nodeRadius, routePolyline,
} from './graph-layout.js';

// ---------------------------------------------------------------------------
// colour plumbing
// ---------------------------------------------------------------------------

const PALETTE_TOKENS = {
  bg: '--brain-bg',
  disc1: '--brain-disc-1',
  disc2: '--brain-disc-2',
  disc3: '--brain-disc-3',
  hair: '--brain-hair',
  hexStroke: '--hex-stroke',
  ink: '--ink',
  ink2: '--ink-2',
  ink3: '--ink-3',
  ink4: '--ink-4',
  accent: '--accent',
  accentHi: '--accent-hi',
  core: RING_TOKEN.core,
  skills: RING_TOKEN.skills,
  memory: RING_TOKEN.memory,
  routines: RING_TOKEN.routines,
  applications: RING_TOKEN.applications,
  BUSINESS: DEPT_TOKEN.BUSINESS,
  CONTENT: DEPT_TOKEN.CONTENT,
  COMMUNITY: DEPT_TOKEN.COMMUNITY,
  PRODUCT: DEPT_TOKEN.PRODUCT,
  PERSONAL: DEPT_TOKEN.PERSONAL,
};

/** '#RGB' | '#RRGGBB' | '#RRGGBBAA' | 'rgb(...)' -> [r,g,b,a] */
function parseColor(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].every(Number.isFinite)) return [r, g, b, a];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [255, 255, 255, 1];
}

function rgba(c, a) {
  return `rgba(${c[0]},${c[1]},${c[2]},${a === undefined ? c[3] : a * c[3]})`;
}

/** Read every token once off :root. Call on mount and on theme/DPR change. */
export function resolvePalette(host) {
  const cs = getComputedStyle(host || document.documentElement);
  const out = {};
  for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
    out[key] = parseColor(cs.getPropertyValue(token));
  }
  return out;
}

// ---------------------------------------------------------------------------
// glyph shapes, parsed once out of the shared icon map (icons.js)
// ---------------------------------------------------------------------------

const SHAPE_CACHE = new Map();

/** Turn an ICONS entry into canvas-drawable primitives on the 20x20 grid. */
function glyphShapes(name) {
  if (SHAPE_CACHE.has(name)) return SHAPE_CACHE.get(name);
  const src = ICONS[name] || '';
  const list = [];
  for (const m of src.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    list.push({ t: 'p', path: new Path2D(m[1]) });
  }
  for (const m of src.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"/g)) {
    list.push({ t: 'c', x: +m[1], y: +m[2], r: +m[3] });
  }
  for (const m of src.matchAll(
    /<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/g)) {
    list.push({ t: 'r', x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  }
  SHAPE_CACHE.set(name, list);
  return list;
}

/** Stroke a monoline glyph centred on (x,y) at `size` px. Stroke stays hairline. */
function drawGlyph(ctx, name, x, y, size, stroke, width = 1.25) {
  const shapes = glyphShapes(name);
  if (!shapes.length) return;
  const k = size / 20;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width / k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of shapes) {
    if (s.t === 'p') { ctx.stroke(s.path); continue; }
    ctx.beginPath();
    if (s.t === 'c') ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    else ctx.rect(s.x, s.y, s.w, s.h);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// letter-spaced text — canvas has no reliable letterSpacing, so we advance
// per character. This always renders spaced, on every engine.
// ---------------------------------------------------------------------------

function trackedWidth(ctx, text, tracking) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return w - tracking;
}

function drawTracked(ctx, text, x, y, tracking, align = 'center') {
  const chars = [...text];
  const total = trackedWidth(ctx, text, tracking);
  let cur = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of chars) {
    ctx.fillText(ch, cur, y);
    cur += ctx.measureText(ch).width + tracking;
  }
  ctx.textAlign = prev;
  return total;
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

const GLOW_KEYS = [
  'core', 'skills', 'memory', 'routines', 'applications',
  'BUSINESS', 'CONTENT', 'COMMUNITY', 'PRODUCT', 'PERSONAL',
  'neutral', 'hi',
];
const SPRITE_PX = 96;
const GLOW_SCALE = 4.0;
const MAX_LABELS = 220;
const PROVIDER_VISUAL_PX = 14;
const PROVIDER_INNER_PX = 10;
const PROVIDER_HIT_PX = 18;
const PROVIDER_GLYPH_PX = 15;
const PROVIDER_LABEL_OFFSET_PX = 28;
const PROVIDER_OUTER_STROKE_PX = 1.25;
const CORE_OUTER_STROKE_PX = 1.5;
const PROVIDER_CLUSTER_GAP_PX = 2;
const PROVIDER_PAIR_HIT_SEPARATION_PX = PROVIDER_HIT_PX * 2;

function isAgentCoreRoot(node) {
  return !!node && node.ring === 'core' && !isProviderRoot(node)
    && (node.id === 'agent-core' || node.id === '' || node.depth === 0);
}

/**
 * Maximum halo sprites stamped per frame. Measured on this machine: drawImage
 * stamping stays linear and cheap to roughly 1200 calls per frame (0.4 ms) and
 * then falls off a cliff (~30 ms at 2400) as the canvas backend stops batching.
 * Plain arc fills show no such cliff, so the budget applies to the glow pass
 * only. In a ring dense enough to exceed its share, halos overlap so heavily
 * that stride-sampling them is visually indistinguishable from stamping each.
 */
const GLOW_BUDGET = 1100;

/**
 * Badge glyphs (SKILLS stars, APPLICATIONS hexagons) are sprite stamps too and
 * share the same per-frame drawImage cliff. When a ring is so populous that its
 * badges would blow the budget, its glyphs are sub-pixel and read as dots
 * anyway — so we draw dots, which cost nothing and cliff at no count. Rings at
 * their intended scale keep real badges.
 */
const BADGE_BUDGET = 1400;

/** At or below this population a ring costs nothing to stamp in full. */
const SPARSE_RING = 60;

function clamp01(value) {
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function partialRoute(points, progress) {
  const p = clamp01(progress);
  if (!points.length || p <= 0) return [];
  const lengths = points.slice(1).map((point, index) => (
    Math.hypot(point.x - points[index].x, point.y - points[index].y)
  ));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let remaining = total * p;
  const out = [points[0]];
  for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
    const length = lengths[index] || 1;
    if (remaining >= length) {
      out.push(points[index + 1]);
      remaining -= length;
      continue;
    }
    const t = remaining / length;
    out.push({
      x: points[index].x + (points[index + 1].x - points[index].x) * t,
      y: points[index].y + (points[index + 1].y - points[index].y) * t,
    });
    remaining = 0;
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onAuraOps?:(ops:{gradients:number,arcs:number,sprites:number})=>void}} [opts]
 * @returns {{draw:Function, resize:Function, hitTest:Function,
 *            toWorld:Function, geometry:Function, destroy:Function,
 *            width:number, height:number}}
 */
export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const reportAuraOps = typeof opts.onAuraOps === 'function' ? opts.onAuraOps : null;
  let palette = resolvePalette();
  let dpr = window.devicePixelRatio || 1;
  let W = 0;
  let H = 0;
  let sprites = new Map();
  let starSprites = new Map();
  let hexSprites = new Map();
  let brandImages = new Map();
  let last = null;                    // caller state, for lossless redraw
  let lastFrame = null;               // renderer-projected state for hitTest
  let grid = new Map();               // world-space spatial index
  let gridCell = 56;
  let dprQuery = null;
  let destroyed = false;
  let routeCache = {
    positions: null, edgeRefs: [], layout: null, geomKey: '', records: [],
  };

  // ---- offscreen sprite atlas -------------------------------------------
  function buildSprites() {
    sprites = new Map();
    for (const key of GLOW_KEYS) {
      const c = key === 'neutral' ? palette.ink3 : key === 'hi' ? palette.accentHi : palette[key];
      const off = document.createElement('canvas');
      off.width = SPRITE_PX;
      off.height = SPRITE_PX;
      const g = off.getContext('2d');
      const half = SPRITE_PX / 2;
      const grad = g.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, rgba(c, 0.62));
      grad.addColorStop(0.28, rgba(c, 0.20));
      grad.addColorStop(0.62, rgba(c, 0.045));
      grad.addColorStop(1, rgba(c, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
      sprites.set(key, off);
    }
    // the SKILLS ring is hundreds of identical 4-point stars; bake one and
    // stamp it rather than stroking a Path2D per node
    starSprites = new Map();
    hexSprites = new Map();
    for (const key of ['skills', 'applications', 'core', 'PRODUCT']) {
      const c = palette[key] || palette.ink3;
      const star = document.createElement('canvas');
      star.width = 64;
      star.height = 64;
      drawGlyph(star.getContext('2d'), 'star-4', 32, 32, 52, rgba(c, 1), 2.0);
      starSprites.set(key, star);
      const hex = document.createElement('canvas');
      hex.width = 64;
      hex.height = 64;
      drawGlyph(hex.getContext('2d'), 'hexagon', 32, 32, 54, rgba(c, 1), 2.0);
      hexSprites.set(key, hex);
    }
  }

  function buildBrandImages() {
    brandImages = new Map();
    if (typeof Image !== 'function') return;
    for (const provider of ['claude', 'codex']) {
      const image = new Image();
      image.onload = () => {
        if (!destroyed && last) draw(last);
      };
      image.src = `/assets/brand/${provider}.svg`;
      brandImages.set(provider, image);
    }
  }

  function resize() {
    if (destroyed) return;
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    let w = Math.round(rect.width);
    let h = Math.round(rect.height);
    // A canvas can measure 0x0 while the view is mounted but not yet laid out
    // (hidden tab, display:none ancestor, mount before first layout). Collapsing
    // to 0 would shrink the cull rectangle and hide every node while the ring
    // chrome still drew, so fall back rather than accept a degenerate size.
    if (w < 2 || h < 2) {
      const host = canvas.parentElement;
      const pr = host ? host.getBoundingClientRect() : null;
      w = Math.round(pr && pr.width) || W || 1200;
      h = Math.round(pr && pr.height) || H || 800;
    }
    W = w;
    H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastFont = '';
    api.width = W;
    api.height = H;
    watchDpr();
  }

  function watchDpr() {
    if (dprQuery) dprQuery.removeEventListener('change', onDpr);
    dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    dprQuery.addEventListener('change', onDpr);
  }
  function onDpr() {
    if (destroyed) return;
    resize();
    palette = resolvePalette();
    buildSprites();
    if (last) draw(last);
  }

  function refreshPalette() {
    palette = resolvePalette();
    buildSprites();
  }

  // ---- view transform ----------------------------------------------------
  function view(state) {
    const v = state?.view || {};
    return { x: v.x ?? 0, y: v.y ?? 0, k: v.k ?? 1 };
  }
  function toWorld(sx, sy) {
    const v = view(last);
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
  }

  /**
   * Fixed-screen provider geometry can collapse beneath any world-space
   * layout. Derive display-only positions only when needed, with a real
   * two-pixel painted gap from Agent Core and enough pair separation for both
   * 18 px targets. Caller positions and point objects are never mutated.
   */
  function projectProviderCluster(state, v) {
    const positions = state?.positions;
    if (!positions) {
      return { positions, labelLanes: null };
    }
    const nodes = state.nodes || [];
    const core = nodes.find(isAgentCoreRoot);
    const corePoint = core && positions.get(core.id);
    const providers = nodes.filter((node) => isProviderRoot(node) && positions.has(node.id));
    const labelLanes = new Map(providers.map((provider) => [
      provider.id,
      providers.length > 1 && provider.id === 'codex' ? 1.5 : 1,
    ]));
    if (!core || !corePoint || providers.length === 0) {
      return { positions, labelLanes: labelLanes.size ? labelLanes : null };
    }

    const coreVisualPx = nodeRadius(core, state.opts || {}) * v.k;
    const pairHalfPx = providers.length > 1 ? PROVIDER_PAIR_HIT_SEPARATION_PX / 2 : 0;
    const minimumOffsetPx = Math.max(
      coreVisualPx + CORE_OUTER_STROKE_PX / 2
        + PROVIDER_VISUAL_PX + PROVIDER_OUTER_STROKE_PX / 2
        + PROVIDER_CLUSTER_GAP_PX,
      pairHalfPx,
    );
    let projected = null;
    for (const provider of providers) {
      const point = positions.get(provider.id);
      const dx = point.x - corePoint.x;
      const dy = point.y - corePoint.y;
      const worldDistance = Math.hypot(dx, dy);
      const screenDistance = worldDistance * v.k;
      if (screenDistance + 1e-9 >= minimumOffsetPx) continue;
      const fallbackDirection = provider.id === 'claude' ? -1 : 1;
      const ux = worldDistance > 0 ? dx / worldDistance : fallbackDirection;
      const uy = worldDistance > 0 ? dy / worldDistance : 0;
      const projectedWorldDistance = minimumOffsetPx / v.k;
      if (!projected) projected = new Map(positions);
      projected.set(provider.id, {
        ...point,
        x: corePoint.x + ux * projectedWorldDistance,
        y: corePoint.y + uy * projectedWorldDistance,
      });
    }
    if (providers.length > 1) {
      const claude = providers.find((provider) => provider.id === 'claude');
      const codex = providers.find((provider) => provider.id === 'codex');
      const claudePoint = claude && (projected?.get(claude.id) || positions.get(claude.id));
      const codexPoint = codex && (projected?.get(codex.id) || positions.get(codex.id));
      const providerSeparationPx = claudePoint && codexPoint
        ? Math.hypot(claudePoint.x - codexPoint.x, claudePoint.y - codexPoint.y) * v.k
        : Infinity;
      if (providerSeparationPx + 1e-9 < PROVIDER_PAIR_HIT_SEPARATION_PX) {
        if (!projected) projected = new Map(positions);
        const projectedWorldDistance = minimumOffsetPx / v.k;
        // A tween can momentarily put both providers on the same radial ray.
        // In that collision only, use stable provider-ID lanes so the cluster
        // stays bounded, source-order independent, and fully targetable.
        for (const provider of [claude, codex]) {
          if (!provider) continue;
          const point = positions.get(provider.id);
          const direction = provider.id === 'claude' ? -1 : 1;
          projected.set(provider.id, {
            ...point,
            x: corePoint.x + direction * projectedWorldDistance,
            y: corePoint.y,
          });
        }
      }
    }
    if (!projected) return { positions, labelLanes };
    return {
      positions: projected,
      labelLanes,
    };
  }

  function geometry(state) {
    const s = state || last || {};
    return ringGeometry(s.geom || { width: W, height: H });
  }

  // ---- colour key per node ----------------------------------------------
  function keyFor(node, mode) {
    if (!node) return 'neutral';
    if (node.provider === 'claude') return 'core';
    if (node.provider === 'codex') return 'PRODUCT';
    if (mode === 'folders') return node.ring && palette[node.ring] ? node.ring : 'neutral';
    if (node.ring === 'memory') {
      return node.department && palette[node.department] ? node.department : 'neutral';
    }
    return node.ring && palette[node.ring] ? node.ring : 'neutral';
  }

  // ---- spatial index -----------------------------------------------------
  function buildGrid(state) {
    grid = new Map();
    const positions = state.positions;
    if (!positions) return;
    for (const node of state.nodes || []) {
      const p = positions.get(node.id);
      if (!p) continue;
      const gx = Math.floor(p.x / gridCell);
      const gy = Math.floor(p.y / gridCell);
      const key = gy * 100003 + gx;
      let b = grid.get(key);
      if (!b) { b = []; grid.set(key, b); }
      b.push(node);
    }
  }

  /** Node under a screen-space point, or null. Grid lookup, never a linear scan. */
  function hitTest(sx, sy) {
    if (!lastFrame || !lastFrame.positions) return null;
    const { x, y } = toWorld(sx, sy);
    const v = view(lastFrame);
    const slack = 5 / v.k;
    const gx = Math.floor(x / gridCell);
    const gy = Math.floor(y / gridCell);
    let best = null;
    let bestD = Infinity;
    let paintedProvider = null;
    let paintedProviderD = Infinity;
    let paintedProviderCount = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const b = grid.get((gy + oy) * 100003 + (gx + ox));
        if (!b) continue;
        for (const node of b) {
          const p = lastFrame.positions.get(node.id);
          if (!p) continue;
          const providerRoot = isProviderRoot(node);
          const r = providerRoot
            ? PROVIDER_HIT_PX / v.k
            : nodeRadius(node, lastFrame.opts || {}) + slack;
          const d = Math.hypot(p.x - x, p.y - y);
          // Provider satellites are painted overlays: every visible pixel of
          // their 14 px disc belongs to that provider even where the disc
          // overlaps Agent Core at minimum zoom. The transparent 14–18 px hit
          // annulus keeps ordinary nearest-centre arbitration, leaving the
          // genuine Core-only centre usable. When multiple provider discs
          // cover the same pixel, their visual ownership is ambiguous, so the
          // normal nearest-centre/Voronoi result wins across every candidate;
          // that keeps every node centre targetable without a source-order
          // provider winner at narrow radii.
          if (providerRoot && d <= PROVIDER_VISUAL_PX / v.k) {
            paintedProviderCount += 1;
            if (d < paintedProviderD) {
              paintedProviderD = d;
              paintedProvider = node;
            }
          }
          if (d <= r && d < bestD) { bestD = d; best = node; }
        }
      }
    }
    return paintedProviderCount === 1 ? paintedProvider : best;
  }

  // ---- painting ----------------------------------------------------------
  function paintGround(geom) {
    ctx.fillStyle = rgba(palette.bg, 1);
    ctx.fillRect(0, 0, W, H);
  }

  function paintDisc(geom, v) {
    const cx = geom.cx * v.k + v.x;
    const cy = geom.cy * v.k + v.y;
    const R = geom.R * v.k * 1.12;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(palette.disc1, 0.95));
    g.addColorStop(0.34, rgba(palette.disc2, 0.92));
    g.addColorStop(0.74, rgba(palette.disc3, 0.85));
    g.addColorStop(1, rgba(palette.disc3, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }

  function makeAuraOps() {
    return { gradients: 0, arcs: 0, sprites: 0 };
  }

  function stampAuraSprite(sprite, x, y, size, alpha, ops) {
    if (!sprite || ops.sprites >= 12 || size <= 0 || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
    ops.sprites += 1;
  }

  function strokeAuraArc(cx, cy, radius, start, end, color, alpha, width, ops) {
    if (ops.gradients >= 6 || ops.arcs >= 12 || radius <= 0 || alpha <= 0) return;
    const x0 = cx + Math.cos(start) * radius;
    const y0 = cy + Math.sin(start) * radius;
    const x1 = cx + Math.cos(end) * radius;
    const y1 = cy + Math.sin(end) * radius;
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, rgba(color, 0));
    gradient.addColorStop(0.58, rgba(color, alpha * 0.38));
    gradient.addColorStop(1, rgba(color, alpha));
    ops.gradients += 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke();
    ops.arcs += 1;
  }

  function angleDistance(a, b) {
    const turn = Math.PI * 2;
    const distance = Math.abs((a - b) % turn);
    return distance > Math.PI ? turn - distance : distance;
  }

  function closestRingNodes(state, geom, heads) {
    const nearest = new Map();
    const distances = new Map();
    for (const node of state.nodes || []) {
      const head = heads.get(node.ring);
      if (!Number.isFinite(head)) continue;
      const point = state.positions.get(node.id);
      if (!point) continue;
      const nodeAngle = Number.isFinite(point.a)
        ? point.a
        : Math.atan2(point.y - geom.cy, point.x - geom.cx);
      const candidate = angleDistance(nodeAngle, head);
      if (candidate < (distances.get(node.ring) ?? Infinity)) {
        nearest.set(node.ring, { node, point });
        distances.set(node.ring, candidate);
      }
    }
    return nearest;
  }

  function paintSignalAura(state, geom, v, ringed) {
    const ops = makeAuraOps();
    const aura = state.aurora;
    if (!aura?.enabled) { reportAuraOps?.(ops); return; }

    const cx = geom.cx * v.k + v.x;
    const cy = geom.cy * v.k + v.y;
    const spin = Number(aura.spinPhase) || 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (ringed) {
      const bands = geom.bands.filter((band) => band.ring !== 'core');
      const sweep = aura.ringSweep;
      const frames = [];
      bands.forEach((band, index) => {
        const local = sweep
          ? clamp01(sweep.progress * 1.45 - index * 0.15)
          : 1;
        if (local <= 0) return;
        const color = palette[band.ring] || palette.ink3;
        const head = -Math.PI / 2 + spin + (sweep ? local * Math.PI * 2 : index * 0.82);
        const span = sweep ? 0.82 : 0.46;
        const alpha = sweep ? 0.22 + Math.sin(local * Math.PI) * 0.66 : 0.16;
        const radius = band.rGuide * v.k;
        frames.push({ band, color, head, span, alpha, radius });
      });
      const sparkNodes = sweep?.allowNodeSparks
        ? closestRingNodes(state, geom, new Map(frames.map(({ band, head }) => [band.ring, head])))
        : null;
      frames.forEach(({ band, color, head, span, alpha, radius }) => {
        strokeAuraArc(cx, cy, radius, head - span, head, color, alpha, 1.6, ops);

        const headX = cx + Math.cos(head) * radius;
        const headY = cy + Math.sin(head) * radius;
        stampAuraSprite(sprites.get(band.ring), headX, headY, 24, alpha * 0.8, ops);

        if (sparkNodes) {
          const closest = sparkNodes.get(band.ring);
          if (closest) {
            const x = closest.point.x * v.k + v.x;
            const y = closest.point.y * v.k + v.y;
            stampAuraSprite(sprites.get(band.ring), x, y, 22, alpha * 0.58, ops);
          }
        }
      });
    }

    if (aura.coreFlash > 0) {
      stampAuraSprite(
        sprites.get('core'), cx, cy,
        Math.max(72, geom.bands[0].rOut * v.k * 2.6),
        aura.coreFlash,
        ops,
      );
    }

    if (state.selected && aura.selectedCorona > 0) {
      const point = state.positions.get(state.selected);
      const node = (state.nodes || []).find((item) => item.id === state.selected);
      if (point && node) {
        const x = point.x * v.k + v.x;
        const y = point.y * v.k + v.y;
        const base = isProviderRoot(node)
          ? PROVIDER_VISUAL_PX
          : nodeRadius(node, state.opts || {}) * v.k;
        const progress = clamp01(aura.selectedCorona);
        const alpha = (1 - progress) * 0.9;
        ctx.strokeStyle = rgba(palette.accentHi, alpha);
        ctx.lineWidth = 1.4;
        for (const offset of [0, 7]) {
          if (ops.arcs >= 12) break;
          ctx.beginPath();
          ctx.arc(x, y, base * (1.25 + progress * 1.25) + offset, 0, Math.PI * 2);
          ctx.stroke();
          ops.arcs += 1;
        }
      }
    }

    if (state.hover && aura.hoverBloom > 0) {
      const point = state.positions.get(state.hover);
      const node = (state.nodes || []).find((item) => item.id === state.hover);
      if (point && node) {
        const progress = clamp01(aura.hoverBloom);
        const radius = isProviderRoot(node)
          ? PROVIDER_VISUAL_PX
          : nodeRadius(node, state.opts || {}) * v.k;
        stampAuraSprite(
          sprites.get('hi'),
          point.x * v.k + v.x,
          point.y * v.k + v.y,
          radius * GLOW_SCALE * (1.15 + Math.sin(progress * Math.PI) * 0.75),
          Math.sin(progress * Math.PI) * 0.8,
          ops,
        );
      }
    }

    ctx.restore();
    reportAuraOps?.(ops);
  }

  function paintOrbits(geom, counts, k) {
    ctx.lineCap = 'butt';
    for (const band of geom.bands) {
      if (band.ring === 'core') continue;
      const c = palette[band.ring] || palette.ink3;
      const empty = (counts.get(band.ring) || 0) === 0;
      const prominent = band.ring === 'routines' || band.ring === 'applications';

      ctx.beginPath();
      ctx.arc(geom.cx, geom.cy, band.rGuide, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(c, prominent ? 0.34 : 0.13);
      ctx.lineWidth = 1 / k;
      ctx.stroke();

      // band edges — hairline ruling, the instrument-panel tell
      for (const r of [band.rIn, band.rOut]) {
        ctx.beginPath();
        ctx.arc(geom.cx, geom.cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(palette.hair, 0.5);
        ctx.lineWidth = 1 / k;
        ctx.stroke();
      }

      // An empty ring that vanishes reads as a broken design; dim placeholder
      // ticks in the ring's own hue read as "nothing here yet".
      if (empty) {
        const ticks = 54;
        ctx.strokeStyle = rgba(c, 0.3);
        ctx.lineWidth = 1.25 / k;
        for (let i = 0; i < ticks; i++) {
          const a = (i / ticks) * Math.PI * 2 - Math.PI / 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const r0 = band.rGuide - 3.5;
          const r1 = band.rGuide + 3.5;
          ctx.beginPath();
          ctx.moveTo(geom.cx + ca * r0, geom.cy + sa * r0);
          ctx.lineTo(geom.cx + ca * r1, geom.cy + sa * r1);
          ctx.stroke();
        }
      }
    }
  }

  function paintGlow(state, geom, v) {
    const all = state.nodes || [];
    const mode = state.viewMode;
    const dim = state.dimIds;
    const pad = 60;

    // Halos are additive. A ring holding hundreds of nodes would sum to a solid
    // disc at full strength and swallow both the disc gradient and the ring
    // labels, so per-ring glow strength falls off with population. Sparse rings
    // (ROUTINES, APPLICATIONS, the core) stay bright — which is exactly the
    // restraint DESIGN.md asks of the accent.
    const counts = new Map();
    for (const n of all) counts.set(n.ring, (counts.get(n.ring) || 0) + 1);

    const strength = new Map();
    const stride = new Map();
    for (const [ring, c] of counts) {
      strength.set(ring, Math.max(0.16, Math.min(1, 90 / Math.max(1, c))));
      // A budget share proportional to population divides back out to the same
      // stride for every ring, which would thin ROUTINES and the core exactly as
      // hard as a 2000-node ring. Sparse rings are cheap — never stride them.
      if (c <= SPARSE_RING) { stride.set(ring, 1); continue; }
      const share = Math.max(1, Math.round(GLOW_BUDGET * (c / Math.max(1, all.length))));
      stride.set(ring, Math.max(1, Math.ceil(c / share)));
    }

    const seen = new Map();
    ctx.globalCompositeOperation = 'lighter';
    for (const node of all) {
      const i = (seen.get(node.ring) || 0);
      seen.set(node.ring, i + 1);
      const p = state.positions.get(node.id);
      if (!p) continue;
      const isHi = node.id === state.selected || node.id === state.hover;
      // The root is the brightest thing on the canvas; its halo can never be
      // left to an index-modulo accident. It and any highlight always stamp.
      const isRoot = isAgentCoreRoot(node);
      if (!isHi && !isRoot && i % (stride.get(node.ring) || 1) !== 0) continue;
      const sx = p.x * v.k + v.x;
      const sy = p.y * v.k + v.y;
      if (sx < -pad || sy < -pad || sx > W + pad || sy > H + pad) continue;
      const sprite = sprites.get(isHi ? 'hi' : keyFor(node, mode));
      if (!sprite) continue;
      const r = isProviderRoot(node)
        ? PROVIDER_VISUAL_PX
        : nodeRadius(node, state.opts || {}) * v.k;
      let s = r * GLOW_SCALE;
      let alpha = isHi ? 1 : (strength.get(node.ring) ?? 1);
      if (isHi) s *= 1.6;
      if (dim && dim.size && !dim.has(node.id)) { s *= 0.4; alpha *= 0.3; }
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, sx - s / 2, sy - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Rings whose badge glyphs would exceed the stamp budget -> draw as dots. */
  function dottedRings(counts) {
    const badgeRings = ['skills', 'applications']
      .map((ring) => [ring, counts.get(ring) || 0])
      .sort((a, b) => b[1] - a[1]);
    let total = badgeRings.reduce((a, [, c]) => a + c, 0);
    const dotted = new Set();
    for (const [ring, c] of badgeRings) {
      if (total <= BADGE_BUDGET) break;
      dotted.add(ring);
      total -= c;
    }
    return dotted;
  }

  /**
   * Paint the topology as quiet instrument wiring beneath the nodes. The full
   * network remains legible at rest; direct links for the hovered or selected
   * node get a second, brighter pass so local structure reads immediately.
   */
  function routeRecords(state, geom) {
    const geomKey = `${geom.cx}:${geom.cy}:${geom.R ?? geom.radius ?? 0}`;
    const edges = Array.isArray(state.edges) ? state.edges : [];
    const sameEdgeRefs = routeCache.edgeRefs.length === edges.length
      && edges.every((edge, index) => routeCache.edgeRefs[index] === edge);
    if (routeCache.positions === state.positions && sameEdgeRefs
        && routeCache.layout === state.layout && routeCache.geomKey === geomKey) {
      return routeCache.records;
    }
    const nodesById = new Map((state.nodes || []).map((node) => [node.id, node]));
    const records = [];
    for (let laneIndex = 0; laneIndex < edges.length; laneIndex += 1) {
      const edge = edges[laneIndex];
      const source = state.positions?.get(edge?.source);
      const target = state.positions?.get(edge?.target);
      if (!source || !target) continue;
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const provider = targetNode?.provider === 'claude' || targetNode?.provider === 'codex'
        ? targetNode.provider
        : sourceNode?.provider === 'claude' || sourceNode?.provider === 'codex'
          ? sourceNode.provider
          : 'neutral';
      const points = routePolyline({
        edge,
        source,
        target,
        sourceRadius: nodeRadius(sourceNode || {}, state.opts || {}),
        targetRadius: nodeRadius(targetNode || {}, state.opts || {}),
        layout: state.layout,
        geom,
        laneIndex,
      });
      if (points.length >= 2) records.push({ edge, provider, points });
    }
    routeCache = {
      positions: state.positions,
      edgeRefs: edges.slice(),
      layout: state.layout,
      geomKey,
      records,
    };
    return records;
  }

  function appendRoute(points) {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
  }

  function providerColor(provider) {
    return provider === 'claude'
      ? palette.core
      : provider === 'codex' ? palette.PRODUCT : palette.hair;
  }

  function paintEdges(state, geom, k) {
    const records = routeRecords(state, geom);
    if (!records.length) return;

    const focus = new Set([state.selected, state.hover].filter(Boolean));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const provider of ['claude', 'codex', 'neutral']) {
      const branch = records.filter((item) => item.provider === provider);
      if (!branch.length) continue;
      ctx.beginPath();
      for (const { points } of branch) appendRoute(points);
      const c = providerColor(provider);
      ctx.strokeStyle = rgba(c, provider === 'neutral'
        ? (focus.size ? 0.08 : 0.14)
        : (focus.size ? 0.18 : 0.38));
      ctx.lineWidth = (provider === 'neutral' ? 0.75 : 1) / k;
      ctx.stroke();
    }

    if (focus.size) {
      for (const provider of ['claude', 'codex', 'neutral']) {
        const highlighted = records.filter(({ edge, provider: owner }) => (
          owner === provider && (focus.has(edge.source) || focus.has(edge.target))
        ));
        if (!highlighted.length) continue;
        ctx.beginPath();
        for (const { points } of highlighted) appendRoute(points);
        ctx.strokeStyle = rgba(providerColor(provider), 0.82);
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      }
    }

    const trace = state.routeTrace;
    if (trace && typeof trace.id === 'string') {
      const ancestry = records.filter(({ edge }) => edge.target === trace.id);
      if (ancestry.length) {
        ctx.beginPath();
        let traced = 0;
        for (const { points } of ancestry) {
          const partial = partialRoute(points, trace.progress);
          if (partial.length < 2) continue;
          appendRoute(partial);
          traced += 1;
        }
        if (traced) {
          ctx.strokeStyle = rgba(providerColor(ancestry[0].provider), 0.94);
          ctx.lineWidth = 1.75 / k;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function paintNodes(state, geom, k, dotted) {
    const mode = state.viewMode;
    const dim = state.dimIds;
    const hasFilter = !!(dim && dim.size);
    const labelled = [];

    // world-space viewport, so off-screen nodes cost nothing when zoomed in
    const vx = state.view?.x ?? 0;
    const vy = state.view?.y ?? 0;
    const pad = 50 / k;
    const wl = -vx / k - pad;
    const wt = -vy / k - pad;
    const wr = (W - vx) / k + pad;
    const wb = (H - vy) / k + pad;

    for (const node of state.nodes || []) {
      const p = state.positions.get(node.id);
      if (!p) continue;
      const wx = p.x;
      const wy = p.y;
      if (wx < wl || wx > wr || wy < wt || wy > wb) continue;
      const r = nodeRadius(node, state.opts || {});
      const key = keyFor(node, mode);
      const c = key === 'neutral' ? palette.ink3 : palette[key];
      const isHi = node.id === state.selected || node.id === state.hover;
      const faded = hasFilter && !dim.has(node.id);
      // department-less nodes get the neutral --ink-3 treatment and sit back, so
      // the coloured department arcs stay the thing you read first
      const neutral = key === 'neutral' && node.ring === 'memory';
      const alpha = faded ? 0.14 : neutral ? 0.5 : 1;

      if (isProviderRoot(node)) {
        const providerColor = node.id === 'claude' ? palette.core : palette.PRODUCT;
        const outerRadius = PROVIDER_VISUAL_PX / k;
        const innerRadius = PROVIDER_INNER_PX / k;
        ctx.beginPath();
        ctx.arc(wx, wy, outerRadius, 0, Math.PI * 2);
        ctx.fillStyle = node.id === 'codex'
          ? rgba(providerColor, 0.95 * alpha)
          : rgba(palette.bg, 0.9 * alpha);
        ctx.fill();
        ctx.strokeStyle = rgba(providerColor, alpha);
        ctx.lineWidth = PROVIDER_OUTER_STROKE_PX / k;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(wx, wy, innerRadius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(providerColor, 0.62 * alpha);
        ctx.lineWidth = 1 / k;
        ctx.stroke();
        const brand = brandImages.get(node.id);
        if (brand?.complete && brand.naturalWidth > 0) {
          const size = PROVIDER_GLYPH_PX / k;
          ctx.globalAlpha = alpha;
          ctx.drawImage(brand, wx - size / 2, wy - size / 2, size, size);
          ctx.globalAlpha = 1;
        } else {
          drawGlyph(ctx, node.id === 'claude' ? 'diamond' : 'terminal',
            wx, wy, PROVIDER_GLYPH_PX / k, rgba(providerColor, alpha), 1.25 / k);
        }
        labelled.push({
          node,
          x: wx,
          y: wy + (state.providerLabelLanes?.get(node.id) ?? 1) * PROVIDER_LABEL_OFFSET_PX / k,
          c: providerColor,
          size: 10.5,
          always: true,
          tracked: true,
          fixedScreenSize: true,
          text: node.id.toUpperCase(),
        });
        continue;
      }

      if (isAgentCoreRoot(node)) {
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(palette.bg, 0.85);
        ctx.fill();
        ctx.strokeStyle = rgba(palette.core, alpha);
        ctx.lineWidth = CORE_OUTER_STROKE_PX / k;
        ctx.stroke();
        drawGlyph(ctx, 'brain', wx, wy, r * 1.05, rgba(palette.core, alpha), 1.25 / k * 1.1);
        labelled.push({
          node, x: wx, y: wy + r + 15, c: palette.core, size: 11.5,
          always: true, text: RING_LABEL.core,
        });
        continue;
      }

      const starSprite = starSprites.get(key) || starSprites.get('skills');
      const hexSprite = hexSprites.get(key) || hexSprites.get('applications');
      if (node.ring === 'skills' && starSprite && !dotted.has('skills')) {
        const s = r * 3.1;
        ctx.globalAlpha = alpha;
        ctx.drawImage(starSprite, wx - s / 2, wy - s / 2, s, s);
        ctx.globalAlpha = 1;
        if (isHi) {
          ctx.beginPath();
          ctx.arc(wx, wy, r * 2, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(palette.accentHi, 1);
          ctx.lineWidth = 1.25 / k;
          ctx.stroke();
        }
      } else if (node.ring === 'applications' && hexSprite && !dotted.has('applications')) {
        const s = r * 2.4;
        ctx.globalAlpha = alpha;
        ctx.drawImage(hexSprite, wx - s / 2, wy - s / 2, s, s);
        ctx.globalAlpha = 1;
      } else if (node.ring === 'routines') {
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(palette.bg, 0.9 * alpha);
        ctx.fill();
        ctx.strokeStyle = rgba(c, alpha);
        ctx.lineWidth = 1.25 / k;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(c, alpha);
        ctx.fill();
        if (r > 9) {
          ctx.strokeStyle = rgba(palette.bg, 0.55 * alpha);
          ctx.lineWidth = 1 / k;
          ctx.stroke();
        }
      }

      if (isHi) {
        ctx.beginPath();
        ctx.arc(wx, wy, r + 6 / k, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(palette.accentHi, 0.95);
        ctx.lineWidth = 1.25 / k;
        ctx.stroke();
      }

      // large nodes print their rollup count
      if (r >= 13 && node.files > 0 && !faded) {
        setFont(`600 ${Math.round(Math.min(13, r * 0.62) / k * 2) / 2}px ${FONT_UI}`);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = rgba(palette.ink2, 1);
        ctx.fillText(String(node.files), wx, wy);
      }
      // Names are opt-in. Drawing every large node's name turns the disc into a
      // word cloud and buries the ring labels, which are the real wayfinding.
      if ((state.showLabels && r > 3.2) || isHi) {
        labelled.push({
          node, x: wx, y: wy + r + 11, r,
          c: isHi ? palette.accentHi : palette.ink2, size: 10.5,
        });
      }
    }
    return labelled;
  }

  function paintLabels(labelled, k) {
    const always = labelled.filter((label) => label.always);
    const ordinary = labelled.filter((label) => !label.always);
    const ordinaryBudget = Math.max(0, MAX_LABELS - always.length);
    const limitedOrdinary = ordinary.length > ordinaryBudget
      ? ordinary.slice().sort((a, b) => (b.r || 0) - (a.r || 0)).slice(0, ordinaryBudget)
      : ordinary;
    const list = [...always, ...limitedOrdinary];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const l of list) {
      const size = (l.size || 10.5) / k;
      const fontSize = l.fixedScreenSize
        ? size
        : Math.round(Math.max(7, size) * 2) / 2;
      setFont(`500 ${fontSize}px ${FONT_UI}`);
      const sourceText = l.text ?? l.node.label ?? '';
      const text = sourceText.length > 22 ? `${sourceText.slice(0, 21)}…` : sourceText;
      if (!text) continue;
      ctx.fillStyle = rgba(l.c, l.always ? 1 : 0.9);
      if (l.tracked) drawTracked(ctx, text, l.x, l.y, size * 0.18, 'center');
      else ctx.fillText(text, l.x, l.y);
    }
  }

  function paintRingLabels(geom, counts, k) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const band of geom.bands) {
      const c = palette[band.ring] || palette.ink3;
      const empty = (counts.get(band.ring) || 0) === 0;
      const size = 11.5 / k;
      setFont(`600 ${Math.round(Math.max(6.5, size) * 2) / 2}px ${FONT_UI}`);
      const tracking = size * 0.34;                     // --track-wide
      const y = geom.cy - band.rLabel;
      ctx.fillStyle = rgba(c, empty ? 0.5 : 0.95);
      const w = drawTracked(ctx, RING_LABEL[band.ring], geom.cx, y, tracking, 'center');
      // hairline rules either side, so the label reads as ruled, not floating
      ctx.strokeStyle = rgba(c, empty ? 0.16 : 0.3);
      ctx.lineWidth = 1 / k;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(geom.cx + dir * (w / 2 + 10 / k), y);
        ctx.lineTo(geom.cx + dir * (w / 2 + 34 / k), y);
        ctx.stroke();
      }
    }
  }

  function paintAnchors(state, geom, k) {
    if (state.viewMode === 'folders') return;
    const anchors = departmentAnchors({
      ...(state.geom || { width: W, height: H }),
      spin: state.opts?.spin ?? 0,
    });
    for (const a of anchors) {
      const c = palette[a.dept] || palette.ink3;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, 0.9);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r + 4 / k, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(c, 0.4);
      ctx.lineWidth = 1 / k;
      ctx.stroke();
      drawGlyph(ctx, a.glyph, a.x, a.y, a.r * 1.25, rgba(palette.bg, 1), 1.6 / k);

      const size = 10 / k;
      setFont(`600 ${Math.round(Math.max(6, size) * 2) / 2}px ${FONT_UI}`);
      ctx.textBaseline = 'middle';
      const out = a.r + 15 / k;
      drawTracked(ctx, a.dept,
        a.x + Math.cos(a.angle) * out * 0.15,
        a.y + Math.sin(a.angle) * out + (Math.sin(a.angle) >= 0 ? 4 / k : -2 / k),
        size * 0.18, 'center');
    }
  }

  let FONT_UI = 'system-ui';
  let lastFont = '';

  function setFont(str) {
    if (str === lastFont) return;
    lastFont = str;
    ctx.font = str;
  }
  function readFont() {
    const cs = getComputedStyle(document.documentElement);
    FONT_UI = (cs.getPropertyValue('--f-ui') || '').trim() || 'system-ui';
  }

  /**
   * Paint one frame. Called on change and during tweens — never from an
   * unconditional rAF loop.
   */
  function draw(state) {
    if (destroyed || !state) return;
    last = state;
    const v = view(state);
    const projection = projectProviderCluster(state, v);
    const frameState = projection.positions === state.positions && !projection.labelLanes
      ? state
      : {
          ...state,
          positions: projection.positions,
          providerLabelLanes: projection.labelLanes,
        };
    lastFrame = frameState;
    const geom = ringGeometry(state.geom || { width: W, height: H });

    const counts = new Map(RING_ORDER.map((r) => [r, 0]));
    for (const n of state.nodes || []) {
      if (counts.has(n.ring)) counts.set(n.ring, counts.get(n.ring) + 1);
    }

    // Orbits, ring labels and department anchors describe where the RINGS
    // layout puts things. In Circle/Hex/Force the nodes no longer sit on those
    // radii, so drawing them would assert a structure that is not there.
    const ringed = (state.layout ?? 'rings') === 'rings';

    paintGround(geom);
    paintDisc(geom, v);
    paintSignalAura(frameState, geom, v, ringed);
    paintGlow(frameState, geom, v);

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.k, v.k);
    if (ringed) paintOrbits(geom, counts, v.k);
    paintEdges(frameState, geom, v.k);
    const labelled = paintNodes(frameState, geom, v.k, dottedRings(counts));
    if (ringed) paintAnchors(frameState, geom, v.k);
    paintLabels(labelled, v.k);
    if (ringed) paintRingLabels(geom, counts, v.k);
    ctx.restore();

    buildGrid(frameState);
  }

  function destroy() {
    destroyed = true;
    if (dprQuery) dprQuery.removeEventListener('change', onDpr);
    dprQuery = null;
    sprites = new Map();
    starSprites = new Map();
    hexSprites = new Map();
    brandImages = new Map();
    grid = new Map();
    routeCache = { positions: null, edgeRefs: [], layout: null, geomKey: '', records: [] };
    last = null;
    lastFrame = null;
  }

  const api = {
    draw, resize, hitTest, toWorld, geometry, refreshPalette, destroy,
    width: 0, height: 0,
    get palette() { return palette; },
  };

  readFont();
  buildSprites();
  buildBrandImages();
  resize();
  return api;
}
