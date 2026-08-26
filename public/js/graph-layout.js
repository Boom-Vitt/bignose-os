// public/js/graph-layout.js — Slice G · pure layout maths for the Second Brain graph.
//
// No canvas, no DOM, no globals, no Math.random(). Every function is pure:
// same input -> same output, so positions can be baked and replayed.
// Randomness, where it is needed at all, comes from mulberry32 seeded off the
// node id, which keeps a node in the same place across reloads.
//
// CONTRACT.md §6 defines the Node shape. DESIGN.md §"Layout — Second Brain"
// defines the five rings and the department sectors.

// ---------------------------------------------------------------------------
// constants shared with graph-render.js so both agree on where a ring lives
// ---------------------------------------------------------------------------

/** inner -> outer */
export const RING_ORDER = ['core', 'skills', 'memory', 'routines', 'applications'];

export const RING_LABEL = {
  core: 'AGENT CORE',
  skills: 'SKILLS',
  memory: 'MEMORY',
  routines: 'ROUTINES',
  applications: 'APPLICATIONS',
};

export function isProviderRoot(node) {
  return !!node && (node.id === 'claude' || node.id === 'codex')
    && (node.provider === node.id || node.provider == null);
}

/** CSS custom property carrying each ring's hue. */
export const RING_TOKEN = {
  core: '--ring-core',
  skills: '--ring-skills',
  memory: '--ring-memory',
  routines: '--ring-routines',
  applications: '--ring-apps',
};

export const DEPARTMENTS = ['BUSINESS', 'CONTENT', 'COMMUNITY', 'PRODUCT', 'PERSONAL'];

export const DEPT_TOKEN = {
  BUSINESS: '--dep-business',
  CONTENT: '--dep-content',
  COMMUNITY: '--dep-community',
  PRODUCT: '--dep-product',
  PERSONAL: '--dep-personal',
};

/** Monoline glyph (a key in icons.js ICONS) for each department anchor. */
export const DEPT_GLYPH = {
  BUSINESS: 'grid',
  CONTENT: 'pen-tool',
  COMMUNITY: 'mail',
  PRODUCT: 'bolt',
  PERSONAL: 'brain',
};

/**
 * Radial budget, as a fraction of R. Band widths are NOT fixed: a ring's
 * thickness is derived from how many nodes it holds, so a 700-node SKILLS ring
 * gets room to breathe and a 14-node ROUTINES ring stays a thin orbit. Without
 * this, a populous ring packs its nodes into overlapping rows and reads as a
 * solid blob rather than dot arcs.
 */
// The provider satellites have a 14 px visual radius and an 18 px hit radius.
// Keep the core band wide enough that both fit beside the Agent Core without
// overlapping its hit target at the supported minimum radius.
const CORE_OUT = 0.38;
const OUTER_EDGE = 0.945;
/** gutters after core, skills, memory (the department anchor lane) and routines */
const GUTTERS = { core: 0.055, skills: 0.050, memory: 0.105, routines: 0.050 };
const MIN_BAND = 0.042;
const FLEX_RINGS = ['skills', 'memory', 'routines', 'applications'];

/** Angular gutter between two department sectors, radians. */
const SECTOR_GUTTER = 0.038;

/** 12 o'clock. Sector boundaries start here, so the top is always a gutter. */
const TOP = -Math.PI / 2;

// ---------------------------------------------------------------------------
// seeded PRNG — ours, tiny, deterministic
// ---------------------------------------------------------------------------

/** FNV-1a over a string -> uint32 seed. */
export function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clipToward(from, toward, radius) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const scale = Math.max(0, Number(radius) || 0) / distance;
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function compactRoute(points) {
  const finite = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  const unique = finite.filter((point, index) => (
    index === 0 || Math.hypot(point.x - finite[index - 1].x, point.y - finite[index - 1].y) > 0.01
  ));
  const out = unique.filter((point, index) => {
    if (index === 0 || index === unique.length - 1) return true;
    const before = unique[index - 1];
    const after = unique[index + 1];
    const cross = (point.x - before.x) * (after.y - point.y)
      - (point.y - before.y) * (after.x - point.x);
    return Math.abs(cross) > 0.01;
  });
  return Object.freeze(out.map((point) => Object.freeze({ x: point.x, y: point.y })));
}

/**
 * Route one relationship as a deterministic bent polyline. Non-radial layouts
 * use axis-aligned doglegs; Rings uses a shared radial lane so routes follow
 * the instrument's concentric topology instead of cutting straight through it.
 */
export function routePolyline({
  edge,
  source,
  target,
  sourceRadius = 0,
  targetRadius = 0,
  layout = 'rings',
  geom = {},
  laneIndex = 0,
} = {}) {
  if (![source?.x, source?.y, target?.x, target?.y].every(Number.isFinite)) {
    return Object.freeze([]);
  }

  const id = `${edge?.source ?? ''}>${edge?.target ?? ''}`;
  const lane = Number.isFinite(Number(laneIndex)) ? Number(laneIndex) : 0;
  const stable = (((hashId(id) + (lane >>> 0)) % 5) - 2) * 3;

  if (layout !== 'rings') {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
    if (horizontalFirst) {
      const direction = Math.sign(dx) || 1;
      const start = { x: source.x + direction * Math.max(0, Number(sourceRadius) || 0), y: source.y };
      const end = { x: target.x - direction * Math.max(0, Number(targetRadius) || 0), y: target.y };
      const x = (start.x + end.x) / 2 + stable;
      if (Math.abs(start.y - end.y) < 0.01) {
        const laneDirection = (hashId(id) & 1) === 0 ? -1 : 1;
        const y = start.y + laneDirection * (18 + Math.abs(stable));
        const shoulder = Math.max(4, Math.min(24, Math.abs(end.x - start.x) / 3));
        const startX = start.x + direction * shoulder;
        const endX = end.x - direction * shoulder;
        return compactRoute([
          start,
          { x: startX, y: start.y },
          { x: startX, y },
          { x: endX, y },
          { x: endX, y: end.y },
          end,
        ]);
      }
      return compactRoute([start, { x, y: start.y }, { x, y: end.y }, end]);
    }
    const direction = Math.sign(dy) || 1;
    const start = { x: source.x, y: source.y + direction * Math.max(0, Number(sourceRadius) || 0) };
    const end = { x: target.x, y: target.y - direction * Math.max(0, Number(targetRadius) || 0) };
    const y = (start.y + end.y) / 2 + stable;
    if (Math.abs(start.x - end.x) < 0.01) {
      const laneDirection = (hashId(id) & 1) === 0 ? -1 : 1;
      const x = start.x + laneDirection * (18 + Math.abs(stable));
      const shoulder = Math.max(4, Math.min(24, Math.abs(end.y - start.y) / 3));
      const startY = start.y + direction * shoulder;
      const endY = end.y - direction * shoulder;
      return compactRoute([
        start,
        { x: start.x, y: startY },
        { x, y: startY },
        { x, y: endY },
        { x: end.x, y: endY },
        end,
      ]);
    }
    return compactRoute([start, { x: start.x, y }, { x: end.x, y }, end]);
  }

  const start = clipToward(source, target, sourceRadius);
  const end = clipToward(target, source, targetRadius);
  const cx = Number.isFinite(geom.cx) ? geom.cx : 0;
  const cy = Number.isFinite(geom.cy) ? geom.cy : 0;
  const sourceAngle = Math.atan2(start.y - cy, start.x - cx);
  const targetAngle = Math.atan2(end.y - cy, end.x - cx);
  const sourceDistance = Math.hypot(start.x - cx, start.y - cy);
  const targetDistance = Math.hypot(end.x - cx, end.y - cy);
  const laneRadius = Math.max(18, (sourceDistance + targetDistance) / 2 + stable);
  return compactRoute([
    start,
    { x: cx + Math.cos(sourceAngle) * laneRadius, y: cy + Math.sin(sourceAngle) * laneRadius },
    { x: cx + Math.cos(targetAngle) * laneRadius, y: cy + Math.sin(targetAngle) * laneRadius },
    end,
  ]);
}

/** mulberry32 — returns a function producing floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Convert graph density into world-space breathing room. The viewport factor
 * intentionally grows the world on smaller screens instead of compressing the
 * same nodes into fewer pixels; pan and zoom already provide navigation.
 */
export function adaptiveLayoutMetrics({
  nodeCount = 0,
  width = 980,
  height = 720,
  spacingBias = 16,
} = {}) {
  const count = Math.max(0, Number(nodeCount) || 0);
  const w = Math.max(320, Number(width) || 980);
  const h = Math.max(320, Number(height) || 720);
  const bias = clamp(Number(spacingBias) || 16, 8, 32);
  const referenceArea = 980 * 720;
  const viewportFactor = clamp(Math.sqrt(referenceArea / (w * h)), 0.85, 1.35);
  const density = Math.max(0, Math.sqrt(count) - Math.sqrt(80));
  const spacing = Math.round(clamp(bias + density * 0.8 * viewportFactor, 8, 40) * 100) / 100;
  const radiusScale = Math.round(clamp(spacing / 16, 1, 2.5) * 1000) / 1000;
  return { spacing, radiusScale };
}

/**
 * Resolve the ring geometry for a viewport. Pure.
 * @param {{width?:number,height?:number,cx?:number,cy?:number,radius?:number}} opts
 * @returns {{cx:number,cy:number,R:number,bands:Array<{ring:string,label:string,
 *   rIn:number,rOut:number,rLabel:number,rGuide:number}>,anchorR:number}}
 */
export function ringGeometry(opts = {}) {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const cx = opts.cx ?? width / 2;
  const cy = opts.cy ?? height / 2;
  const R = opts.radius ?? Math.max(140, Math.min(width, height) / 2 - 48);

  const counts = opts.counts || {};
  const get = (ring) => Math.max(0, Number(
    counts instanceof Map ? counts.get(ring) : counts[ring]) || 0);

  // sqrt weighting: a ring 50x more populous gets ~7x the width, not 50x
  const weights = FLEX_RINGS.map((r) => Math.sqrt(get(r)));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const gutterSum = GUTTERS.core + GUTTERS.skills + GUTTERS.memory + GUTTERS.routines;
  const budget = OUTER_EDGE - CORE_OUT - gutterSum;
  const flex = Math.max(0, budget - MIN_BAND * FLEX_RINGS.length);

  // Bound any one ring's share of the flex budget. Upstream aggregation can be
  // in flux (a ring briefly carrying thousands of nodes instead of tens), and
  // one runaway ring must not squeeze the other four into hairlines.
  const SHARE_CAP = 0.42;
  let shares = FLEX_RINGS.map((_, i) => (wSum > 0 ? weights[i] / wSum : 1 / FLEX_RINGS.length));
  let excess = 0;
  shares = shares.map((sh) => {
    if (sh <= SHARE_CAP) return sh;
    excess += sh - SHARE_CAP;
    return SHARE_CAP;
  });
  if (excess > 0) {
    const room = shares.map((sh) => SHARE_CAP - sh);
    const roomSum = room.reduce((a, b) => a + b, 0);
    if (roomSum > 0) shares = shares.map((sh, i) => sh + excess * (room[i] / roomSum));
  }

  const widths = {};
  FLEX_RINGS.forEach((ring, i) => {
    widths[ring] = MIN_BAND + shares[i] * flex;
  });

  const bands = [];
  let cursor = 0;
  for (const ring of RING_ORDER) {
    const w = ring === 'core' ? CORE_OUT : widths[ring];
    const rIn = cursor;
    const rOut = cursor + w;
    const gutter = GUTTERS[ring] ?? 0.05;
    bands.push({
      ring,
      label: RING_LABEL[ring],
      rIn: rIn * R,
      rOut: rOut * R,
      // the label always sits in the gutter above its band, so it can never
      // land on a node and layout never needs to know about text metrics
      rLabel: (rOut + gutter * (ring === 'memory' ? 0.28 : ring === 'core' ? 0.78 : 0.5)) * R,
      rGuide: ((rIn + rOut) / 2) * R,
    });
    cursor = rOut + gutter;
  }

  const memory = bands.find((b) => b.ring === 'memory');
  const anchorR = memory ? memory.rOut + GUTTERS.memory * R * 0.62 : 0.7 * R;
  return { cx, cy, R, bands, anchorR };
}

/**
 * The five department anchor markers around the MEMORY ring. Pure.
 * @returns {Array<{dept:string,glyph:string,token:string,angle:number,x:number,y:number,r:number}>}
 */
export function departmentAnchors(opts = {}) {
  const { cx, cy, anchorR } = ringGeometry(opts);
  const spin = opts.spin ?? 0;
  const span = (Math.PI * 2 - SECTOR_GUTTER * DEPARTMENTS.length) / DEPARTMENTS.length;
  return DEPARTMENTS.map((dept, i) => {
    const a0 = TOP + SECTOR_GUTTER / 2 + i * (span + SECTOR_GUTTER);
    const angle = a0 + span / 2 + spin;
    return {
      dept,
      glyph: DEPT_GLYPH[dept],
      token: DEPT_TOKEN[dept],
      angle,
      x: cx + Math.cos(angle) * anchorR,
      y: cy + Math.sin(angle) * anchorR,
      r: 11,
    };
  });
}

// ---------------------------------------------------------------------------
// node radius
// ---------------------------------------------------------------------------

const BASE_R = { core: 27, skills: 3.6, memory: 3.4, routines: 6.5, applications: 8.5 };

/**
 * How far a ring's nodes may grow with their rollup. ROUTINES and APPLICATIONS
 * are described as uniform badges rather than magnitude marks, so they stay
 * close to their base size; MEMORY carries the magnitude reading.
 */
const GROW_CAP = { core: 0.7, skills: 1.2, memory: 1.75, routines: 0.5, applications: 0.5 };

/**
 * Above this population a ring holds far more nodes than its band was ever
 * meant to show, and full-size nodes merge into an opaque slab that reads as a
 * broken render rather than a ring. Nodes shrink from here so the ring stays a
 * ring. Below it, sizing is untouched — normal data never takes this path.
 */
const OVERSUBSCRIBED = 700;
const MAX_R = { core: 46, skills: 16, memory: 22, routines: 11, applications: 13 };

/**
 * Node radius, scaled by the rollup `files` count (DESIGN.md).
 * Pure and independent of layout, so the renderer and the hit grid agree.
 * @param {object} node
 * @param {{nodeScale?:number}} [opts]
 * @returns {number}
 */
export function nodeRadius(node, opts = {}) {
  const scale = opts.nodeScale ?? 1;
  if (isProviderRoot(node)) return 14 * scale;
  const isRoot = node && node.ring === 'core'
    && (node.id === 'agent-core' || node.id === '' || node.depth === 0);
  // Only the true root gets the big centre treatment. Other `core` entries are
  // satellites — at full core size a dozen of them overlap into one blob.
  const base = isRoot ? BASE_R.core
    : node?.ring === 'core' ? 5.5
      : BASE_R[node?.ring] ?? BASE_R.memory;

  if (node?.kind === 'file' && !isRoot) {
    // files carry no rollup; nudge by byte size only, and stay small
    const kb = Math.max(0, Number(node.size) || 0) / 1024;
    return clamp(base * 0.62 * (1 + Math.min(0.5, Math.sqrt(kb) / 26)), 2, 9) * scale;
  }
  const ring = node?.ring;
  const files = Math.max(0, Number(node?.files) || 0);
  const counts = opts.counts;
  const ringCount = counts
    ? Number(counts instanceof Map ? counts.get(ring) : counts[ring]) || 0
    : 0;
  const density = ringCount > OVERSUBSCRIBED
    ? clamp(Math.sqrt(OVERSUBSCRIBED / ringCount), 0.45, 1)
    : 1;
  const grow = Math.min(GROW_CAP[ring] ?? 1.75, Math.sqrt(files) / 8.5);
  // The root must fit inside its own band, or it overlaps the CLAUDE.MD ring
  // label and swallows its satellites. Tie it to R when R is known.
  const rootCap = opts.radius ? Math.min(MAX_R.core, opts.radius * 0.068) : MAX_R.core;
  const cap = isRoot ? rootCap : ring === 'core' ? 7 : MAX_R[ring] ?? 22;
  return clamp(base * (1 + grow) * density, 2.0, cap) * scale;
}

// ---------------------------------------------------------------------------
// deterministic ordering
// ---------------------------------------------------------------------------

/** Sorts department-less nodes last, deterministically. */
const DEPT_LAST = '\uffff';

function byDeptThenLabel(a, b) {
  const da = a.department ?? DEPT_LAST;
  const db = b.department ?? DEPT_LAST;
  if (da !== db) return da < db ? -1 : 1;
  const la = a.label ?? '';
  const lb = b.label ?? '';
  if (la !== lb) return la < lb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Spread `list` across concentric sub-rows inside a radial band so the angular
 * gap between neighbours stays roughly constant — this is what turns a ring of
 * 700 nodes into readable dot arcs instead of a solid line.
 */
/**
 * Inset a band by the radius of its largest node so node *extents*, not node
 * centres, stay inside [rIn, rOut]. Without this a ring's outermost dots spill
 * into the gutter and collide with the ring label that lives there.
 */
function padBand(rIn, rOut, pad) {
  const a = rIn + pad;
  const b = rOut - pad;
  if (b <= a) { const m = (rIn + rOut) / 2; return [m, m]; }
  return [a, b];
}

function rowCapacity(radius, span, minGap, closed) {
  if (radius <= 0) return 1;
  const ratio = Math.min(1, minGap / (2 * radius));
  const minimumAngle = 2 * Math.asin(ratio);
  if (!(minimumAngle > 0)) return 1;
  return Math.max(1, Math.floor(span / minimumAngle) + (closed ? 0 : 1));
}

function packingRows(rIn, rOut, span, minGap, closed) {
  const radialSpan = Math.max(0, rOut - rIn);
  const maxRows = Math.max(1, Math.min(14, Math.floor(radialSpan / minGap) + 1));
  const rows = [];
  for (let index = 0; index < maxRows; index++) {
    const radius = maxRows === 1 ? (rIn + rOut) / 2 : rIn + (radialSpan * index) / (maxRows - 1);
    rows.push({ radius, capacity: rowCapacity(radius, span, minGap, closed) });
  }
  return rows;
}

function bandCapacity(rIn, rOut, span, minGap, closed = false) {
  return packingRows(rIn, rOut, span, minGap, closed)
    .reduce((total, row) => total + row.capacity, 0);
}

function fillBand(out, list, cx, cy, rIn, rOut, a0, a1, spin, minGap) {
  const n = list.length;
  if (!n) return;
  const span = Math.max(0.05, a1 - a0);
  const closed = span >= Math.PI * 2 - 1e-6;
  const available = packingRows(rIn, rOut, span, minGap, closed);
  let rows = 1;
  let capTotal = available[0].capacity;
  while (rows < available.length && capTotal < n) {
    capTotal += available[rows].capacity;
    rows += 1;
  }
  const radii = available.slice(0, rows).map((row) => ({
    r: row.radius,
    cap: row.capacity,
  }));

  // A caller can supply a physically undersized fixed band. Preserve the
  // no-overlap contract by extending deterministic outer lanes; the mounted
  // viewer's adaptive radius keeps normal graphs on their intended bands.
  while (capTotal < n) {
    const r = radii[radii.length - 1].r + minGap;
    const cap = rowCapacity(r, span, minGap, closed);
    radii.push({ r, cap });
    capTotal += cap;
  }

  const takes = radii.map(({ cap }) => Math.min(cap, Math.floor((n * cap) / capTotal)));
  let allocated = takes.reduce((total, take) => total + take, 0);
  for (let index = 0; allocated < n; index = (index + 1) % takes.length) {
    if (takes[index] >= radii[index].cap) continue;
    takes[index] += 1;
    allocated += 1;
  }

  let cursor = 0;
  for (let i = 0; i < radii.length; i++) {
    const take = takes[i];
    if (take <= 0) continue;
    const slice = list.slice(cursor, cursor + take);
    cursor += take;
    const step = closed ? span / take : span / Math.max(1, take - (take > 1 ? 1 : 0));
    // Closed rows can stagger without leaving their lane. Open sectors retain
    // their boundary gutter so neighbouring departments cannot collide.
    const shift = closed ? (i % 2) * step * 0.5 : 0;
    for (let j = 0; j < slice.length; j++) {
      const a = a0 + shift + step * j + spin;
      out.set(slice[j].id, {
        x: cx + Math.cos(a) * radii[i].r,
        y: cy + Math.sin(a) * radii[i].r,
        r: radii[i].r,
        a,
      });
    }
    if (cursor >= n) break;
  }
}

// ---------------------------------------------------------------------------
// layouts
// ---------------------------------------------------------------------------

/**
 * The default layout: five concentric rings, MEMORY partitioned into five
 * department sectors. Pure.
 * @param {Array<object>} nodes
 * @param {{width:number,height:number,cx?:number,cy?:number,radius?:number,
 *          spin?:number,spacing?:number,nodeScale?:number}} [opts]
 * @returns {Map<string,{x:number,y:number,r:number}>}
 */
export function layoutRings(nodes, opts = {}) {
  const pos = new Map();
  const list = Array.isArray(nodes) ? nodes : [];
  const { cx, cy, bands } = ringGeometry(opts);
  const spin = opts.spin ?? 0;
  const gap = clamp(opts.spacing ?? 9, 5, 40);

  const byRing = new Map(RING_ORDER.map((r) => [r, []]));
  for (const n of list) (byRing.get(n.ring) ?? byRing.get('memory')).push(n);

  for (const band of bands) {
    const group = byRing.get(band.ring) ?? [];
    if (!group.length) continue;

    if (band.ring === 'core') {
      const sorted = group.slice().sort(byDeptThenLabel);
      // the true root sits dead centre; anything else in `core` orbits it close in
      const rootIdx = sorted.findIndex((n) => n.id === 'agent-core' || n.id === '' || n.depth === 0);
      const root = rootIdx >= 0 ? sorted.splice(rootIdx, 1)[0] : sorted.shift();
      if (root) pos.set(root.id, { x: cx, y: cy, r: 0, a: 0 });
      const providerRoots = sorted.filter(isProviderRoot);
      const rootHitRadius = root ? nodeRadius(root, opts) + 5 : 0;
      const minProviderOffset = rootHitRadius + 18;
      const maxProviderOffset = Math.max(0, band.rOut - 18);
      const providerOffset = Math.min(maxProviderOffset, Math.max(48, minProviderOffset));
      for (const providerRoot of providerRoots) {
        const direction = providerRoot.id === 'claude' ? -1 : 1;
        pos.set(providerRoot.id, {
          x: cx + direction * providerOffset,
          y: cy,
          r: providerOffset,
          a: direction < 0 ? Math.PI : 0,
        });
      }
      const providerIds = new Set(providerRoots.map((node) => node.id));
      const orbiting = sorted.filter((node) => !providerIds.has(node.id));
      if (orbiting.length) {
        // satellites ride the band's outer edge so they clear the root disc
        const satR = Math.max(...orbiting.map((n) => nodeRadius(n, opts)));
        const rSat = band.rOut - satR;
        fillBand(pos, orbiting, cx, cy, rSat, rSat, TOP, TOP + Math.PI * 2, spin,
          Math.max(gap * 1.5, satR * 2 + 2));
      }
      continue;
    }

    if (band.ring === 'memory') {
      const withDept = [];
      const neutral = [];
      for (const n of group) (n.department && DEPT_TOKEN[n.department] ? withDept : neutral).push(n);

      const frac = withDept.length
        ? clamp(withDept.length / (withDept.length + neutral.length), 0.34, 1)
        : 0;
      const split = band.rIn + (band.rOut - band.rIn) * frac;

      const memPad = group.length ? Math.max(...group.map((n) => nodeRadius(n, opts))) : 0;
      const memoryGap = Math.max(gap * 0.82, memPad * 2 + 2);
      const span = (Math.PI * 2 - SECTOR_GUTTER * DEPARTMENTS.length) / DEPARTMENTS.length;
      const [dIn, dOut] = padBand(band.rIn, split, memPad);
      const inner = withDept.length ? split + (band.rOut - split) * 0.14 : band.rIn;
      const [nIn, nOut] = padBand(inner, band.rOut, memPad);
      const sectorsFit = withDept.length > 0 && DEPARTMENTS.every((dept) => (
        withDept.filter((node) => node.department === dept).length
          <= bandCapacity(dIn, dOut, span, memoryGap)
      )) && neutral.length <= bandCapacity(nIn, nOut, Math.PI * 2, memoryGap, true);

      if (!sectorsFit) {
        const [mIn, mOut] = padBand(band.rIn, band.rOut, memPad);
        fillBand(pos, group.slice().sort(byDeptThenLabel), cx, cy, mIn, mOut,
          TOP, TOP + Math.PI * 2, spin, memoryGap);
        continue;
      }

      if (withDept.length) {
        DEPARTMENTS.forEach((dept, i) => {
          const members = withDept.filter((n) => n.department === dept).sort(byDeptThenLabel);
          if (!members.length) return;
          const a0 = TOP + SECTOR_GUTTER / 2 + i * (span + SECTOR_GUTTER);
          fillBand(pos, members, cx, cy, dIn, dOut, a0, a0 + span, spin, memoryGap);
        });
      }
      if (neutral.length) {
        fillBand(pos, neutral.slice().sort(byDeptThenLabel), cx, cy, nIn, nOut,
          TOP, TOP + Math.PI * 2, spin, memoryGap);
      }
      continue;
    }

    const pad = Math.max(...group.map((n) => nodeRadius(n, opts)));
    const [gIn, gOut] = padBand(band.rIn, band.rOut, pad);
    fillBand(pos, group.slice().sort(byDeptThenLabel), cx, cy, gIn, gOut,
      TOP, TOP + Math.PI * 2, spin, Math.max(gap, pad * 2 + 2));
  }

  // anything with an unrecognised ring falls just outside the disc rather than
  // stacking on the origin
  for (const n of list) {
    if (pos.has(n.id)) continue;
    const rnd = mulberry32(hashId(n.id));
    const a = rnd() * Math.PI * 2;
    const rr = bands[bands.length - 1].rOut * (1.04 + rnd() * 0.06);
    pos.set(n.id, { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, r: rr, a });
  }
  return pos;
}

/**
 * Concentric circles by tree depth. Pure.
 * @returns {Map<string,{x:number,y:number,r:number}>}
 */
export function layoutCircle(nodes, opts = {}) {
  const pos = new Map();
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return pos;
  const { cx, cy, R } = ringGeometry(opts);
  const spin = opts.spin ?? 0;
  const gap = clamp(opts.spacing ?? 9, 5, 40);

  const depths = new Map();
  for (const n of list) {
    const d = Math.max(0, Number(n.depth) || 0);
    if (!depths.has(d)) depths.set(d, []);
    depths.get(d).push(n);
  }
  const keys = [...depths.keys()].sort((a, b) => a - b);
  const maxD = keys[keys.length - 1] || 1;

  for (const d of keys) {
    const group = depths.get(d).slice().sort(byDeptThenLabel);
    if (d === 0 && group.length === 1) {
      pos.set(group[0].id, { x: cx, y: cy, r: 0, a: 0 });
      continue;
    }
    const t = maxD === 0 ? 1 : d / maxD;
    const rIn = R * (0.10 + t * 0.80);
    const rOut = rIn + R * 0.055;
    fillBand(pos, group, cx, cy, rIn, rOut, TOP, TOP + Math.PI * 2, spin, gap);
  }
  return pos;
}

/**
 * Axial hex-grid packing, spiralling out from the centre.
 * Step values are rounded to whole pixels: an exact sqrt(3) ratio produces
 * ~1% row banding, integers produce none. Pure.
 * @returns {Map<string,{x:number,y:number,r:number}>}
 */
export function layoutHex(nodes, opts = {}) {
  const pos = new Map();
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return pos;
  const { cx, cy } = ringGeometry(opts);

  const size = clamp(Math.round(opts.spacing ?? 11), 5, 40);
  const dx = Math.round(size * 1.732);          // horizontal step, whole pixels
  const dy = Math.round(size * 1.5);            // row step, whole pixels
  const half = Math.round(dx / 2);              // odd-row offset, whole pixels

  const ordered = list.slice().sort((a, b) => {
    const ra = RING_ORDER.indexOf(a.ring);
    const rb = RING_ORDER.indexOf(b.ring);
    if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return byDeptThenLabel(a, b);
  });

  // axial spiral: ring 0 is the origin, ring k has 6k cells
  const cells = [];
  cells.push([0, 0]);
  // axial neighbour order matters: walking these in sequence from the corner
  // (-k, +k) keeps every step on the ring of distance k. A different ordering
  // of the same six vectors walks off the ring and the spiral drifts.
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let k = 1; cells.length < ordered.length; k++) {
    let q = -k;
    let r = k;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        cells.push([q, r]);
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
    if (k > 400) break;
  }

  for (let i = 0; i < ordered.length; i++) {
    const [q, r] = cells[i] ?? [0, 0];
    const x = cx + q * dx + r * half;
    const y = cy + r * dy;
    pos.set(ordered[i].id, { x, y, r: Math.hypot(x - cx, y - cy), a: Math.atan2(y - cy, x - cx) });
  }
  return pos;
}

/**
 * Hand-rolled velocity-Verlet force layout. No d3, no vendored code.
 * Repulsion runs against a coarse uniform grid rather than all pairs, so the
 * cost is ~O(n) per step at these densities. Seeded from layoutRings so it
 * converges quickly and never opens as an explosion. Pure and deterministic:
 * runs to a fixed iteration cap or until kinetic energy settles.
 * @returns {Map<string,{x:number,y:number,r:number}>}
 */
export function layoutForce(nodes, edges, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const pos = new Map();
  if (!list.length) return pos;

  const { cx, cy, R } = ringGeometry(opts);
  const seed = layoutRings(list, { ...opts, spin: 0 });
  const springK = clamp(opts.springs ?? 0.35, 0, 1);
  const iterations = Math.max(1, opts.iterations ?? 300);

  const n = list.length;
  const idx = new Map();
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const rad = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const node = list[i];
    idx.set(node.id, i);
    const s = seed.get(node.id);
    const rnd = mulberry32(hashId(node.id));
    px[i] = (s ? s.x : cx) + (rnd() - 0.5) * 2;
    py[i] = (s ? s.y : cy) + (rnd() - 0.5) * 2;
    rad[i] = nodeRadius(node, opts);
  }

  const es = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a !== undefined && b !== undefined && a !== b) es.push(a, b);
  }

  const cell = Math.max(18, R / 14);
  const repel = 240 + 900 * (1 - springK);
  const restLen = 26 + 60 * springK;
  const damping = 0.82;
  const gravity = 0.0016;
  const buckets = new Map();

  for (let iter = 0; iter < iterations; iter++) {
    buckets.clear();
    for (let i = 0; i < n; i++) {
      const key = ((py[i] / cell) | 0) * 100003 + ((px[i] / cell) | 0);
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push(i);
    }

    // repulsion: each node against its own cell and the 8 neighbours
    for (let i = 0; i < n; i++) {
      const gx = (px[i] / cell) | 0;
      const gy = (py[i] / cell) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const b = buckets.get((gy + oy) * 100003 + (gx + ox));
          if (!b) continue;
          for (let k = 0; k < b.length; k++) {
            const j = b[k];
            if (j <= i) continue;
            let dx = px[i] - px[j];
            let dy = py[i] - py[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > cell * cell * 4) continue;
            if (d2 < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = dx * dx + dy * dy; }
            const min = rad[i] + rad[j] + 2;
            const f = repel / d2 + (d2 < min * min ? 6 : 0);
            const d = Math.sqrt(d2);
            const ux = (dx / d) * f;
            const uy = (dy / d) * f;
            vx[i] += ux; vy[i] += uy;
            vx[j] -= ux; vy[j] -= uy;
          }
        }
      }
    }

    // springs
    for (let k = 0; k < es.length; k += 2) {
      const a = es[k];
      const b = es[k + 1];
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const d = Math.hypot(dx, dy) || 0.001;
      const f = ((d - restLen) / d) * springK * 0.5;
      vx[a] += dx * f; vy[a] += dy * f;
      vx[b] -= dx * f; vy[b] -= dy * f;
    }

    // gravity toward centre + integrate
    let ke = 0;
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] + (cx - px[i]) * gravity) * damping;
      vy[i] = (vy[i] + (cy - py[i]) * gravity) * damping;
      const sp = vx[i] * vx[i] + vy[i] * vy[i];
      if (sp > 400) { const s = 20 / Math.sqrt(sp); vx[i] *= s; vy[i] *= s; }
      px[i] += vx[i];
      py[i] += vy[i];
      ke += sp;
    }
    if (ke / n < 0.004) break;   // settled
  }

  for (let i = 0; i < n; i++) {
    const x = px[i];
    const y = py[i];
    pos.set(list[i].id, { x, y, r: Math.hypot(x - cx, y - cy), a: Math.atan2(y - cy, x - cx) });
  }
  return pos;
}
