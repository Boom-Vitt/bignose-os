// Beginner-facing, local-only Second Brain workspace.
// The browser receives bounded derived fields from /api/brain; raw documents
// are never requested or rendered here.

import { fetchLocalApi } from '../local-api.js';
import { routePolyline } from '../graph-layout.js';
import {
  indexStructureGraph,
  projectStructureGraph,
  layoutStructureGraph,
  roleForStructureNode,
  providerForStructureNode,
  VISIBLE_NODE_LIMIT,
  SEMANTIC_LIMIT,
} from '../brain-structure.js';
import {
  resumePath,
  inboxPath,
  askPath,
  gapPath,
  refreshPath,
  focusPath,
  formatResumeBrief,
  classificationTemplate,
  readLastSeenBuiltAt,
  writeLastSeenBuiltAt,
} from '../brain-workflows.js';

export const BRAIN_ENDPOINT = '/api/brain';
export const BRAIN_PAGE_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 180;
const MAP_PROVIDER_BAND_LIMIT = 6;
const STRUCTURE_WIDTH = 980;
const STRUCTURE_HEIGHT = STRUCTURE_WIDTH;
const STRUCTURE_WIDE_MIN_WIDTH = 1324;
const STRUCTURE_ZOOM_MIN = 70;
const STRUCTURE_ZOOM_MAX = 140;
const STRUCTURE_ZOOM_STEP = 10;
const STRUCTURE_ZOOM_DEFAULT = 100;
const STRUCTURE_GRAPH_ENDPOINT = '/api/graph';
const STRUCTURE_GEOMETRY_ENTER_MS = 300;
const STRUCTURE_NODE_REVEAL_MS = 180;
const STRUCTURE_NODE_EXIT_MS = 140;
const STRUCTURE_ROUTE_ENTER_MS = 240;
const STRUCTURE_ROUTE_EXIT_MS = 140;
const STRUCTURE_STAGGER_MS = 18;
const STRUCTURE_STAGGER_SLOTS = 5;
const MAP_PROVIDERS = Object.freeze(['claude', 'codex']);
const MAP_SEMANTIC_MIN = 3.5;
const MAP_SEMANTIC_MAX = 96.5;
const MAP_SEMANTIC_CLEARANCE = 4.4;
const MAP_PROVIDER_ROOTS = Object.freeze({
  claude: Object.freeze({ x: 25, y: 50, label: '.claude' }),
  codex: Object.freeze({ x: 75, y: 50, label: '.codex' }),
});

const CATEGORY_TYPE = Object.freeze({
  'โปรเจกต์': 'project',
  'บุคคล': 'person',
  'ไอเดีย': 'idea',
  'การตัดสินใจ': 'decision',
  'งาน': 'task',
  'โน้ต': 'note',
  'แหล่งข้อมูล': 'source',
});

const MAP_BANDS = Object.freeze([
  Object.freeze({ type: 'project', label: 'โปรเจกต์', code: 'โปร', radius: 14, phase: 0 }),
  Object.freeze({ type: 'person', label: 'บุคคล', code: 'คน', radius: 19.5, phase: 0.22 }),
  Object.freeze({ type: 'idea', label: 'ไอเดีย', code: 'คิด', radius: 25, phase: 0.44 }),
  Object.freeze({ type: 'decision', label: 'การตัดสินใจ', code: 'ตส', radius: 30.5, phase: 0.66 }),
  Object.freeze({ type: 'task', label: 'งาน', code: 'งาน', radius: 36, phase: 0.88 }),
  Object.freeze({ type: 'note', label: 'โน้ต', code: 'นต', radius: 41.5, phase: 1.1 }),
  Object.freeze({ type: 'source', label: 'แหล่งข้อมูล', code: 'ที่', radius: 47, phase: 1.32 }),
]);

const TYPE_LABEL_TH = Object.freeze({
  project: 'โปรเจกต์', person: 'บุคคล', idea: 'ไอเดีย', decision: 'การตัดสินใจ',
  task: 'งาน', note: 'โน้ต', source: 'แหล่งข้อมูล', item: 'รายการ',
});

const STATUS_LABEL_TH = Object.freeze({
  active: 'กำลังทำ', blocked: 'ติดขัด', next: 'ลำดับถัดไป', done: 'เสร็จแล้ว', unknown: 'ไม่ระบุ',
});

const MAP_BAND_BY_TYPE = new Map(MAP_BANDS.map((band) => [band.type, band]));

const TYPE_COUNT_KEY = Object.freeze({
  project: 'projects', person: 'people', idea: 'ideas', decision: 'decisions',
  task: 'tasks', note: 'notes', source: 'sources',
});

const SUMMARY_KEYS = Object.freeze([
  'items', 'projects', 'people', 'ideas', 'decisions',
  'tasks', 'notes', 'sources', 'needsAttention',
]);

const EVIDENCE_RANK = Object.freeze({
  'explicit-link': 0,
  declared: 1,
  'shared-project': 2,
});

function objectList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object')
    : [];
}

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function literalText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeLimit(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function compareNewest(left, right) {
  const byDate = safeNumber(right?.updatedAt) - safeNumber(left?.updatedAt);
  if (byDate) return byDate;
  return plainText(left?.id).localeCompare(plainText(right?.id));
}

function categoryType(category) {
  const normalized = plainText(category).toLocaleLowerCase();
  return Object.entries(CATEGORY_TYPE)
    .find(([label]) => label.toLocaleLowerCase() === normalized)?.[1] ?? '';
}

export function brainListPath({ query = '', category = 'ทั้งหมด', offset = 0 } = {}) {
  const params = new URLSearchParams();
  const boundedQuery = plainText(query).slice(0, 120);
  const type = categoryType(category);
  if (boundedQuery) params.set('q', boundedQuery);
  if (type) params.set('type', type);
  params.set('limit', String(BRAIN_PAGE_LIMIT));
  params.set('offset', String(Math.floor(safeNumber(offset))));
  return `${BRAIN_ENDPOINT}?${params.toString()}`;
}

export function brainFocusPath(id, depth = 1) {
  return focusPath(plainText(id), depth);
}

/** Return the complete summary shape, replacing invalid counts with zero. */
export function summaryCounts(payload) {
  const source = payload?.summary && typeof payload.summary === 'object'
    ? payload.summary
    : {};
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, safeNumber(source[key])]));
}

/** Search only the bounded fields supplied by the local index. */
export function searchItems(items, query) {
  const list = objectList(items);
  const needle = plainText(query).toLocaleLowerCase();
  if (!needle) return list.slice();
  return list.filter((item) => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return [item.title, item.summary, item.project, ...tags]
      .some((value) => plainText(value).toLocaleLowerCase().includes(needle));
  });
}

/** Filter with the labels shown to people, while accepting All as no filter. */
export function filterItemsByCategory(items, category = 'ทั้งหมด') {
  const list = objectList(items);
  const match = categoryType(category);
  return match ? list.filter((item) => plainText(item.type).toLocaleLowerCase() === match) : list.slice();
}

/** Most recently updated active project or task, or null. */
export function selectContinueItem(items) {
  return objectList(items)
    .filter((item) => ['project', 'task'].includes(plainText(item.type).toLocaleLowerCase())
      && plainText(item.status).toLocaleLowerCase() === 'active')
    .sort(compareNewest)[0] ?? null;
}

export function recentDecisions(items, limit = 3) {
  const count = safeLimit(limit, 3);
  return objectList(items)
    .filter((item) => plainText(item.type).toLocaleLowerCase() === 'decision')
    .sort(compareNewest)
    .slice(0, count);
}

/** Blocked work is more urgent than explicitly queued next work. */
export function needsAttention(items, limit = 3) {
  const count = safeLimit(limit, 3);
  const statusRank = { blocked: 0, next: 1 };
  return objectList(items)
    .filter((item) => Object.hasOwn(statusRank, plainText(item.status).toLocaleLowerCase()))
    .sort((left, right) => {
      const byStatus = statusRank[plainText(left.status).toLocaleLowerCase()]
        - statusRank[plainText(right.status).toLocaleLowerCase()];
      return byStatus || compareNewest(left, right);
    })
    .slice(0, count);
}

function compareRelations(left, right) {
  const byEvidence = (EVIDENCE_RANK[left.evidence] ?? 9) - (EVIDENCE_RANK[right.evidence] ?? 9);
  if (byEvidence) return byEvidence;
  const byConfidence = safeNumber(right.confidence) - safeNumber(left.confidence);
  if (byConfidence) return byConfidence;
  return plainText(left.id).localeCompare(plainText(right.id));
}

/**
 * Build the bounded relationship trail. Unlabeled relations are omitted rather
 * than assigned invented copy, and each side is capped independently.
 */
export function focusedRelations(items, relations, selectedId, limit = 6) {
  const id = plainText(selectedId);
  if (!id) return { incoming: [], outgoing: [] };
  const count = Math.min(6, safeLimit(limit, 6));
  const byId = new Map(objectList(items)
    .filter((item) => plainText(item.id))
    .map((item) => [plainText(item.id), item]));
  const labeled = objectList(relations).filter((relation) => plainText(relation.label));
  const project = (relation, direction) => {
    const relatedId = direction === 'incoming' ? plainText(relation.from) : plainText(relation.to);
    return {
      ...relation,
      label: plainText(relation.label),
      direction,
      relatedId,
      relatedItem: byId.get(relatedId) ?? null,
    };
  };
  return {
    incoming: labeled.filter((relation) => plainText(relation.to) === id)
      .sort(compareRelations).slice(0, count).map((relation) => project(relation, 'incoming')),
    outgoing: labeled.filter((relation) => plainText(relation.from) === id)
      .sort(compareRelations).slice(0, count).map((relation) => project(relation, 'outgoing')),
  };
}

/**
 * Preserve the established direct rows, then expose only API-supplied edges
 * from one of those visible first-hop endpoints to a new second-hop endpoint.
 * Relation and endpoint order remains the payload order.
 */
export function semanticFocusLayers(items, relations, selectedId, depth = 1) {
  const id = plainText(selectedId);
  const list = objectList(items);
  const direct = focusedRelations(list, relations, id);
  if (depth !== 2 || !id) return { direct, secondHop: [] };
  const byId = new Map(list.map((item) => [plainText(item.id), item]).filter(([itemId]) => itemId));
  const firstHopIds = new Set([...direct.incoming, ...direct.outgoing]
    .map((row) => plainText(row.relatedId)).filter(Boolean));
  const admittedSecondHopIds = new Set();
  const seenEdges = new Set();
  const secondHop = [];
  for (const relation of objectList(relations)) {
    const from = plainText(relation.from);
    const to = plainText(relation.to);
    const label = plainText(relation.label);
    let parentId = '';
    let relatedId = '';
    let direction = '';
    if (firstHopIds.has(from) && to !== id && !firstHopIds.has(to)) {
      parentId = from; relatedId = to; direction = 'outgoing';
    } else if (firstHopIds.has(to) && from !== id && !firstHopIds.has(from)) {
      parentId = to; relatedId = from; direction = 'incoming';
    }
    if (!parentId || !relatedId || !label || !byId.has(parentId) || !byId.has(relatedId)) continue;
    if (!admittedSecondHopIds.has(relatedId) && admittedSecondHopIds.size >= SEMANTIC_LIMIT) continue;
    const edgeId = plainText(relation.id) || `${from}->${to}:${label}`;
    if (seenEdges.has(edgeId)) continue;
    seenEdges.add(edgeId);
    admittedSecondHopIds.add(relatedId);
    secondHop.push({
      ...relation,
      label,
      direction,
      parentId,
      parentItem: byId.get(parentId),
      relatedId,
      relatedItem: byId.get(relatedId),
      orbitLayer: 'second-hop',
    });
  }
  return { direct, secondHop };
}

/** Place unique semantic second-hop endpoints beyond their visible parent. */
export function mapSemanticSecondHopPositions(rows, firstHopPositions) {
  const positions = firstHopPositions instanceof Map ? firstHopPositions : new Map();
  const occupied = [...positions.entries()]
    .filter(([, point]) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(([id, point]) => ({ id, point, kind: 'base' }));
  const output = new Map();
  const siblingIndexByParent = new Map();
  for (const row of Array.from(rows ?? [])) {
    const relatedId = plainText(row?.relatedId);
    const parentId = plainText(row?.parentId);
    const parent = positions.get(parentId);
    if (!relatedId || !parentId || !parent || output.has(relatedId)) continue;
    const dx = parent.x - 50;
    const dy = parent.y - 50;
    const parentAngle = Math.hypot(dx, dy) > .1 ? Math.atan2(dy, dx) : -Math.PI / 2;
    const parentRadius = Math.hypot(dx, dy);
    const siblingIndex = siblingIndexByParent.get(parentId) ?? 0;
    siblingIndexByParent.set(parentId, siblingIndex + 1);
    const desiredRadius = Math.min(64, parentRadius + 8);
    const desiredAngle = parentAngle + ((siblingIndex % 7) - 3) * .1;
    const desired = {
      x: 50 + Math.cos(desiredAngle) * desiredRadius,
      y: 50 + Math.sin(desiredAngle) * desiredRadius,
    };
    const placement = chooseMapSemanticPoint(
      mapSemanticCandidates(desired, row.relatedItem?.source?.provider, {
        minCenterRadius: Math.min(64, parentRadius + 4.6),
      }),
      occupied,
      new Set(positions.keys()),
      false,
    );
    if (!placement) continue;
    const point = { ...placement.point, parentId, row, orbitLayer: 'second-hop' };
    occupied.push({ id: relatedId, point, kind: 'semantic' });
    output.set(relatedId, point);
  }
  return output;
}

function clampMapSemanticCoordinate(value) {
  return Math.min(MAP_SEMANTIC_MAX, Math.max(MAP_SEMANTIC_MIN, value));
}

function mapSemanticCandidates(desired, providerValue, {
  minCenterRadius = 0,
  maxCenterRadius = Number.POSITIVE_INFINITY,
} = {}) {
  const provider = plainText(providerValue).toLocaleLowerCase();
  const target = {
    x: clampMapSemanticCoordinate(Number(desired?.x) || 50),
    y: clampMapSemanticCoordinate(Number(desired?.y) || 50),
  };
  const candidates = [];
  const seen = new Set();
  const add = (x, y) => {
    const point = { x: clampMapSemanticCoordinate(x), y: clampMapSemanticCoordinate(y) };
    const centerRadius = Math.hypot(point.x - 50, point.y - 50);
    if (centerRadius < minCenterRadius || centerRadius > maxCenterRadius) return;
    const key = `${point.x.toFixed(3)}:${point.y.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(point);
  };
  add(target.x, target.y);
  for (let ring = 1; ring <= 10; ring += 1) {
    const radius = ring * 4.8;
    const slots = Math.max(12, ring * 12);
    for (let slot = 0; slot < slots; slot += 1) {
      const angle = (slot * Math.PI * 2 / slots) - Math.PI / 2;
      add(target.x + Math.cos(angle) * radius, target.y + Math.sin(angle) * radius);
    }
  }
  const global = [];
  let row = 0;
  for (let y = MAP_SEMANTIC_MIN; y <= MAP_SEMANTIC_MAX; y += 4.8) {
    const offset = row % 2 ? 2.4 : 0;
    for (let x = MAP_SEMANTIC_MIN + offset; x <= MAP_SEMANTIC_MAX; x += 4.8) {
      const point = { x, y };
      const centerRadius = Math.hypot(x - 50, y - 50);
      if (centerRadius < minCenterRadius || centerRadius > maxCenterRadius) continue;
      const providerPenalty = provider === 'claude'
        ? Math.max(0, x - 50) * 1.4
        : provider === 'codex' ? Math.max(0, 50 - x) * 1.4 : 0;
      global.push({
        point,
        score: Math.hypot(x - target.x, y - target.y) + providerPenalty,
      });
    }
    row += 1;
  }
  global.sort((left, right) => left.score - right.score
    || left.point.y - right.point.y || left.point.x - right.point.x);
  global.forEach(({ point }) => add(point.x, point.y));
  return candidates;
}

function chooseMapSemanticPoint(candidates, occupied, protectedBaseIds, allowReservation = true) {
  let reservation = null;
  for (const candidate of candidates) {
    const conflicts = occupied.filter((entry) => (
      Math.hypot(candidate.x - entry.point.x, candidate.y - entry.point.y) < MAP_SEMANTIC_CLEARANCE
    ));
    if (!conflicts.length) return { point: candidate, shadowBaseIds: [] };
    if (!allowReservation || conflicts.some((entry) => (
      entry.kind !== 'base' || protectedBaseIds.has(entry.id)
    ))) continue;
    if (!reservation || conflicts.length < reservation.conflicts.length) {
      reservation = { point: candidate, conflicts };
      if (conflicts.length === 1) break;
    }
  }
  if (!reservation) return null;
  const conflictSet = new Set(reservation.conflicts);
  for (let index = occupied.length - 1; index >= 0; index -= 1) {
    if (conflictSet.has(occupied[index])) occupied.splice(index, 1);
  }
  return {
    point: reservation.point,
    shadowBaseIds: reservation.conflicts.map((entry) => entry.id),
  };
}

/** Ensure every direct semantic endpoint has a stable map anchor before layer 2. */
export function mapSemanticLayerPositions(layers, selectedId, basePositions) {
  const base = basePositions instanceof Map ? basePositions : new Map();
  const selectedKey = plainText(selectedId);
  const selectedPosition = base.get(selectedKey) ?? { x: 50, y: 50 };
  const occupied = [...base.entries()]
    .filter(([, point]) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(([id, point]) => ({ id, point, kind: 'base' }));
  const firstHop = new Map();
  const shadowBaseIds = new Set();
  const directRows = [...(layers?.direct?.incoming ?? []), ...(layers?.direct?.outgoing ?? [])];
  const protectedBaseIds = new Set([selectedKey]);
  directRows.forEach((row) => {
    const id = plainText(row?.relatedId);
    if (id && base.has(id)) protectedBaseIds.add(id);
  });
  directRows.forEach((row, index) => {
    const id = plainText(row?.relatedId);
    if (!id || firstHop.has(id)) return;
    const existing = base.get(id);
    if (existing) {
      firstHop.set(id, { position: existing, row, reusedBase: true, orbitLayer: 'first-hop' });
      return;
    }
    const angle = (index * Math.PI * 2 / Math.max(12, directRows.length)) - Math.PI / 2;
    const desired = {
      x: selectedPosition.x + Math.cos(angle) * 11,
      y: selectedPosition.y + Math.sin(angle) * 11,
    };
    const placement = chooseMapSemanticPoint(
      mapSemanticCandidates(desired, row.relatedItem?.source?.provider, { maxCenterRadius: 50 }),
      occupied,
      protectedBaseIds,
    );
    if (!placement) return;
    placement.shadowBaseIds.forEach((shadowId) => shadowBaseIds.add(shadowId));
    const position = placement.point;
    occupied.push({ id, point: position, kind: 'semantic' });
    firstHop.set(id, { position, row, reusedBase: false, orbitLayer: 'first-hop' });
  });
  const secondHopRows = Array.from(layers?.secondHop ?? []);
  secondHopRows.forEach((row) => {
    const id = plainText(row?.relatedId);
    if (!id || protectedBaseIds.has(id) || !base.has(id)) return;
    shadowBaseIds.add(id);
    for (let index = occupied.length - 1; index >= 0; index -= 1) {
      if (occupied[index].kind === 'base' && occupied[index].id === id) occupied.splice(index, 1);
    }
  });
  const parentPositions = new Map([...base].filter(([id]) => !shadowBaseIds.has(id)));
  firstHop.forEach((entry, id) => parentPositions.set(id, entry.position));
  const secondHop = new Map();
  const siblingIndexByParent = new Map();
  for (const row of secondHopRows) {
    const relatedId = plainText(row?.relatedId);
    const parentId = plainText(row?.parentId);
    const parent = parentPositions.get(parentId);
    if (!relatedId || !parentId || !parent || secondHop.has(relatedId)) continue;
    const dx = parent.x - 50;
    const dy = parent.y - 50;
    const parentRadius = Math.hypot(dx, dy);
    const parentAngle = parentRadius > .1 ? Math.atan2(dy, dx) : -Math.PI / 2;
    const siblingIndex = siblingIndexByParent.get(parentId) ?? 0;
    siblingIndexByParent.set(parentId, siblingIndex + 1);
    const desiredRadius = Math.min(64, parentRadius + 8);
    const desiredAngle = parentAngle + ((siblingIndex % 7) - 3) * .1;
    const placement = chooseMapSemanticPoint(
      mapSemanticCandidates({
        x: 50 + Math.cos(desiredAngle) * desiredRadius,
        y: 50 + Math.sin(desiredAngle) * desiredRadius,
      }, row.relatedItem?.source?.provider, {
        minCenterRadius: Math.min(64, parentRadius + 4.6),
      }),
      occupied,
      protectedBaseIds,
    );
    if (!placement) continue;
    placement.shadowBaseIds.forEach((shadowId) => shadowBaseIds.add(shadowId));
    const point = { ...placement.point, parentId, row, orbitLayer: 'second-hop' };
    occupied.push({ id: relatedId, point, kind: 'semantic' });
    secondHop.set(relatedId, point);
  }
  return { selectedPosition, firstHop, secondHop, shadowBaseIds };
}

/** Capture a clicked semantic position, or reconstruct one deterministically. */
export function stableSemanticAnchorPosition(id, hint, origin, bounds = {}) {
  const hintedX = Number(hint?.x);
  const hintedY = Number(hint?.y);
  if (Number.isFinite(hintedX) && Number.isFinite(hintedY)) return { x: hintedX, y: hintedY };
  const width = Math.max(1, Number(bounds.width) || STRUCTURE_WIDTH);
  const height = Math.max(1, Number(bounds.height) || STRUCTURE_HEIGHT);
  const center = {
    x: Number.isFinite(Number(origin?.x)) ? Number(origin.x) : width / 2,
    y: Number.isFinite(Number(origin?.y)) ? Number(origin.y) : height / 2,
  };
  const hash = [...plainText(id)].reduce((value, character) => ((value * 33) + character.codePointAt(0)) >>> 0, 5381);
  const angle = ((hash % 360) * Math.PI / 180) - Math.PI / 2;
  const radius = 112;
  return {
    x: Math.min(width - 20, Math.max(20, center.x + Math.cos(angle) * radius)),
    y: Math.min(height - 20, Math.max(20, center.y + Math.sin(angle) * radius)),
  };
}

/** Reserve one rendered structure slot for a selected synthetic focus anchor. */
export function reserveStructureSemanticAnchorSlot(projection, {
  selectedAnchor = null,
  structureFocusId = '',
  visibleLimit = VISIBLE_NODE_LIMIT,
} = {}) {
  const source = projection && typeof projection === 'object' ? projection : {};
  const nodes = objectList(source.nodes);
  const idList = (value) => Array.isArray(value) ? value : [];
  const limit = Math.max(1, safeNumber(visibleLimit) || VISIBLE_NODE_LIMIT);
  if (!selectedAnchor || nodes.length < limit) {
    return { projection: source, suppressedNodeId: '', shadowedNodeId: '' };
  }
  const focusId = plainText(structureFocusId);
  const protectedIds = new Set(['knowledge-core', 'claude', 'codex', focusId]);
  idList(source.ancestorIds).forEach((id) => protectedIds.add(plainText(id)));
  idList(source.expandedIds).forEach((id) => protectedIds.add(plainText(id)));
  for (const ids of Object.values(source.pathIdsByProvider ?? {})) {
    idList(ids).forEach((id) => protectedIds.add(plainText(id)));
  }
  const visibleChildren = new Set(objectList(source.edges).map((edge) => plainText(edge.source)).filter(Boolean));
  visibleChildren.forEach((id) => protectedIds.add(id));
  nodes.forEach((node) => {
    if (node?.orbitLayer === 'path') protectedIds.add(plainText(node.id));
  });
  const priority = (node) => {
    if (node?.orbitLayer === 'second-hop') return 0;
    if (node?.synthetic === true || node?.kind === 'more') return 1;
    return 2;
  };
  const candidates = nodes.filter((node) => {
    const id = plainText(node?.id);
    return id && !protectedIds.has(id)
      && node?.orbitLayer !== 'core' && node?.orbitLayer !== 'provider'
      && node?.orbitLayer !== 'path';
  }).sort((left, right) => priority(left) - priority(right)
    || safeNumber(right?.layerDepth) - safeNumber(left?.layerDepth)
    || plainText(left?.provider).localeCompare(plainText(right?.provider), 'th')
    || plainText(left?.id).localeCompare(plainText(right?.id), 'th'));
  const suppressedNodeId = plainText(candidates[0]?.id);
  if (!suppressedNodeId) {
    const shadowCandidates = nodes.filter((node) => !['knowledge-core', 'claude', 'codex'].includes(plainText(node?.id)))
      .sort((left, right) => {
        const leftId = plainText(left?.id);
        const rightId = plainText(right?.id);
        if (leftId === focusId) return -1;
        if (rightId === focusId) return 1;
        const leftPosition = source.positions instanceof Map ? source.positions.get(leftId) : left;
        const rightPosition = source.positions instanceof Map ? source.positions.get(rightId) : right;
        const leftDistance = Math.hypot(
          safeNumber(leftPosition?.x) - safeNumber(selectedAnchor?.x),
          safeNumber(leftPosition?.y) - safeNumber(selectedAnchor?.y),
        );
        const rightDistance = Math.hypot(
          safeNumber(rightPosition?.x) - safeNumber(selectedAnchor?.x),
          safeNumber(rightPosition?.y) - safeNumber(selectedAnchor?.y),
        );
        return leftDistance - rightDistance || leftId.localeCompare(rightId, 'th');
      });
    return {
      projection: source,
      suppressedNodeId: '',
      shadowedNodeId: plainText(shadowCandidates[0]?.id),
    };
  }
  const positions = source.positions instanceof Map
    ? new Map([...source.positions].filter(([id]) => id !== suppressedNodeId))
    : source.positions;
  const without = (values) => idList(values).filter((id) => plainText(id) !== suppressedNodeId);
  return {
    projection: {
      ...source,
      nodes: nodes.filter((node) => plainText(node?.id) !== suppressedNodeId),
      edges: objectList(source.edges).filter((edge) => (
        plainText(edge.source) !== suppressedNodeId && plainText(edge.target) !== suppressedNodeId
      )),
      positions,
      expandedIds: without(source.expandedIds),
      ancestorIds: without(source.ancestorIds),
      contextIds: without(source.contextIds),
      pageNodeIds: without(source.pageNodeIds),
    },
    suppressedNodeId,
    shadowedNodeId: '',
  };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function svgElement(doc, tag, className, attributes = {}) {
  const node = typeof doc.createElementNS === 'function'
    ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
    : doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  return setAttributes(node, attributes);
}

function setAttributes(node, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value != null) node.setAttribute(name, value);
  }
  return node;
}

function actionButton(doc, className, label, onClick) {
  const button = element(doc, 'button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function formatDate(value) {
  const timestamp = safeNumber(value);
  if (!timestamp) return 'ไม่มีข้อมูลวันที่';
  return new Intl.DateTimeFormat('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(timestamp));
}

function formatDateTime(value) {
  const timestamp = safeNumber(value);
  if (!timestamp) return 'ไม่มีข้อมูลเวลา';
  return new Intl.DateTimeFormat('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp));
}

function itemTitle(item, fallback = 'รายการไม่มีชื่อ') {
  return plainText(item?.title) || fallback;
}

function itemSummary(item) {
  return plainText(item?.summary) || 'รายการนี้ยังไม่มีสรุป';
}

function thaiType(value) {
  const type = plainText(value).toLocaleLowerCase();
  return TYPE_LABEL_TH[type] ?? TYPE_LABEL_TH.item;
}

function thaiStatus(value) {
  const status = plainText(value).toLocaleLowerCase();
  return STATUS_LABEL_TH[status] ?? STATUS_LABEL_TH.unknown;
}

function thaiRelation(row) {
  const type = plainText(row?.type).toLocaleLowerCase();
  if (type === 'belongs-to') return 'อยู่ในแหล่งข้อมูล';
  if (type === 'mentions') return 'กล่าวถึง';
  if (type === 'related-to') return 'เกี่ยวข้องกัน';
  return 'เชื่อมโยงกัน';
}

function mapItemPositions(items) {
  const bounded = objectList(items).slice(0, BRAIN_PAGE_LIMIT);
  const positions = new Map();
  for (const band of MAP_BANDS) {
    for (const provider of MAP_PROVIDERS) {
      const members = bounded
        .filter((item) => plainText(item.type).toLocaleLowerCase() === band.type
          && plainText(item.source?.provider).toLocaleLowerCase() === provider)
        .slice(0, MAP_PROVIDER_BAND_LIMIT);
      const start = provider === 'claude' ? Math.PI * .62 : -Math.PI * .38;
      const end = provider === 'claude' ? Math.PI * 1.38 : Math.PI * .38;
      members.forEach((item, index) => {
        const ratio = members.length === 1 ? .5 : index / (members.length - 1);
        const angle = start + ((end - start) * ratio) + ((band.phase % .3) * .08);
        positions.set(plainText(item.id), {
          x: 50 + (Math.cos(angle) * band.radius),
          y: 50 + (Math.sin(angle) * band.radius),
          band,
          provider,
        });
      });
    }
  }
  return positions;
}

function svgPointList(points) {
  return objectList(points)
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
}

function compactPolyline(points, epsilon = .01) {
  const compacted = [];
  for (const point of objectList(points)) {
    const previous = compacted[compacted.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > epsilon) compacted.push(point);
  }
  return compacted;
}

// Structure ownership is a radial hierarchy, not a rectangular tree. Routes
// leave the parent on its radial side, travel a short orbital elbow, then meet
// the child on its inward radial side. The SVG remains a simple polyline.
function radialStructurePolyline({ source, target, center }) {
  const cx = safeNumber(center?.x);
  const cy = safeNumber(center?.y);
  const sourceDx = source.x - cx; const sourceDy = source.y - cy;
  const targetDx = target.x - cx; const targetDy = target.y - cy;
  const sourceDistance = Math.hypot(sourceDx, sourceDy);
  const targetDistance = Math.hypot(targetDx, targetDy);
  const targetAngle = targetDistance > 1 ? Math.atan2(targetDy, targetDx) : 0;
  const sourceAngle = sourceDistance > 1 ? Math.atan2(sourceDy, sourceDx) : targetAngle;
  const direction = targetDistance >= sourceDistance ? 1 : -1;
  const sourcePortRadius = Math.max(0, sourceDistance + direction * safeNumber(source.r));
  const targetPortRadius = Math.max(0, targetDistance - direction * safeNumber(target.r));
  const orbitRadius = (sourcePortRadius + targetPortRadius) / 2;
  const at = (angle, distance) => ({ x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance });
  return compactPolyline([
    at(sourceAngle, sourcePortRadius),
    at(sourceAngle, orbitRadius),
    at(targetAngle, orbitRadius),
    at(targetAngle, targetPortRadius),
  ]);
}

function makePageHeader(doc) {
  const header = element(doc, 'header', 'brain-header');
  const mark = element(doc, 'div', 'brain-wordmark');
  mark.append(
    element(doc, 'span', 'brain-wordmark-owner', 'BIGNOSE'),
    element(doc, 'span', 'brain-wordmark-view', 'สมองที่สอง'),
  );
  const promise = element(doc, 'h1', 'brain-promise', 'ค้นหาสิ่งที่เคยรู้ แล้วทำสิ่งสำคัญต่อ');
  const trust = element(doc, 'p', 'brain-trust', 'ความรู้ส่วนตัวแบบอ่านอย่างเดียวจากโน้ตในเครื่องที่อนุญาต');
  const back = element(doc, 'a', 'btn brain-back brain-mobile-back', 'กลับหน้า BIGNOSE OS');
  back.setAttribute('href', '#');
  header.append(mark, promise, trust, back);
  return header;
}

function makeState(doc, kind, title, body, action) {
  const page = element(doc, 'main', `brain-workspace brain-workspace-${kind}`);
  page.append(makePageHeader(doc));
  const state = element(doc, 'section', `brain-state brain-state-${kind}`);
  setAttributes(state, { role: 'status', 'aria-live': 'polite' });
  state.append(
    element(doc, 'p', 'brain-state-label', kind === 'loading' ? 'กำลังอ่านโน้ตในเครื่อง' : 'สถานะระบบ'),
    element(doc, 'h2', 'brain-state-title', title),
    element(doc, 'p', 'brain-state-body', body),
  );
  if (action) state.append(action);
  page.append(state);
  return page;
}

function compactItem(doc, heading, item, onSelect, emptyCopy, onResume) {
  const section = element(doc, 'section', 'brain-today-cell');
  section.append(element(doc, 'h3', 'brain-section-label', heading));
  if (!item) {
    section.append(element(doc, 'p', 'brain-quiet-copy', emptyCopy));
    return section;
  }
  const button = actionButton(doc, 'brain-compact-item', itemTitle(item), () => onSelect(item.id));
  button.setAttribute('data-open-item', item.id);
  button.append(
    element(doc, 'span', 'brain-compact-summary', itemSummary(item)),
    element(doc, 'span', 'brain-item-meta', `${thaiType(item.type)} · ${formatDate(item.updatedAt)}`),
  );
  section.append(button);
  if (typeof onResume === 'function') {
    section.append(actionButton(doc, 'brain-resume-trigger', 'ทำงานต่อจากตรงนี้', () => onResume(item.id)));
  }
  return section;
}

function compactList(doc, heading, items, onSelect, emptyCopy) {
  const section = element(doc, 'section', 'brain-today-cell');
  section.append(element(doc, 'h3', 'brain-section-label', heading));
  if (!items.length) {
    section.append(element(doc, 'p', 'brain-quiet-copy', emptyCopy));
    return section;
  }
  const list = element(doc, 'div', 'brain-compact-list');
  for (const item of items) {
    const button = actionButton(doc, 'brain-compact-row', itemTitle(item), () => onSelect(item.id));
    button.setAttribute('data-open-item', item.id);
    button.append(element(doc, 'span', 'brain-compact-status', plainText(item.status)
      ? thaiStatus(item.status)
      : thaiType(item.type)));
    list.append(button);
  }
  section.append(list);
  return section;
}

function makeRelationColumn(doc, heading, rows, onSelect) {
  const column = element(doc, 'section', 'brain-trail-side');
  column.append(element(doc, 'h4', 'brain-trail-direction', heading));
  if (!rows.length) {
    column.append(element(doc, 'p', 'brain-trail-empty', 'ไม่มีความเชื่อมโยงในทิศทางนี้'));
    return column;
  }
  for (const row of rows) {
    const relatedTitle = itemTitle(row.relatedItem, plainText(row.relatedId) || 'รายการที่เกี่ยวข้อง');
    const container = row.relatedItem
      ? actionButton(doc, 'brain-relation-row', '', () => onSelect(row.relatedItem.id))
      : element(doc, 'div', 'brain-relation-row');
    container.setAttribute('data-direction', row.direction);
    container.append(
      element(doc, 'span', 'brain-relation-direction', row.direction === 'incoming' ? 'เชื่อมเข้ารายการนี้' : 'เชื่อมออกจากรายการนี้'),
      element(doc, 'span', 'brain-relation-item', relatedTitle),
      element(doc, 'span', 'brain-relation-label', thaiRelation(row)),
    );
    column.append(container);
  }
  return column;
}

function makeDetails(doc, selected, items, relations, onSelect, onResume) {
  const details = element(doc, 'aside', 'brain-details');
  setAttributes(details, { 'aria-label': 'รายละเอียดรายการ', 'aria-live': 'polite' });
  if (!selected) {
    details.append(
      element(doc, 'p', 'brain-section-label', 'รายละเอียด'),
      element(doc, 'h2', 'brain-empty-title', 'เลือกรายการ'),
      element(doc, 'p', 'brain-quiet-copy', 'เลือกรายการเพื่อดูแหล่งที่มาและความเชื่อมโยง'),
    );
    return details;
  }

  const header = element(doc, 'header', 'brain-details-header');
  const title = element(doc, 'h2', 'brain-detail-title', itemTitle(selected));
  title.setAttribute('tabindex', '-1');
  header.append(
    element(doc, 'p', 'brain-detail-kicker', `${thaiType(selected.type)} · ${thaiStatus(selected.status)}`),
    title,
    element(doc, 'p', 'brain-detail-summary', itemSummary(selected)),
  );
  if (plainText(selected.project)) header.append(element(doc, 'p', 'brain-detail-project', `อยู่ใน ${selected.project}`));

  const tags = Array.isArray(selected.tags) ? selected.tags.filter((tag) => plainText(tag)) : [];
  if (tags.length) {
    const tagList = element(doc, 'div', 'brain-tags');
    tags.forEach((tag) => tagList.append(element(doc, 'span', 'brain-tag', plainText(tag))));
    header.append(tagList);
  }

  const source = element(doc, 'section', 'brain-source');
  source.append(
    element(doc, 'h3', 'brain-section-label', 'แหล่งที่มา'),
    element(doc, 'p', `brain-provider brain-provider-${plainText(selected.source?.provider).toLocaleLowerCase()}`, `.${plainText(selected.source?.provider) || 'ไม่ทราบ'}`),
    element(doc, 'code', 'brain-source-path', plainText(selected.source?.path) || 'ไม่มีพาธแหล่งที่มา'),
  );
  if (typeof onResume === 'function') {
    source.append(actionButton(doc, 'brain-resume-trigger brain-detail-resume', 'ทำงานต่อจากตรงนี้', () => onResume(selected.id)));
  }

  const focused = focusedRelations(items, relations, selected.id);
  const trail = element(doc, 'section', 'brain-trail');
  trail.append(
    element(doc, 'p', 'brain-section-label', 'เส้นทางความรู้'),
    element(doc, 'h3', 'brain-trail-title', 'รายการนี้เชื่อมโยงอย่างไร'),
  );
  const route = element(doc, 'div', 'brain-memory-trail');
  const focus = element(doc, 'article', 'brain-trail-focus');
  focus.append(
    element(doc, 'span', 'brain-trail-focus-label', 'ความรู้ที่เลือก'),
    element(doc, 'strong', 'brain-trail-focus-title', itemTitle(selected)),
  );
  route.append(
    makeRelationColumn(doc, 'เส้นทางที่เชื่อมเข้า', focused.incoming, onSelect),
    focus,
    makeRelationColumn(doc, 'เส้นทางที่เชื่อมออก', focused.outgoing, onSelect),
  );
  trail.append(route);
  details.append(header, source, trail);
  return details;
}

/** Mount the local knowledge workspace. */
export function mountBrain(rootEl, deps = {}) {
  if (!rootEl || typeof rootEl.replaceChildren !== 'function') {
    throw new TypeError('mountBrain requires a root element');
  }
  const doc = deps.document ?? rootEl.ownerDocument ?? globalThis.document;
  const fetchApi = deps.fetchApi ?? fetchLocalApi;
  const setTimer = deps.setTimer ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  let clipboard = null;
  let storage = null;
  try { clipboard = deps.clipboard ?? globalThis.navigator?.clipboard ?? null; } catch { clipboard = null; }
  try { storage = deps.storage ?? globalThis.localStorage ?? null; } catch { storage = null; }
  let destroyed = false;
  let category = 'ทั้งหมด';
  let query = '';
  let offset = 0;
  let selectedId = '';
  let viewMode = 'map';
  let drawerOpen = false;
  let listPayload = null;
  let listItems = [];
  let mapPayload = null;
  let mapItems = [];
  let focusPayload = null;
  let mapPositions = new Map();
  let page = { total: 0, offset: 0, limit: BRAIN_PAGE_LIMIT, hasMore: false };
  let refs = null;
  let listRequestId = 0;
  let focusRequestId = 0;
  let mapRequestId = 0;
  let listController = null;
  let focusController = null;
  let focusRequestKind = 'idle';
  let mapController = null;
  let searchTimer = null;
  let structurePayload = null;
  let structureIndex = null;
  let structureProjection = null;
  let structureFocusId = '';
  let structurePageByParent = new Map();
  let structureExpandedProviders = new Set(['claude', 'codex']);
  let structureExpandedPathByProvider = new Map(MAP_PROVIDERS.map((provider) => [provider, []]));
  let structureController = null;
  let structureRequestId = 0;
  let structureReady = false;
  let structureSemanticItems = [];
  let structureSemanticAnchor = null;
  let structureSuppressedNodeId = '';
  let structureUnderlayShadowId = '';
  let structureFocusState = 'idle';
  let structureKeydownTarget = null;
  let structureResizeObserver = null;
  let structureAvailableWidth = STRUCTURE_WIDTH;
  let structureZoomPercent = STRUCTURE_ZOOM_DEFAULT;
  let structureHasRendered = false;
  let structurePointerScrollSnapshot = null;
  let structurePointerClickSnapshot = null;
  let structureKeyboardScrollSnapshot = null;
  let structureActionScrollSnapshot = null;
  let structurePointerCleanupTimer = null;
  let structurePointerListenersAttached = false;
  let structureFocusGeneration = 0;
  let focusDepth = 1;
  let activeDeckTab = 'resume';
  let resumeItemId = '';
  let resumePayload = null;
  let inboxPayload = null;
  let askPayload = null;
  let gapPayload = null;
  let resumeController = null;
  let inboxController = null;
  let askController = null;
  let gapController = null;
  let refreshController = null;
  let resumeRequestId = 0;
  let inboxRequestId = 0;
  let askRequestId = 0;
  let gapRequestId = 0;
  let refreshRequestId = 0;
  const dismissedGapIds = new Set();
  let structureGeometry = {
    mode: 'stacked',
    width: STRUCTURE_WIDTH,
    height: STRUCTURE_HEIGHT,
  };

  function makeController() {
    return typeof AbortController === 'function' ? new AbortController() : null;
  }

  async function fetchPayload(path, controller, { method = 'GET' } = {}) {
    const response = await fetchApi(path, {
      method,
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (!response?.ok || typeof response.json !== 'function') throw new Error('brain response unavailable');
    const nextPayload = await response.json();
    if (!nextPayload || typeof nextPayload !== 'object' || nextPayload.unavailable) {
      throw new Error('brain response unavailable');
    }
    return nextPayload;
  }

  function sourceCitation(record) {
    const citation = record?.citation && typeof record.citation === 'object'
      ? record.citation
      : record?.source && typeof record.source === 'object' ? record.source : record;
    return {
      provider: plainText(citation?.provider),
      path: literalText(citation?.path),
      title: plainText(citation?.title),
    };
  }

  function uniqueSemanticEndpoints(rows) {
    const seen = new Set();
    return Array.from(rows ?? []).filter((row) => {
      const id = plainText(row?.relatedId);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function citationNode(citation, className = 'brain-workflow-citation') {
    const safe = sourceCitation(citation);
    const row = element(doc, 'div', className);
    row.append(
      element(doc, 'span', `brain-provider brain-provider-${safe.provider}`, safe.provider ? `.${safe.provider}` : '.ไม่ทราบ'),
      element(doc, 'code', 'brain-source-path', safe.path || 'ไม่มีพาธแหล่งที่มา'),
    );
    if (safe.title) row.append(element(doc, 'span', 'brain-workflow-citation-title', safe.title));
    return row;
  }

  async function copyWithButton(button, value, successLabel = 'คัดลอกแล้ว') {
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await clipboard.writeText(String(value ?? ''));
      if (destroyed || !button?.isConnected) return;
      button.textContent = successLabel;
    } catch {
      if (destroyed || !button?.isConnected) return;
      button.textContent = 'คัดลอกไม่สำเร็จ';
    }
    button?.setAttribute?.('aria-live', 'polite');
  }

  function workflowStatus(panel, title, body, kind = 'empty') {
    const state = element(doc, 'section', `brain-workflow-state brain-workflow-state-${kind}`);
    setAttributes(state, { role: 'status', 'aria-live': 'polite' });
    state.append(
      element(doc, 'h3', 'brain-workflow-title', title),
      element(doc, 'p', 'brain-quiet-copy', body),
    );
    panel.replaceChildren(state);
  }

  function moveDeckToCurrentMode() {
    if (!refs?.actionDeck) return;
    if (viewMode === 'map') refs.content.prepend(refs.actionDeck);
    else refs.today.after(refs.actionDeck);
  }

  function updateActionTab({ moveFocus = false } = {}) {
    if (!refs?.actionTabs) return;
    for (const [name, button] of refs.actionTabs) {
      const active = name === activeDeckTab;
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('tabindex', active ? '0' : '-1');
      const panel = refs.actionPanels.get(name);
      panel.hidden = !active;
      panel.setAttribute('tabindex', active ? '0' : '-1');
    }
    if (moveFocus) refs.actionTabs.get(activeDeckTab)?.focus?.();
  }

  function setActionTab(name, { moveFocus = false } = {}) {
    if (!refs?.actionTabs?.has(name)) return;
    activeDeckTab = name;
    updateActionTab({ moveFocus });
    if (name === 'inbox' && !inboxPayload && !inboxController) requestInbox();
    if (name === 'gaps' && !gapPayload && !gapController) requestGaps();
  }

  function renderResume() {
    if (!refs?.resumePanel) return;
    const panel = refs.resumePanel;
    if (!resumePayload?.selected) {
      workflowStatus(panel, 'เลือกงานเพื่อทำต่อ', 'เลือกงานที่ Today รายละเอียด หรือรางแผนที่ แล้วกด “ทำงานต่อจากตรงนี้”');
      return;
    }
    const selected = resumePayload.selected;
    const head = element(doc, 'header', 'brain-resume-head');
    head.append(
      element(doc, 'p', 'brain-section-label', `${thaiType(selected.type)} · ${thaiStatus(selected.status)}`),
      element(doc, 'h3', 'brain-workflow-title', itemTitle(selected)),
      element(doc, 'p', 'brain-workflow-summary', itemSummary(selected)),
    );
    const evidence = element(doc, 'div', 'brain-resume-evidence');
    const addItems = (heading, rows, emptyCopy) => {
      const group = element(doc, 'section', 'brain-workflow-group');
      group.append(element(doc, 'h4', 'brain-workflow-group-title', heading));
      if (!objectList(rows).length) group.append(element(doc, 'p', 'brain-quiet-copy', emptyCopy));
      objectList(rows).slice(0, 3).forEach((item) => group.append(
        element(doc, 'p', 'brain-workflow-row', `${itemTitle(item)} · ${thaiStatus(item.status)}`),
      ));
      evidence.append(group);
    };
    addItems('การตัดสินใจ', resumePayload.decisions, 'ยังไม่มีการตัดสินใจที่เกี่ยวข้อง');
    addItems('สิ่งที่ต้องใส่ใจ', resumePayload.attention, 'ยังไม่มีรายการติดขัดหรือลำดับถัดไป');
    const next = element(doc, 'section', 'brain-resume-next');
    next.append(
      element(doc, 'p', 'brain-section-label', 'งานถัดไป'),
      element(doc, 'strong', 'brain-workflow-row', resumePayload.nextAction ? itemTitle(resumePayload.nextAction) : 'ยังไม่มีงานถัดไป'),
    );
    const citations = element(doc, 'section', 'brain-workflow-group');
    citations.append(element(doc, 'h4', 'brain-workflow-group-title', 'หลักฐานที่ใช้ส่งต่อ'));
    objectList(resumePayload.citations).slice(0, 8).forEach((citation) => citations.append(citationNode(citation)));
    const beam = element(doc, 'div', 'brain-handoff-beam');
    const claudeCopy = actionButton(doc, 'brain-provider-copy brain-provider-copy-claude', 'คัดลอกให้ Claude', () => {
      copyWithButton(claudeCopy, formatResumeBrief(resumePayload, 'claude'));
    });
    const codexCopy = actionButton(doc, 'brain-provider-copy brain-provider-copy-codex', 'คัดลอกให้ Codex', () => {
      copyWithButton(codexCopy, formatResumeBrief(resumePayload, 'codex'));
    });
    beam.append(
      element(doc, 'span', 'brain-handoff-origin', 'ความรู้ที่เลือก'),
      claudeCopy,
      codexCopy,
    );
    panel.replaceChildren(head, evidence, next, citations, beam);
  }

  async function openResumeForItem(value) {
    const id = plainText(value);
    if (!id || destroyed || !refs) return;
    resumeItemId = id;
    setActionTab('resume');
    if (viewMode === 'map') setDrawerOpen(true);
    resumeController?.abort();
    resumeController = makeController();
    const requestId = ++resumeRequestId;
    workflowStatus(refs.resumePanel, 'กำลังสร้าง Resume Pack', 'กำลังรวบรวมบริบทและพาธอ้างอิงแบบจำกัด', 'loading');
    try {
      const payload = await fetchPayload(resumePath(id), resumeController);
      if (destroyed || requestId !== resumeRequestId || resumeItemId !== id) return;
      if (!payload.selected) throw new Error('resume item unavailable');
      resumePayload = payload;
      renderResume();
    } catch {
      if (destroyed || requestId !== resumeRequestId || resumeItemId !== id) return;
      resumePayload = null;
      workflowStatus(refs.resumePanel, 'สร้าง Resume Pack ไม่ได้', 'เลือกรายการเดิมแล้วลองอีกครั้ง หลักฐานและโน้ตไม่ได้ถูกแก้ไข', 'unavailable');
    } finally {
      if (requestId === resumeRequestId) resumeController = null;
    }
  }

  function inboxGroup(heading, rows, kind) {
    const group = element(doc, 'section', 'brain-workflow-group');
    group.append(element(doc, 'h4', 'brain-workflow-group-title', `${heading} ${objectList(rows).length}`));
    if (!objectList(rows).length) {
      group.append(element(doc, 'p', 'brain-quiet-copy', 'ไม่มีรายการในกลุ่มนี้'));
      return group;
    }
    objectList(rows).slice(0, 12).forEach((item) => {
      const row = element(doc, 'article', 'brain-inbox-row');
      row.append(
        element(doc, 'strong', 'brain-workflow-row-title', itemTitle(item)),
        citationNode(item),
      );
      if (kind === 'unclassified') {
        const actions = element(doc, 'div', 'brain-workflow-actions');
        const pathCopy = actionButton(doc, 'brain-workflow-button', 'คัดลอกพาธ', () => {
          copyWithButton(pathCopy, sourceCitation(item).path);
        });
        const templateCopy = actionButton(doc, 'brain-workflow-button', 'คัดลอกแม่แบบ', () => {
          copyWithButton(templateCopy, classificationTemplate(item));
        });
        actions.append(pathCopy, templateCopy);
        row.append(actions);
      }
      group.append(row);
    });
    return group;
  }

  function renderInbox(localMessage = '') {
    if (!refs?.inboxPanel || !inboxPayload) return;
    const panel = refs.inboxPanel;
    const head = element(doc, 'header', 'brain-workflow-toolbar');
    const copy = element(doc, 'div');
    copy.append(
      element(doc, 'h3', 'brain-workflow-title', 'ความรู้ใหม่และสิ่งที่ควรจัดหมวด'),
      element(doc, 'p', 'brain-workflow-summary', `ดัชนีล่าสุด ${formatDateTime(inboxPayload.builtAt)} · ${safeNumber(inboxPayload.total)} รายการที่ควรดู`),
    );
    const actions = element(doc, 'div', 'brain-workflow-actions');
    const refresh = actionButton(doc, 'brain-workflow-button', 'รีเฟรชดัชนี', refreshInboxIndex);
    const reviewed = actionButton(doc, 'brain-workflow-button brain-workflow-button-primary', 'ตรวจแล้ว', markInboxReviewed);
    actions.append(refresh, reviewed);
    head.append(copy, actions);
    const status = element(doc, 'p', 'brain-workflow-status', localMessage);
    setAttributes(status, { role: 'status', 'aria-live': 'polite' });
    panel.replaceChildren(
      head,
      status,
      inboxGroup('รายการใหม่', inboxPayload.newItems, 'new'),
      inboxGroup('ยังไม่จัดหมวด', inboxPayload.unclassified, 'unclassified'),
      inboxGroup('คำสั่งที่เปลี่ยน', inboxPayload.changedInstructions, 'instructions'),
    );
  }

  async function requestInbox(since = readLastSeenBuiltAt(storage), localMessage = '') {
    if (destroyed || !refs) return;
    inboxController?.abort();
    inboxController = makeController();
    const requestId = ++inboxRequestId;
    if (!inboxPayload) workflowStatus(refs.inboxPanel, 'กำลังอ่านกล่องเข้า', 'กำลังเทียบดัชนีกับครั้งที่ตรวจล่าสุด', 'loading');
    try {
      const payload = await fetchPayload(inboxPath(since), inboxController);
      if (destroyed || requestId !== inboxRequestId) return;
      inboxPayload = payload;
      renderInbox(localMessage);
    } catch {
      if (destroyed || requestId !== inboxRequestId) return;
      if (inboxPayload) renderInbox('โหลดข้อมูลใหม่ไม่สำเร็จ รายการเดิมยังอยู่และไม่มีไฟล์ถูกแก้ไข');
      else workflowStatus(refs.inboxPanel, 'เปิดกล่องเข้าไม่ได้', 'ลองเปิดแท็บนี้อีกครั้ง ไม่มีไฟล์ต้นฉบับถูกแก้ไข', 'unavailable');
    } finally {
      if (requestId === inboxRequestId) inboxController = null;
    }
  }

  async function refreshInboxIndex() {
    if (destroyed || !refs) return;
    refreshController?.abort();
    refreshController = makeController();
    const requestId = ++refreshRequestId;
    renderInbox('กำลังรีเฟรชเฉพาะดัชนีในหน่วยความจำ…');
    try {
      const payload = await fetchPayload(refreshPath(), refreshController, { method: 'POST' });
      if (destroyed || requestId !== refreshRequestId) return;
      await requestInbox(readLastSeenBuiltAt(storage), `รีเฟรชดัชนีแล้ว ${formatDateTime(payload.builtAt)}`);
    } catch {
      if (destroyed || requestId !== refreshRequestId) return;
      renderInbox('รีเฟรชไม่สำเร็จ รายการเดิมยังอยู่และไม่มีไฟล์ถูกแก้ไข');
    } finally {
      if (requestId === refreshRequestId) refreshController = null;
    }
  }

  function markInboxReviewed() {
    if (!inboxPayload) return;
    const builtAt = safeNumber(inboxPayload.builtAt);
    const stored = writeLastSeenBuiltAt(storage, builtAt);
    requestInbox(builtAt, stored ? 'บันทึกว่าตรวจแล้ว' : 'ตรวจแล้วสำหรับครั้งนี้ แต่เบราว์เซอร์ไม่อนุญาตให้บันทึก');
  }

  function renderAsk() {
    if (!refs?.askResults || !askPayload) return;
    const result = refs.askResults;
    const answer = element(doc, 'section', 'brain-ask-answer');
    answer.append(
      element(doc, 'p', 'brain-section-label', 'คำตอบจากดัชนีในเครื่อง'),
      element(doc, 'p', 'brain-workflow-summary', literalText(askPayload.answer, 'ไม่พบคำตอบ')),
    );
    const list = element(doc, 'div', 'brain-ask-results');
    const rows = objectList(askPayload.results).slice(0, 8);
    if (!rows.length) list.append(element(doc, 'p', 'brain-quiet-copy', 'ไม่พบรายการที่ตรงกัน ลองใช้คำที่เฉพาะเจาะจงขึ้น'));
    rows.forEach((item) => {
      const button = actionButton(doc, 'brain-ask-result', '', () => selectItem(item.id));
      button.append(
        element(doc, 'strong', 'brain-workflow-row-title', itemTitle(item)),
        element(doc, 'span', 'brain-workflow-summary', itemSummary(item)),
        citationNode(item),
      );
      list.append(button);
    });
    result.replaceChildren(answer, list);
  }

  async function submitAsk() {
    if (destroyed || !refs) return;
    const question = String(refs.askInput.value ?? '').slice(0, 160).trim();
    const provider = plainText(refs.askProvider.value) || 'all';
    if (!question) {
      workflowStatus(refs.askResults, 'พิมพ์คำถามก่อน', 'ใช้ชื่อโปรเจกต์ งาน บุคคล หรือหัวข้อที่ต้องการค้นหา');
      return;
    }
    askController?.abort();
    askController = makeController();
    const requestId = ++askRequestId;
    workflowStatus(refs.askResults, 'กำลังค้นหา Brain', 'ค้นหาแบบกำหนดผลลัพธ์จากดัชนีในเครื่อง ไม่ได้ถาม AI ออนไลน์', 'loading');
    try {
      const payload = await fetchPayload(askPath({ q: question, provider }), askController);
      if (destroyed || requestId !== askRequestId
        || question !== String(refs.askInput.value ?? '').slice(0, 160).trim()
        || provider !== plainText(refs.askProvider.value)) return;
      askPayload = payload;
      renderAsk();
    } catch {
      if (destroyed || requestId !== askRequestId
        || question !== String(refs.askInput.value ?? '').slice(0, 160).trim()
        || provider !== plainText(refs.askProvider.value)) return;
      workflowStatus(refs.askResults, 'ค้นหา Brain ไม่ได้', 'คำถามและแผนที่เดิมยังอยู่ ลองส่งคำถามอีกครั้ง', 'unavailable');
    } finally {
      if (requestId === askRequestId) askController = null;
    }
  }

  function cancelPendingAskForEdit() {
    if (!askController || destroyed || !refs?.askResults) return;
    askController.abort();
    askController = null;
    askRequestId += 1;
    workflowStatus(refs.askResults, 'คำถามเปลี่ยนแล้ว', 'กดค้นหาอีกครั้งเพื่อใช้คำถามและผู้ให้บริการล่าสุด');
  }

  function gapGroupLabel(gap) {
    if (gap.kind === 'possible-divergence') return 'อาจให้บริบทต่างกัน';
    if (gap.direction === 'claude->codex') return 'มีใน Claude แต่ยังไม่พบคู่ใน Codex';
    return 'มีใน Codex แต่ยังไม่พบคู่ใน Claude';
  }

  function renderGaps() {
    if (!refs?.gapPanel || !gapPayload) return;
    const visible = objectList(gapPayload.gaps).filter((gap) => !dismissedGapIds.has(plainText(gap.id)));
    const intro = element(doc, 'header', 'brain-workflow-toolbar');
    const introCopy = element(doc, 'div');
    introCopy.append(
      element(doc, 'h3', 'brain-workflow-title', 'รายการที่ควรตรวจสอบระหว่างผู้ให้บริการ'),
      element(doc, 'p', 'brain-workflow-summary', 'รายการเหล่านี้เป็นเพียงตัวเลือกให้ตรวจสอบ ไม่ใช่ข้อขัดแย้งที่ยืนยันแล้ว และจะไม่ซิงก์อัตโนมัติ'),
    );
    intro.append(introCopy);
    if (!visible.length) {
      refs.gapPanel.replaceChildren(intro, element(doc, 'p', 'brain-quiet-copy', 'ไม่มีรายการที่ควรตรวจสอบในเซสชันนี้'));
      return;
    }
    const groups = new Map();
    visible.forEach((gap) => {
      const label = gapGroupLabel(gap);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(gap);
    });
    const parts = [intro];
    groups.forEach((rows, label) => {
      const group = element(doc, 'section', 'brain-workflow-group');
      group.append(element(doc, 'h4', 'brain-workflow-group-title', `${label} ${rows.length}`));
      rows.forEach((gap) => {
        const row = element(doc, 'article', 'brain-gap-row');
        row.append(
          element(doc, 'p', 'brain-section-label', thaiType(gap.itemType)),
          element(doc, 'strong', 'brain-workflow-row-title', literalText(gap.title, 'รายการไม่มีชื่อ')),
          element(doc, 'p', 'brain-workflow-summary', literalText(gap.reason, 'ควรตรวจสอบหลักฐานทั้งสองฝั่ง')),
        );
        const evidence = element(doc, 'div', 'brain-gap-evidence');
        evidence.hidden = true;
        evidence.append(citationNode(gap.evidence?.from));
        if (gap.evidence?.to) evidence.append(citationNode(gap.evidence.to));
        const differences = Array.isArray(gap.differences)
          ? gap.differences.slice(0, 3).map((value) => plainText(value)).filter(Boolean).join(', ')
          : '';
        if (differences) evidence.append(element(doc, 'p', 'brain-workflow-status', `ข้อมูลที่ต่าง: ${differences}`));
        const actions = element(doc, 'div', 'brain-workflow-actions');
        const inspect = actionButton(doc, 'brain-workflow-button', 'ดูหลักฐาน', () => {
          evidence.hidden = !evidence.hidden;
          inspect.textContent = evidence.hidden ? 'ดูหลักฐาน' : 'ซ่อนหลักฐาน';
          inspect.setAttribute('aria-expanded', String(!evidence.hidden));
        });
        inspect.setAttribute('aria-expanded', 'false');
        const copy = actionButton(doc, 'brain-workflow-button', 'คัดลอกหลักฐาน', () => {
          const citations = [gap.evidence?.from, gap.evidence?.to]
            .filter(Boolean).map((entry) => sourceCitation(entry))
            .map((entry) => `${entry.provider}: ${entry.path}`).join('\n');
          copyWithButton(copy, citations);
        });
        const dismiss = actionButton(doc, 'brain-workflow-button', 'ซ่อนเซสชันนี้', () => {
          dismissedGapIds.add(plainText(gap.id));
          renderGaps();
        });
        actions.append(inspect, copy, dismiss);
        row.append(actions, evidence);
        group.append(row);
      });
      parts.push(group);
    });
    refs.gapPanel.replaceChildren(...parts);
  }

  async function requestGaps() {
    if (destroyed || !refs) return;
    gapController?.abort();
    gapController = makeController();
    const requestId = ++gapRequestId;
    if (!gapPayload) workflowStatus(refs.gapPanel, 'กำลังเปรียบเทียบหลักฐาน', 'กำลังหาคู่ความรู้ที่ควรตรวจสอบระหว่าง Claude และ Codex', 'loading');
    try {
      const payload = await fetchPayload(gapPath(), gapController);
      if (destroyed || requestId !== gapRequestId) return;
      gapPayload = payload;
      renderGaps();
    } catch {
      if (destroyed || requestId !== gapRequestId) return;
      if (!gapPayload) workflowStatus(refs.gapPanel, 'เปิดรายการตรวจสอบไม่ได้', 'ลองเปิดแท็บนี้อีกครั้ง ไม่มีการซิงก์หรือแก้ไขไฟล์', 'unavailable');
    } finally {
      if (requestId === gapRequestId) gapController = null;
    }
  }

  function replaceDetails(nextDetails) {
    if (!refs) return;
    refs.details.removeAttribute('aria-busy');
    refs.details.replaceChildren(...nextDetails.childNodes);
  }

  function renderEmptyDetails() {
    replaceDetails(makeDetails(doc, null, [], [], selectItem, openResumeForItem));
  }

  function mapNodeById(id) {
    const matches = Array.from(refs?.mapNodes.querySelectorAll?.('button[data-map-item-id]') ?? [])
      .filter((button) => button.dataset.mapItemId === id);
    return matches.find((button) => !button.hidden && button.getAttribute('aria-hidden') !== 'true')
      ?? matches[0] ?? null;
  }

  function selectedFocusItem() {
    return objectList(focusPayload?.items)
      .find((item) => plainText(item.id) === selectedId) ?? null;
  }

  function structureNode(id) {
    return structureIndex?.nodesById?.get(plainText(id)) ?? null;
  }

  function structureNodeButton(id) {
    return Array.from(refs?.mapNodes.querySelectorAll?.('button[data-structure-node="true"]') ?? [])
      .find((button) => button.dataset.structureId === id) ?? null;
  }

  function structureProviderPath(provider) {
    const path = structureExpandedPathByProvider.get(provider);
    return Array.isArray(path) ? path : [];
  }

  function setStructureProviderPath(provider, path) {
    if (!MAP_PROVIDERS.includes(provider)) return;
    structureExpandedPathByProvider.set(provider, Array.isArray(path) ? [...path] : []);
  }

  function realStructureDirectoryPath(id) {
    const node = structureNode(id);
    if (!node || node.kind !== 'dir') return null;
    const provider = providerForStructureNode(node);
    if (!MAP_PROVIDERS.includes(provider) || node.id === provider) return null;
    const path = [];
    const seen = new Set();
    let current = node.id;
    while (current && current !== provider && !seen.has(current)) {
      seen.add(current);
      const currentNode = structureNode(current);
      if (!currentNode || currentNode.kind !== 'dir'
        || providerForStructureNode(currentNode) !== provider) return null;
      path.unshift(current);
      current = structureIndex?.parentById?.get(current) || '';
    }
    return current === provider ? { provider, path } : null;
  }

  function visibleStructureOrigin(node, visiblePositions, projection = structureProjection) {
    const positions = visiblePositions instanceof Map ? visiblePositions : new Map();
    const seen = new Set();
    let parentId = plainText(node?.parentId) || structureIndex?.parentById?.get(node?.id) || '';
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const position = positions.get(parentId);
      if (position) return position;
      parentId = structureIndex?.parentById?.get(parentId) || '';
    }
    const provider = providerForStructureNode(node);
    return positions.get(provider)
      ?? positions.get('knowledge-core')
      ?? { x: projection?.center?.x ?? structureGeometry.width / 2, y: projection?.center?.y ?? structureGeometry.height / 2 };
  }

  function currentStructureButtonPosition(button) {
    const view = doc.defaultView ?? globalThis;
    const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(button) : null;
    const x = Number.parseFloat(style?.left);
    const y = Number.parseFloat(style?.top);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    const target = button?.__structureTarget;
    return target && Number.isFinite(target.x) && Number.isFinite(target.y) ? target : null;
  }

  function deriveStructureEntryGeometry(projection = structureProjection) {
    const desiredIds = new Set(projection?.nodes?.map((node) => node.id) ?? []);
    const visibleBeforeReconciliation = new Map();
    for (const button of refs?.mapNodes.querySelectorAll?.('button[data-structure-node="true"]') ?? []) {
      const id = button.dataset.structureId;
      if (!desiredIds.has(id)) continue;
      const position = currentStructureButtonPosition(button);
      if (position) visibleBeforeReconciliation.set(id, position);
    }
    const entryOriginById = new Map();
    const motionOriginById = new Map(visibleBeforeReconciliation);
    const nodesByLayer = [...(projection?.nodes ?? [])].sort((left, right) => (
      safeNumber(left.layerDepth) - safeNumber(right.layerDepth)
    ));
    for (const node of nodesByLayer) {
      if (motionOriginById.has(node.id)) continue;
      const origin = visibleStructureOrigin(node, motionOriginById, projection);
      entryOriginById.set(node.id, origin);
      // A newly introduced parent has not reached its projected coordinate.
      // Deeper nodes and their routes share this exact visible ancestor origin.
      motionOriginById.set(node.id, origin);
    }
    return { visibleBeforeReconciliation, entryOriginById, motionOriginById };
  }

  function structureMotionReduced() {
    try {
      return Boolean(doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function scheduleStructureFrame(callback) {
    const requestFrame = doc.defaultView?.requestAnimationFrame ?? globalThis.requestAnimationFrame;
    if (typeof requestFrame === 'function') return requestFrame(callback);
    return setTimer(callback, 0);
  }

  function afterStructurePaint(callback) {
    scheduleStructureFrame(() => scheduleStructureFrame(callback));
  }

  function boundedStructureStagger(index) {
    return Math.min(Math.max(0, index), STRUCTURE_STAGGER_SLOTS) * STRUCTURE_STAGGER_MS;
  }

  function structureCounts(node) {
    const direct = structureIndex?.childrenById?.get(node?.id)?.length ?? 0;
    return {
      direct,
      files: node?.kind === 'file' ? 1 : safeNumber(node?.files),
      markdown: safeNumber(node?.mdFiles),
    };
  }

  function structureProviderLabel(node) {
    const provider = providerForStructureNode(node);
    return provider === 'unified' ? 'รวม Claude และ Codex' : `.${provider}`;
  }

  function structureAccessibleName(node) {
    const provider = structureProviderLabel(node);
    const counts = structureCounts(node);
    if (node.id === 'knowledge-core') {
      const totalFiles = safeNumber(structureNode('claude')?.files) + safeNumber(structureNode('codex')?.files);
      return `ศูนย์กลางความรู้ Knowledge Core, ผู้ให้บริการรวม Claude และ Codex, ลูกโดยตรง 2 รายการ, จำนวนไฟล์ ${totalFiles}, กดเพื่อรีเซ็ตโครงสร้าง`;
    }
    if (node.kind === 'more') {
      const parent = structureNode(node.parentId);
      const parentCounts = structureCounts(parent);
      return `ปุ่มแสดงชุดถัดไป ${literalText(node.label, node.id)}, พาธ ${literalText(parent?.path, parent?.id)}, ผู้ให้บริการ ${provider}, ลูกโดยตรง ${parentCounts.direct} รายการ, จำนวนไฟล์ ${parentCounts.files}, เหลือ ${safeNumber(node.files)} รายการ`;
    }
    const kind = node.id === 'claude' || node.id === 'codex'
      ? 'รากผู้ให้บริการ'
      : node.kind === 'dir' ? 'โฟลเดอร์' : 'ไฟล์';
    return `${kind} ${literalText(node.label, node.id)}, พาธ ${literalText(node.path, node.id)}, ผู้ให้บริการ ${provider}, ลูกโดยตรง ${counts.direct} รายการ, จำนวนไฟล์ ${counts.files}`;
  }

  function geometryForStructure(availableWidth, projectedNodeCount = 0) {
    const measured = Number(availableWidth);
    const rawAvailable = Number.isFinite(measured) && measured > 0 ? measured : STRUCTURE_WIDTH;
    if (rawAvailable >= STRUCTURE_WIDE_MIN_WIDTH) {
      return { mode: 'wide', width: STRUCTURE_WIDTH, height: STRUCTURE_HEIGHT };
    }
    // Keep the same square circular world at every narrow width. Presentation
    // CSS supplies horizontal scrolling rather than asking the graph to turn
    // into a vertical filesystem lane.
    return { mode: 'circular', width: STRUCTURE_WIDTH, height: STRUCTURE_HEIGHT };
  }

  function sameStructureGeometry(left, right) {
    return left?.mode === right?.mode && left?.width === right?.width && left?.height === right?.height;
  }

  function updateStructureGeometry(availableWidth, projectedNodeCount = structureProjection?.nodes?.length ?? 0) {
    const measured = Number(availableWidth);
    if (!Number.isFinite(measured) || measured <= 0) return false;
    structureAvailableWidth = measured;
    const next = geometryForStructure(structureAvailableWidth, projectedNodeCount);
    if (sameStructureGeometry(structureGeometry, next)) return false;
    structureGeometry = next;
    return true;
  }

  function measureStructureContainer() {
    if (!refs?.mapLayout) return 0;
    const width = Number(refs.mapLayout.getBoundingClientRect?.().width)
      || Number(refs.mapLayout.clientWidth);
    return Number.isFinite(width) && width > 0 ? width : 0;
  }

  function handleStructureResize(width) {
    if (!updateStructureGeometry(width)) return;
    if (structureReady) renderStructureGraph();
    else if (refs?.mapView.getAttribute?.('data-presentation') === 'structure') setStructurePresentation(true);
  }

  function observeStructureGeometry() {
    structureResizeObserver?.disconnect?.();
    structureResizeObserver = null;
    handleStructureResize(measureStructureContainer());
    const ResizeObserverClass = deps.ResizeObserver ?? globalThis.ResizeObserver;
    if (typeof ResizeObserverClass !== 'function' || !refs?.mapLayout) return;
    structureResizeObserver = new ResizeObserverClass((entries) => {
      if (destroyed) return;
      const entry = Array.from(entries ?? []).find((candidate) => candidate?.target === refs.mapLayout)
        ?? Array.from(entries ?? [])[0];
      const width = Number(entry?.contentRect?.width) || measureStructureContainer();
      handleStructureResize(width);
    });
    structureResizeObserver.observe(refs.mapLayout);
  }

  function boundedStructureZoom(value) {
    const numeric = Number(value);
    const fallback = Number.isFinite(numeric) ? numeric : STRUCTURE_ZOOM_DEFAULT;
    const stepped = Math.round(fallback / STRUCTURE_ZOOM_STEP) * STRUCTURE_ZOOM_STEP;
    return Math.min(STRUCTURE_ZOOM_MAX, Math.max(STRUCTURE_ZOOM_MIN, stepped));
  }

  function updateStructureZoomControls() {
    if (!refs?.mapZoomControls) return;
    const enabled = structureReady
      && refs.mapView.getAttribute?.('data-presentation') === 'structure';
    refs.mapZoomControls.setAttribute('aria-disabled', String(!enabled));
    refs.mapZoomOut.disabled = !enabled || structureZoomPercent <= STRUCTURE_ZOOM_MIN;
    refs.mapZoomIn.disabled = !enabled || structureZoomPercent >= STRUCTURE_ZOOM_MAX;
    refs.mapZoomReset.disabled = !enabled;
    refs.mapZoomReset.textContent = `${structureZoomPercent}% · รีเซ็ต`;
    refs.mapZoomReset.setAttribute(
      'aria-label',
      `ขนาดแผนที่ ${structureZoomPercent} เปอร์เซ็นต์ กดเพื่อรีเซ็ตเป็น ${STRUCTURE_ZOOM_DEFAULT} เปอร์เซ็นต์`,
    );
  }

  function centerStructureScroll() {
    if (destroyed || !refs || !structureReady) return;
    const scroller = refs.mapStage;
    scroller.scrollLeft = Math.max(0, (
      safeNumber(scroller.scrollWidth) - safeNumber(scroller.clientWidth)
    ) / 2);
  }

  function applyStructureZoom({ center = false } = {}) {
    if (!refs) return;
    const scale = structureZoomPercent / 100;
    const scaledWidth = structureGeometry.width * scale;
    const scaledHeight = structureGeometry.height * scale;
    for (const target of [refs.mapView, refs.mapStage]) {
      target.style?.setProperty?.('--brain-structure-zoom-scale', String(scale));
      target.style?.setProperty?.('--brain-structure-scaled-width', `${scaledWidth}px`);
      target.style?.setProperty?.('--brain-structure-scaled-height', `${scaledHeight}px`);
    }
    updateStructureZoomControls();
    if (!center || !structureReady) return;
    clearStructureButtonSnapshots();
    invalidateStructureFocusTransactions();
    afterStructurePaint(centerStructureScroll);
  }

  function setStructureZoom(value) {
    const next = boundedStructureZoom(value);
    const changed = next !== structureZoomPercent;
    structureZoomPercent = next;
    applyStructureZoom({ center: changed || next === STRUCTURE_ZOOM_DEFAULT });
  }

  function setStructurePresentation(enabled) {
    if (!refs) return;
    const presentation = enabled ? 'structure' : 'semantic';
    for (const target of [refs.mapView, refs.mapStage]) {
      target.setAttribute('data-presentation', presentation);
      target.setAttribute('data-structure-layout', structureGeometry.mode);
      target.style?.setProperty?.('--brain-structure-active-width', `${structureGeometry.width}px`);
      target.style?.setProperty?.('--brain-structure-active-height', `${structureGeometry.height}px`);
    }
    refs.mapSvg.setAttribute('viewBox', enabled
      ? `0 0 ${structureGeometry.width} ${structureGeometry.height}`
      : '0 0 100 100');
    refs.mapCenter.hidden = enabled;
    refs.mapProviderRoots.hidden = enabled;
    for (const layer of [refs.mapHud, refs.mapRings, refs.mapBandLabels]) {
      if (enabled) layer.setAttribute('display', 'none');
      else layer.removeAttribute('display');
    }
    refs.mapBreadcrumb.hidden = !enabled;
    if (enabled) refs.mapRail.removeAttribute('data-side');
    refs.mapStage.setAttribute('aria-label', enabled
      ? 'โครงสร้างความรู้จริงจาก .claude และ .codex แบบอ่านอย่างเดียว'
      : 'โหนดความรู้เรียงในวงความหมายเจ็ดชั้น แยก Claude และ Codex');
    refs.mapNodes.setAttribute('aria-label', enabled ? 'โหนดโครงสร้างความรู้' : 'โหนดแผนที่ความรู้');
    refs.mapTitle.textContent = 'BIGNOSE OS';
    refs.mapSystemStatus.textContent = enabled
      ? 'โครงสร้างความรู้ในเครื่องพร้อมใช้งาน'
      : 'ระบบเชื่อมโยงความรู้พร้อมใช้งาน';
    refs.mapSystemCode.textContent = enabled
      ? 'BBN // โครงสร้างจริงแบบอ่านอย่างเดียว'
      : 'BBN // ศูนย์ความรู้ในเครื่อง';
    refs.mapTelemetryIndex.textContent = enabled ? 'โครงสร้าง // ระบบไฟล์' : 'ดัชนี // ในเครื่อง';
    refs.mapTelemetryMode.textContent = 'โหมด // อ่านอย่างเดียว';
    refs.mapTelemetryLink.textContent = 'เส้นเชื่อม // เชิงความหมาย';
    applyStructureZoom();
  }

  function renderStructureBreadcrumb() {
    if (!refs?.mapBreadcrumb || !structureProjection) return;
    const chain = [];
    const seen = new Set();
    let current = structureFocusId;
    while (current && structureNode(current) && !seen.has(current)) {
      seen.add(current);
      chain.unshift(structureNode(current));
      current = structureIndex.parentById.get(current);
    }
    const visibleAncestors = new Set(structureProjection.ancestorIds ?? []);
    refs.mapBreadcrumb.replaceChildren();
    const core = prepareStructureFocusButton(actionButton(doc, 'brain-structure-crumb', 'ศูนย์กลางความรู้', resetStructureView));
    core.setAttribute('aria-label', 'กลับสู่ศูนย์กลางความรู้และรีเซ็ตโครงสร้าง');
    refs.mapBreadcrumb.append(core);
    if (structureProjection.omittedAncestorCount > 0) {
      const omitted = chain.filter((node) => !visibleAncestors.has(node.id));
      const target = omitted.at(-1) ?? chain[0];
      const ellipsis = prepareStructureFocusButton(actionButton(doc, 'brain-structure-crumb', '…', () => {
        if (target) focusStructureAncestor(target.id);
      }));
      ellipsis.setAttribute('aria-label', `แสดงบรรพบุรุษที่ย่อไว้ ${structureProjection.omittedAncestorCount} ระดับ`);
      refs.mapBreadcrumb.append(ellipsis);
    }
    for (const node of chain.filter((entry) => visibleAncestors.has(entry.id))) {
      const crumb = prepareStructureFocusButton(actionButton(
        doc,
        'brain-structure-crumb',
        literalText(node.label, node.id),
        () => focusStructureAncestor(node.id),
      ));
      setAttributes(crumb, {
        'data-structure-id': node.id,
        'aria-current': node.id === structureFocusId ? 'location' : null,
        title: literalText(node.path, node.id),
      });
      refs.mapBreadcrumb.append(crumb);
    }
  }

  function structureSummary(node) {
    const summary = element(doc, 'section', 'brain-structure-summary');
    if (!node) {
      summary.append(
        element(doc, 'p', 'brain-section-label', 'โครงสร้างความรู้'),
        element(doc, 'h3', 'brain-map-rail-title', 'เลือกโฟลเดอร์หรือไฟล์'),
        element(doc, 'p', 'brain-quiet-copy', 'เลือกโหนดเพื่อดูพาธจริงและโครงสร้างย่อย กดศูนย์กลางความรู้เพื่อเริ่มใหม่'),
      );
      return summary;
    }
    const counts = structureCounts(node);
    const provider = structureProviderLabel(node);
    const kind = node.id === 'claude' || node.id === 'codex'
      ? 'รากผู้ให้บริการ'
      : node.kind === 'dir' ? 'โฟลเดอร์' : 'ไฟล์';
    const header = element(doc, 'header', 'brain-map-focus-header');
    header.append(
      element(doc, 'p', 'brain-section-label', `${kind} · ${provider}`),
      element(doc, 'h3', 'brain-map-focus-title', literalText(node.label, node.id)),
    );
    const path = element(doc, 'code', 'brain-source-path', literalText(node.path, node.id));
    const facts = element(doc, 'div', 'brain-structure-facts');
    facts.append(
      element(doc, 'p', 'brain-structure-fact', `ผู้ให้บริการ: ${provider}`),
      element(doc, 'p', 'brain-structure-fact', `ลูกโดยตรง: ${counts.direct} รายการ`),
      element(doc, 'p', 'brain-structure-fact', `ไฟล์สืบทอด: ${node.kind === 'file' ? 0 : safeNumber(node.files)} ไฟล์`),
      element(doc, 'p', 'brain-structure-fact', `Markdown สืบทอด: ${node.kind === 'file' && literalText(node.ext).toLocaleLowerCase() === '.md' ? 1 : safeNumber(node.mdFiles)} ไฟล์`),
      element(doc, 'p', 'brain-structure-fact', `แก้ไขล่าสุด: ${formatDate(node.mtime)}`),
    );
    if (node.kind === 'file') facts.append(element(doc, 'p', 'brain-structure-fact', `ขนาด: ${safeNumber(node.size).toLocaleString('th-TH')} ไบต์`));
    summary.append(
      header,
      element(doc, 'p', 'brain-section-label', 'พาธหรือ URI'),
      path,
      facts,
      element(doc, 'p', 'brain-quiet-copy', node.kind === 'dir'
        ? 'เลือกโฟลเดอร์เพื่อเปิดลูกโดยตรง หรือเลือกโฟลเดอร์เดิมเพื่อย้อนขึ้นหนึ่งระดับ'
        : 'เลือกไฟล์เพื่อดูความสัมพันธ์จากดัชนี Brain โดยไม่มีการเปิดหรือแก้ไขไฟล์'),
    );
    return summary;
  }

  function renderStructureRail() {
    if (!refs?.mapRail) return;
    refs.mapRail.removeAttribute('data-state');
    if (focusRequestKind === 'structure-semantic' && structureSemanticAnchor
      && structureFocusState === 'loading') {
      const loading = element(doc, 'section', 'brain-map-rail-state brain-map-rail-state-loading');
      setAttributes(loading, { role: 'status', 'aria-live': 'polite' });
      loading.append(
        element(doc, 'p', 'brain-section-label', `ความรู้เชิงความหมาย · .${structureSemanticAnchor.provider}`),
        element(doc, 'h3', 'brain-map-rail-title', structureSemanticAnchor.label),
        element(doc, 'p', 'brain-quiet-copy', 'กำลังอ่านความสัมพันธ์แบบจำกัด โดยคงจุดยึดที่เลือกไว้บนแผนที่'),
      );
      refs.mapRail.replaceChildren(loading);
      return;
    }
    if (structureFocusState === 'semantic' && focusPayload) {
      const selected = objectList(focusPayload.items)
        .find((item) => plainText(item.id) === selectedId) ?? null;
      if (selected) {
        const layers = semanticFocusLayers(focusPayload.items, focusPayload.relations, selectedId, focusDepth);
        const focused = layers.direct;
        const header = element(doc, 'header', 'brain-map-focus-header');
        const title = element(doc, 'h3', 'brain-map-focus-title', literalText(selected.title, 'รายการไม่มีชื่อ'));
        title.setAttribute('tabindex', '-1');
        header.append(
          element(doc, 'p', 'brain-section-label', `${thaiType(selected.type)} · .${plainText(selected.source?.provider)}`),
          title,
          element(doc, 'p', 'brain-map-focus-summary', literalText(selected.summary, 'รายการนี้ยังไม่มีสรุป')),
          element(doc, 'code', 'brain-source-path', literalText(selected.source?.path, 'ไม่มีพาธแหล่งที่มา')),
          actionButton(doc, 'brain-resume-trigger', 'ทำงานต่อจากตรงนี้', () => openResumeForItem(selected.id)),
        );
        const parts = [
          header,
          makeMapRelationGroup('เส้นทางที่เชื่อมเข้า', focused.incoming),
          makeMapRelationGroup('เส้นทางที่เชื่อมออก', focused.outgoing),
        ];
        const secondRows = uniqueSemanticEndpoints(layers.secondHop);
        if (secondRows.length) parts.push(makeMapRelationGroup('ชั้นที่ 2 · ผ่านรายการชั้นแรก', secondRows));
        refs.mapRail.replaceChildren(...parts);
        return;
      }
    }
    const node = structureNode(structureFocusId);
    const parts = [structureSummary(node)];
    if (node?.kind === 'file') {
      if (structureFocusState === 'loading') {
        parts.push(element(doc, 'p', 'brain-quiet-copy', 'กำลังอ่านความสัมพันธ์แบบจำกัดจากดัชนี Brain…'));
      } else if (structureFocusState === 'unavailable') {
        parts.push(element(doc, 'p', 'brain-quiet-copy', 'ไฟล์นี้ไม่มีผลตอบกลับความสัมพันธ์จาก Brain แต่สรุปโครงสร้างยังคงแสดงอยู่'));
      } else if (structureFocusState === 'ready' && focusPayload) {
        const layers = semanticFocusLayers(focusPayload.items, focusPayload.relations, node.id, focusDepth);
        const focused = layers.direct;
        parts.push(
          makeMapRelationGroup('เส้นทางที่เชื่อมเข้า', focused.incoming),
          makeMapRelationGroup('เส้นทางที่เชื่อมออก', focused.outgoing),
        );
        const secondRows = uniqueSemanticEndpoints(layers.secondHop);
        if (secondRows.length) parts.push(makeMapRelationGroup('ชั้นที่ 2 · ผ่านรายการชั้นแรก', secondRows));
      }
    }
    refs.mapRail.replaceChildren(...parts);
  }

  function makeStructureSemanticAnchor(id, hint = null, selectedItem = null) {
    const origin = structureProjection?.positions?.get(structureFocusId)
      ?? { x: structureGeometry.width / 2, y: structureGeometry.height / 2 };
    const position = stableSemanticAnchorPosition(id, hint, origin, structureGeometry);
    const provider = providerForStructureNode({
      provider: hint?.provider ?? selectedItem?.source?.provider,
    });
    return {
      id: `semantic:selected:${id}`,
      semanticItemId: id,
      structureId: `semantic-selected:${id}`,
      label: literalText(selectedItem?.title, literalText(hint?.label, id)),
      provider,
      role: literalText(hint?.role, 'other'),
      realNode: null,
      row: null,
      orbitLayer: 'selected-semantic',
      r: 20,
      labelSide: position.x < structureGeometry.width / 2 ? 'right' : 'left',
      ...position,
    };
  }

  function placeStructureSemantic(layers, projection, {
    semanticSelectedId = structureFocusId,
    selectedAnchor = null,
  } = {}) {
    structureSemanticItems = selectedAnchor ? [selectedAnchor] : [];
    const selectedPosition = selectedAnchor ?? projection.positions.get(structureFocusId);
    if (!selectedPosition) return [];
    const relationRows = [...(layers?.direct?.incoming ?? []), ...(layers?.direct?.outgoing ?? [])];
    const secondHopRows = Array.from(layers?.secondHop ?? []);
    // The selected synthetic anchor is the focus, not one of the API's
    // six-in/six-out neighbors. It counts only against the global 40-node
    // canvas bound; direct semantic endpoints retain their full 12-slot cap.
    const focusCost = selectedAnchor ? 1 : 0;
    const visibleStructureCount = Math.max(0,
      projection.nodes.length - (structureUnderlayShadowId ? 1 : 0));
    let globalBudget = Math.max(0, VISIBLE_NODE_LIMIT - visibleStructureCount - focusCost);
    let directBudget = Math.min(SEMANTIC_LIMIT, globalBudget);
    const occupied = [...projection.positions.values()].map((position) => ({
      x: position.x, y: position.y, r: safeNumber(position.r) || 14,
    }));
    if (selectedAnchor) occupied.push({ x: selectedAnchor.x, y: selectedAnchor.y, r: 20 });
    const routes = [];
    const semanticByRelatedId = new Map();
    const endpointByRelatedId = new Map();
    relationRows.forEach((row, index) => {
      if (!row.relatedId || row.relatedId === semanticSelectedId) return;
      const visiblePosition = projection.positions.get(row.relatedId);
      if (visiblePosition) {
        const endpoint = { position: visiblePosition, targetId: row.relatedId };
        endpointByRelatedId.set(row.relatedId, endpoint);
        routes.push({ row, ...endpoint, sourceId: selectedAnchor?.id ?? structureFocusId, sourcePosition: selectedPosition, orbitLayer: 'first-hop' });
        return;
      }
      const existing = semanticByRelatedId.get(row.relatedId);
      if (existing) {
        routes.push({
          row, position: existing, targetId: existing.id,
          sourceId: selectedAnchor?.id ?? structureFocusId, sourcePosition: selectedPosition, orbitLayer: 'first-hop',
        });
        return;
      }
      if (directBudget <= 0 || globalBudget <= 0) return;
      const realNode = structureNode(row.relatedId);
      const radius = 20;
      const provider = providerForStructureNode(realNode || { provider: row.relatedItem?.source?.provider });
      const role = roleForStructureNode(realNode);
      const minX = radius;
      const maxX = structureGeometry.width - radius;
      let position = null;
      const candidates = [];
      for (let slot = 0; slot < 48; slot += 1) {
        const ring = Math.floor(slot / 12);
        const angle = ((index + (slot % 12)) * Math.PI * 2 / Math.max(12, relationRows.length)) - (Math.PI / 2);
        const distance = 112 + (ring * 64);
        candidates.push({
          x: Math.min(maxX, Math.max(minX, selectedPosition.x + Math.cos(angle) * distance)),
          y: Math.min(structureGeometry.height - radius, Math.max(radius, selectedPosition.y + Math.sin(angle) * distance)),
          r: radius,
          labelSide: selectedPosition.x + Math.cos(angle) * distance < structureGeometry.width / 2 ? 'right' : 'left',
        });
      }
      for (const candidate of candidates) {
        if (occupied.every((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y) >= radius + other.r + 18)) {
          position = candidate;
          break;
        }
      }
      if (!position) return;
      const semantic = {
        id: `semantic:${row.direction}:${index}:${row.relatedId}`,
        structureId: realNode?.id || `semantic:${row.relatedId}`,
        label: literalText(row.relatedItem?.title, row.relatedId),
        provider,
        role,
        realNode,
        row,
        orbitLayer: 'first-hop',
        ...position,
      };
      occupied.push(position);
      structureSemanticItems.push(semantic);
      semanticByRelatedId.set(row.relatedId, semantic);
      endpointByRelatedId.set(row.relatedId, { position, targetId: semantic.id });
      routes.push({
        row, position, targetId: semantic.id,
        sourceId: selectedAnchor?.id ?? structureFocusId, sourcePosition: selectedPosition, orbitLayer: 'first-hop',
      });
      directBudget -= 1;
      globalBudget -= 1;
    });

    const secondEndpointByRelatedId = new Map();
    const siblingIndexByParent = new Map();
    secondHopRows.forEach((row, index) => {
      const parent = endpointByRelatedId.get(row.parentId);
      if (!parent || !row.relatedId || row.relatedId === semanticSelectedId) return;
      const visiblePosition = projection.positions.get(row.relatedId);
      if (visiblePosition) {
        routes.push({
          row, position: visiblePosition, targetId: row.relatedId,
          sourceId: parent.targetId, sourcePosition: parent.position, orbitLayer: 'second-hop',
        });
        return;
      }
      const existing = secondEndpointByRelatedId.get(row.relatedId);
      if (existing) {
        routes.push({
          row, ...existing,
          sourceId: parent.targetId, sourcePosition: parent.position, orbitLayer: 'second-hop',
        });
        return;
      }
      if (globalBudget <= 0) return;
      const realNode = structureNode(row.relatedId);
      const radius = 20;
      const provider = providerForStructureNode(realNode || { provider: row.relatedItem?.source?.provider });
      const role = roleForStructureNode(realNode);
      const parentDx = parent.position.x - selectedPosition.x;
      const parentDy = parent.position.y - selectedPosition.y;
      const parentAngle = Math.hypot(parentDx, parentDy) > 1 ? Math.atan2(parentDy, parentDx) : -Math.PI / 2;
      const siblingIndex = siblingIndexByParent.get(row.parentId) ?? 0;
      siblingIndexByParent.set(row.parentId, siblingIndex + 1);
      let position = null;
      for (let slot = 0; slot < 48; slot += 1) {
        const fan = ((siblingIndex + slot) % 7 - 3) * .12;
        const distance = 88 + Math.floor(slot / 7) * 46;
        const angle = parentAngle + fan;
        const candidate = {
          x: Math.min(structureGeometry.width - radius, Math.max(radius, parent.position.x + Math.cos(angle) * distance)),
          y: Math.min(structureGeometry.height - radius, Math.max(radius, parent.position.y + Math.sin(angle) * distance)),
          r: radius,
          labelSide: parent.position.x + Math.cos(angle) * distance < structureGeometry.width / 2 ? 'right' : 'left',
        };
        if (occupied.every((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y) >= radius + other.r + 18)) {
          position = candidate;
          break;
        }
      }
      if (!position) return;
      const semantic = {
        id: `semantic:second:${index}:${row.relatedId}`,
        structureId: realNode?.id || `semantic:${row.relatedId}`,
        label: literalText(row.relatedItem?.title, row.relatedId),
        provider,
        role,
        realNode,
        row,
        orbitLayer: 'second-hop',
        ...position,
      };
      occupied.push(position);
      structureSemanticItems.push(semantic);
      const endpoint = { position, targetId: semantic.id };
      secondEndpointByRelatedId.set(row.relatedId, endpoint);
      routes.push({
        row, ...endpoint,
        sourceId: parent.targetId, sourcePosition: parent.position, orbitLayer: 'second-hop',
      });
      globalBudget -= 1;
    });
    return routes;
  }

  function clearStructureElementTimer(element, key) {
    if (element?.[key] != null) clearTimer(element[key]);
    if (element) element[key] = null;
  }

  function structurePolylineLength(points) {
    return Math.max(1, points.slice(1).reduce((total, point, index) => {
      const previous = points[index];
      return total + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0));
  }

  function reconcileStructureRoutes(desiredRoutes, initialRender, reducedMotion) {
    const existing = new Map(Array.from(
      refs.mapOwnershipEdges.querySelectorAll?.('polyline[data-route-id]') ?? [],
    ).map((route) => [route.dataset.routeId, route]));

    desiredRoutes.forEach((record, routeId) => {
      let route = existing.get(routeId);
      const isNew = !route;
      if (!route) {
        route = svgElement(doc, 'polyline', 'brain-structure-route', {
          'data-route-id': routeId,
          'vector-effect': 'non-scaling-stroke',
        });
        refs.mapOwnershipEdges.append(route);
      }
      existing.delete(routeId);
      clearStructureElementTimer(route, '__structureRemovalTimer');
      const motionState = route.getAttribute('data-motion-state');
      const revivingExit = motionState === 'exit-fading'
        || motionState === 'exiting'
        || route.__structureExitPending === true;
      if (route.getAttribute('points') !== record.pointList) route.setAttribute('points', record.pointList);
      setAttributes(route, {
        'data-layer': record.layer,
        'data-provider': record.provider,
        'data-orbit-layer': literalText(record.targetNode?.orbitLayer, 'context'),
        'data-source-id': record.sourceId,
        'data-target-id': record.targetId,
      });
      if (isNew || revivingExit || route.__structureGeometryEntering !== true) {
        route.style.setProperty('--structure-route-origin-x', `${record.entryOrigin.x}px`);
        route.style.setProperty('--structure-route-origin-y', `${record.entryOrigin.y}px`);
      }
      route.__structureLength = record.length;
      route.__structureTargetNode = record.targetNode;

      if (reducedMotion) {
        route.__structureMotionToken = safeNumber(route.__structureMotionToken) + 1;
        route.__structureExitPending = false;
        route.__structureGeometryEntering = false;
        route.__structureExitFromHiddenEntry = false;
        clearStructureElementTimer(route, '__structureMotionTimer');
        route.removeAttribute('data-motion-state');
        route.style.removeProperty('stroke-dasharray');
        route.style.removeProperty('stroke-dashoffset');
        route.style.removeProperty('--structure-route-length');
        route.style.removeProperty('--structure-route-stagger');
        route.style.removeProperty('--structure-route-scale');
        return;
      }
      if (!isNew && motionState === 'exit-fading' && route.__structureExitFromHiddenEntry !== true) {
        route.__structureMotionToken = safeNumber(route.__structureMotionToken) + 1;
        const token = route.__structureMotionToken;
        route.__structureExitPending = false;
        route.__structureGeometryEntering = false;
        route.__structureExitFromHiddenEntry = false;
        clearStructureElementTimer(route, '__structureMotionTimer');
        route.setAttribute('data-motion-state', 'active');
        route.style.setProperty('stroke-dashoffset', '0');
        route.__structureMotionTimer = setTimer(() => {
          if (route.__structureMotionToken !== token || !route.parentNode) return;
          route.removeAttribute('data-motion-state');
          route.style.removeProperty('stroke-dasharray');
          route.style.removeProperty('stroke-dashoffset');
          route.style.removeProperty('--structure-route-length');
          route.style.removeProperty('--structure-route-stagger');
          route.__structureMotionTimer = null;
        }, STRUCTURE_ROUTE_ENTER_MS);
        return;
      }
      // A retained entering route owns the pending double-frame callback. Do
      // not invalidate its token during unrelated renders.
      if (!isNew && !revivingExit) return;
      route.__structureMotionToken = safeNumber(route.__structureMotionToken) + 1;
      const token = route.__structureMotionToken;
      route.__structureExitPending = false;
      route.__structureExitFromHiddenEntry = false;
      clearStructureElementTimer(route, '__structureMotionTimer');
      route.style.removeProperty('stroke-dasharray');
      route.style.removeProperty('stroke-dashoffset');
      route.removeAttribute('data-motion-state');
      route.__structureGeometryEntering = false;
      if (initialRender) return;

      const stagger = record.stagger;
      route.style.setProperty('--structure-route-length', String(record.length));
      route.style.setProperty('--structure-route-stagger', `${stagger}ms`);
      route.style.setProperty('stroke-dasharray', String(record.length));
      route.style.setProperty('stroke-dashoffset', String(record.length));
      route.__structureGeometryEntering = true;
      route.setAttribute('data-motion-state', 'entering');
      afterStructurePaint(() => {
        if (route.__structureMotionToken !== token || !route.parentNode) return;
        route.setAttribute('data-motion-state', 'active');
        route.style.setProperty('stroke-dashoffset', '0');
        route.__structureMotionTimer = setTimer(() => {
          if (route.__structureMotionToken !== token) return;
          route.removeAttribute('data-motion-state');
          route.style.removeProperty('stroke-dasharray');
          route.style.removeProperty('stroke-dashoffset');
          route.style.removeProperty('--structure-route-length');
          route.style.removeProperty('--structure-route-stagger');
          route.__structureGeometryEntering = false;
          route.__structureMotionTimer = null;
        }, Math.max(STRUCTURE_GEOMETRY_ENTER_MS, STRUCTURE_ROUTE_ENTER_MS + stagger));
      });
    });

    existing.forEach((route) => {
      if (reducedMotion) {
        clearStructureElementTimer(route, '__structureMotionTimer');
        clearStructureElementTimer(route, '__structureRemovalTimer');
        route.__structureMotionToken = safeNumber(route.__structureMotionToken) + 1;
        route.__structureExitPending = false;
        route.__structureGeometryEntering = false;
        route.__structureExitFromHiddenEntry = false;
        route.remove();
        return;
      }
      if (route.getAttribute('data-motion-state') === 'exit-fading'
        || route.getAttribute('data-motion-state') === 'exiting'
        || route.__structureExitPending === true) return;
      clearStructureElementTimer(route, '__structureMotionTimer');
      route.__structureMotionToken = safeNumber(route.__structureMotionToken) + 1;
      const token = route.__structureMotionToken;
      route.__structureExitPending = true;
      route.__structureGeometryEntering = false;
      const targetButton = structureNodeButton(route.dataset.targetId);
      route.__structureExitFromHiddenEntry = structureNodeIsHiddenEntry(targetButton)
        || targetButton?.hasAttribute('data-exit-hidden') === true;
      const targetNode = route.__structureTargetNode ?? structureNode(route.dataset.targetId);
      const collapseOrigin = visibleStructureOrigin(
        targetNode,
        structureProjection.positions,
        structureProjection,
      );
      route.style.setProperty('--structure-route-origin-x', `${collapseOrigin.x}px`);
      route.style.setProperty('--structure-route-origin-y', `${collapseOrigin.y}px`);
      const length = Math.max(1, safeNumber(route.__structureLength));
      route.style.setProperty('--structure-route-length', String(length));
      route.style.setProperty('--structure-route-stagger', '0ms');
      route.style.setProperty('stroke-dasharray', String(length));
      route.style.setProperty('stroke-dashoffset', '0');
      route.setAttribute('data-motion-state', 'active');
      route.getBoundingClientRect?.();
      route.__structureExitPending = false;
      // Fade at the collision-safe final geometry before the keyed route
      // collapses invisibly toward the same retained origin as its target.
      route.setAttribute('data-motion-state', 'exit-fading');
      route.__structureRemovalTimer = setTimer(() => {
        if (destroyed || route.__structureMotionToken !== token || !route.parentNode) return;
        route.setAttribute('data-motion-state', 'exiting');
        route.style.setProperty('stroke-dashoffset', String(length));
        route.__structureRemovalTimer = setTimer(() => {
          if (route.__structureMotionToken === token) route.remove();
          route.__structureExitPending = false;
          route.__structureExitFromHiddenEntry = false;
          route.__structureRemovalTimer = null;
        }, STRUCTURE_ROUTE_EXIT_MS);
      }, STRUCTURE_ROUTE_EXIT_MS);
    });
  }

  function reconcileStructureJunctions(desiredJunctions, initialRender, reducedMotion) {
    const existing = new Map(Array.from(
      refs.mapOwnershipJunctions.querySelectorAll?.('rect[data-junction-id]') ?? [],
    ).map((junction) => [junction.dataset.junctionId, junction]));
    desiredJunctions.forEach((record, junctionId) => {
      let junction = existing.get(junctionId);
      const isNew = !junction;
      if (!junction) {
        junction = svgElement(doc, 'rect', 'brain-structure-junction', {
          'data-junction-id': junctionId,
          'data-route-id': record.routeId,
          width: '8', height: '8',
        });
        refs.mapOwnershipJunctions.append(junction);
      }
      existing.delete(junctionId);
      clearStructureElementTimer(junction, '__structureRemovalTimer');
      const motionState = junction.getAttribute('data-motion-state');
      const revivingExit = motionState === 'exit-fading' || motionState === 'exiting';
      const attributes = {
        x: String(record.point.x - 4),
        y: String(record.point.y - 4),
        'data-layer': record.layer,
        'data-provider': record.provider,
        'data-orbit-layer': literalText(record.targetNode?.orbitLayer, 'context'),
        'data-source-id': record.sourceId,
        'data-target-id': record.targetId,
      };
      for (const [name, value] of Object.entries(attributes)) {
        if (junction.getAttribute(name) !== value) junction.setAttribute(name, value);
      }
      junction.removeAttribute('transform');
      if (isNew || revivingExit || junction.__structureGeometryEntering !== true) {
        junction.style.setProperty('--structure-route-origin-x', `${record.entryOrigin.x}px`);
        junction.style.setProperty('--structure-route-origin-y', `${record.entryOrigin.y}px`);
      }
      junction.__structureTargetNode = record.targetNode;
      if (reducedMotion) {
        junction.__structureMotionToken = safeNumber(junction.__structureMotionToken) + 1;
        junction.__structureGeometryEntering = false;
        junction.__structureExitFromHiddenEntry = false;
        clearStructureElementTimer(junction, '__structureMotionTimer');
        junction.removeAttribute('data-motion-state');
        junction.style.removeProperty('--structure-route-stagger');
        return;
      }
      if (!isNew && motionState === 'exit-fading' && junction.__structureExitFromHiddenEntry !== true) {
        junction.__structureMotionToken = safeNumber(junction.__structureMotionToken) + 1;
        const token = junction.__structureMotionToken;
        junction.__structureGeometryEntering = false;
        junction.__structureExitFromHiddenEntry = false;
        clearStructureElementTimer(junction, '__structureMotionTimer');
        junction.setAttribute('data-motion-state', 'active');
        junction.__structureMotionTimer = setTimer(() => {
          if (junction.__structureMotionToken !== token || !junction.parentNode) return;
          junction.removeAttribute('data-motion-state');
          junction.style.removeProperty('--structure-route-stagger');
          junction.__structureMotionTimer = null;
        }, STRUCTURE_NODE_REVEAL_MS);
        return;
      }
      // Preserve the token for a retained entering junction so its scheduled
      // activation can still complete after a rapid render.
      if (!isNew && !revivingExit) return;
      junction.__structureMotionToken = safeNumber(junction.__structureMotionToken) + 1;
      const token = junction.__structureMotionToken;
      junction.__structureExitFromHiddenEntry = false;
      clearStructureElementTimer(junction, '__structureMotionTimer');
      junction.style.setProperty('--structure-route-stagger', `${record.stagger}ms`);
      junction.removeAttribute('data-motion-state');
      junction.__structureGeometryEntering = false;
      if (initialRender) return;
      junction.__structureGeometryEntering = true;
      junction.setAttribute('data-motion-state', 'entering');
      afterStructurePaint(() => {
        if (junction.__structureMotionToken !== token || !junction.parentNode) return;
        junction.setAttribute('data-motion-state', 'active');
        junction.__structureMotionTimer = setTimer(() => {
          if (junction.__structureMotionToken === token && junction.parentNode) {
            junction.removeAttribute('data-motion-state');
            junction.style.removeProperty('--structure-route-stagger');
            junction.__structureGeometryEntering = false;
          }
          junction.__structureMotionTimer = null;
        }, STRUCTURE_GEOMETRY_ENTER_MS);
      });
    });
    existing.forEach((junction) => {
      if (reducedMotion) {
        clearStructureElementTimer(junction, '__structureMotionTimer');
        clearStructureElementTimer(junction, '__structureRemovalTimer');
        junction.__structureMotionToken = safeNumber(junction.__structureMotionToken) + 1;
        junction.__structureGeometryEntering = false;
        junction.__structureExitFromHiddenEntry = false;
        junction.remove();
        return;
      }
      if (junction.getAttribute('data-motion-state') === 'exit-fading'
        || junction.getAttribute('data-motion-state') === 'exiting') return;
      clearStructureElementTimer(junction, '__structureMotionTimer');
      junction.__structureMotionToken = safeNumber(junction.__structureMotionToken) + 1;
      const token = junction.__structureMotionToken;
      junction.__structureGeometryEntering = false;
      const targetButton = structureNodeButton(junction.dataset.targetId);
      junction.__structureExitFromHiddenEntry = structureNodeIsHiddenEntry(targetButton)
        || targetButton?.hasAttribute('data-exit-hidden') === true;
      const targetNode = junction.__structureTargetNode ?? structureNode(junction.dataset.targetId);
      const collapseOrigin = visibleStructureOrigin(
        targetNode,
        structureProjection.positions,
        structureProjection,
      );
      junction.style.setProperty('--structure-route-origin-x', `${collapseOrigin.x}px`);
      junction.style.setProperty('--structure-route-origin-y', `${collapseOrigin.y}px`);
      junction.setAttribute('data-motion-state', 'active');
      junction.getBoundingClientRect?.();
      junction.setAttribute('data-motion-state', 'exit-fading');
      junction.__structureRemovalTimer = setTimer(() => {
        if (destroyed || junction.__structureMotionToken !== token || !junction.parentNode) return;
        junction.setAttribute('data-motion-state', 'exiting');
        junction.__structureRemovalTimer = setTimer(() => {
          if (junction.__structureMotionToken === token) junction.remove();
          junction.__structureExitFromHiddenEntry = false;
          junction.__structureRemovalTimer = null;
        }, STRUCTURE_ROUTE_EXIT_MS);
      }, STRUCTURE_ROUTE_EXIT_MS);
    });
  }

  function renderStructureRoutes(semanticRoutes, {
    initialRender = false,
    reducedMotion = false,
    motionOriginById = new Map(),
  } = {}) {
    refs.mapSemanticEdges.replaceChildren();
    refs.mapSemanticJunctions.replaceChildren();
    refs.mapRelationLabels.replaceChildren();
    const desiredRoutes = new Map();
    const desiredJunctions = new Map();
    structureProjection.edges.forEach((edge, index) => {
      const source = structureProjection.positions.get(edge.source);
      const target = structureProjection.positions.get(edge.target);
      if (!source || !target) return;
      const sourceNode = structureProjection.nodes.find((node) => node.id === edge.source);
      const targetNode = structureProjection.nodes.find((node) => node.id === edge.target);
      const provider = providerForStructureNode(targetNode || sourceNode);
      const providerTrunk = edge.source === 'knowledge-core' && (edge.target === 'claude' || edge.target === 'codex');
      const layer = providerTrunk ? 'provider-trunk' : 'hierarchy';
      const points = radialStructurePolyline({ edge, source, target, center: structureProjection.center });
      const routeId = `${layer}:${edge.source}->${edge.target}`;
      const stagger = boundedStructureStagger(index);
      desiredRoutes.set(routeId, {
        layer, provider, points,
        sourceId: edge.source,
        targetId: edge.target,
        targetNode,
        entryOrigin: motionOriginById.get(edge.target) ?? { x: source.x, y: source.y },
        pointList: svgPointList(points),
        length: structurePolylineLength(points),
        stagger,
      });
      points.slice(1, -1).forEach((point, junctionIndex) => {
        desiredJunctions.set(`${routeId}:${junctionIndex}`, {
          routeId, point, layer, provider, stagger,
          sourceId: edge.source,
          targetId: edge.target,
          targetNode,
          entryOrigin: motionOriginById.get(edge.target) ?? { x: source.x, y: source.y },
        });
      });
    });
    reconcileStructureRoutes(desiredRoutes, initialRender, reducedMotion);
    reconcileStructureJunctions(desiredJunctions, initialRender, reducedMotion);
    if (!semanticRoutes.length) return;
    semanticRoutes.forEach(({ row, position, targetId, sourceId, sourcePosition, orbitLayer }, index) => {
      const routeSource = sourcePosition;
      if (!routeSource) return;
      const routeSourceId = sourceId || structureFocusId;
      const provider = orbitLayer === 'second-hop'
        ? providerForStructureNode(structureNode(row.relatedId) || { provider: row.relatedItem?.source?.provider })
        : providerForStructureNode(routeSourceId === structureSemanticAnchor?.id
          ? structureSemanticAnchor
          : structureNode(structureFocusId));
      const points = radialStructurePolyline({
        edge: { source: routeSourceId, target: targetId },
        source: routeSource, target: position, center: structureProjection.center,
      });
      refs.mapSemanticEdges.append(svgElement(doc, 'polyline', 'brain-structure-route', {
        points: svgPointList(points),
        'data-layer': 'semantic',
        'data-direction': row.direction,
        'data-provider': provider,
        'data-orbit-layer': literalText(orbitLayer, 'first-hop'),
        'data-source-id': routeSourceId,
        'data-target-id': targetId,
        'vector-effect': 'non-scaling-stroke',
      }));
      points.slice(1, -1).forEach((point) => refs.mapSemanticJunctions.append(svgElement(doc, 'rect', 'brain-structure-junction', {
        x: String(point.x - 4), y: String(point.y - 4), width: '8', height: '8',
        'data-layer': 'semantic', 'data-direction': row.direction,
        'data-provider': provider, 'data-orbit-layer': literalText(orbitLayer, 'first-hop'),
      })));
      const labelPoint = points[Math.max(1, Math.floor(points.length / 2))];
      if (labelPoint) {
        const label = svgElement(doc, 'text', 'brain-structure-route-label', {
          x: String(labelPoint.x), y: String(labelPoint.y - 10),
          'text-anchor': 'middle', 'data-layer': 'semantic', 'data-direction': row.direction,
          'data-provider': provider, 'data-orbit-layer': literalText(orbitLayer, 'first-hop'),
        });
        label.textContent = thaiRelation(row);
        refs.mapRelationLabels.append(label);
      }
    });
  }

  function updateStructureNodeButton(button, node) {
    const provider = providerForStructureNode(node);
    const role = roleForStructureNode(node);
    const counts = structureCounts(node);
    const isCore = node.id === 'knowledge-core';
    const isProvider = node.id === 'claude' || node.id === 'codex';
    const kindClass = isCore ? 'core' : isProvider ? 'provider' : node.kind;
    button.__structureNode = node;
    button.className = `brain-structure-node brain-structure-node-${kindClass}`;
    const labelOffsetX = Number(node.labelOffsetX);
    const labelOffsetY = Number(node.labelOffsetY);
    button.style.setProperty('--structure-label-offset-x', `${Number.isFinite(labelOffsetX) ? labelOffsetX : 0}px`);
    button.style.setProperty('--structure-label-offset-y', `${Number.isFinite(labelOffsetY) ? labelOffsetY : 0}px`);
    const expanded = isProvider || node.kind === 'dir'
      ? new Set(structureProjection?.expandedIds ?? []).has(node.id)
      : null;
    setAttributes(button, {
      'data-structure-id': node.id,
      'data-structure-node': 'true',
      'data-kind': isProvider ? 'provider' : node.kind,
      'data-provider': provider,
      'data-role': role,
      'data-depth': String(safeNumber(node.depth)),
      'data-orbit-layer': literalText(node.orbitLayer, 'context'),
      'data-label-side': node.labelSide || (provider === 'claude' ? 'right' : provider === 'codex' ? 'left' : 'bottom'),
      'aria-label': structureAccessibleName(node),
      'aria-pressed': String(node.id === structureFocusId),
      title: literalText(node.path, literalText(node.label, node.id)),
    });
    if (expanded == null) button.removeAttribute('aria-expanded');
    else button.setAttribute('aria-expanded', String(expanded));
    const mark = element(doc, 'span', 'brain-structure-node-mark');
    if (isProvider) {
      const logo = element(doc, 'img', 'brain-map-provider-logo');
      setAttributes(logo, { src: `/assets/brand/${provider}.svg`, alt: provider === 'claude' ? 'Claude' : 'Codex' });
      mark.append(logo);
    } else {
      mark.textContent = isCore ? 'AI' : node.kind === 'dir' ? '◇' : node.kind === 'file' ? '◆' : '+';
    }
    const label = isCore ? 'ศูนย์กลางความรู้' : isProvider ? `.${provider}` : literalText(node.label, node.id);
    const meta = isCore
      ? 'กดเพื่อรีเซ็ตโครงสร้าง'
      : isProvider || node.kind === 'dir'
        ? `${isProvider ? 'ผู้ให้บริการ' : 'โฟลเดอร์'} · ${counts.files} ไฟล์`
        : node.kind === 'file'
          ? `ไฟล์ · ${literalText(node.ext, 'ไม่มีนามสกุล')}`
          : 'แสดงชุดถัดไป';
    const contentKey = `${kindClass}\u0000${provider}\u0000${label}\u0000${meta}`;
    if (button.__structureContentKey !== contentKey) {
      button.replaceChildren(
        mark,
        element(doc, 'span', 'brain-structure-node-label', label),
        element(doc, 'span', 'brain-structure-node-meta', meta),
      );
      button.__structureContentKey = contentKey;
    }
    return button;
  }

  function makeStructureNodeButton(node) {
    const button = actionButton(doc, 'brain-structure-node', '', () => activateStructureNode(button.__structureNode));
    prepareStructureFocusButton(button);
    return updateStructureNodeButton(button, node);
  }

  function setStructureNodePosition(button, x, y, force = false) {
    const next = { x: safeNumber(x), y: safeNumber(y) };
    const previous = button.__structureTarget;
    if (!force && previous && previous.x === next.x && previous.y === next.y) return false;
    button.style.setProperty('--structure-x', `${next.x}px`);
    button.style.setProperty('--structure-y', `${next.y}px`);
    button.__structureTarget = next;
    return true;
  }

  function structureNodeIsEntering(button) {
    const state = button?.getAttribute('data-motion-state');
    return state === 'entering' || state === 'entering-geometry' || state === 'revealing';
  }

  function structureNodeIsHiddenEntry(button) {
    const state = button?.getAttribute('data-motion-state');
    return state === 'entering' || state === 'entering-geometry';
  }

  function revealStructureNode(button, token) {
    if (destroyed || button.__structureMotionToken !== token || !button.parentNode) return;
    button.setAttribute('data-motion-state', 'revealing');
    button.__structureMotionTimer = setTimer(() => {
      if (destroyed || button.__structureMotionToken !== token || !button.parentNode) return;
      button.setAttribute('data-motion-state', 'active');
      button.__structureMotionTimer = null;
    }, STRUCTURE_NODE_REVEAL_MS);
  }

  function beginStructureNodeEntry(button, origin) {
    clearStructureElementTimer(button, '__structureMotionTimer');
    clearStructureElementTimer(button, '__structureRemovalTimer');
    button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
    const token = button.__structureMotionToken;
    button.removeAttribute('data-exit-hidden');
    setStructureNodePosition(button, origin.x, origin.y, true);
    button.setAttribute('data-motion-state', 'entering');
    afterStructurePaint(() => {
      if (destroyed || button.__structureMotionToken !== token || !button.parentNode) return;
      const latest = button.__structureNode;
      setStructureNodePosition(button, latest.x, latest.y);
      button.setAttribute('data-motion-state', 'entering-geometry');
      button.__structureMotionTimer = setTimer(() => {
        if (destroyed || button.__structureMotionToken !== token || !button.parentNode) return;
        // The shared-origin crossing stays hidden. Reveal only after the keyed
        // node has reached its collision-safe final coordinate.
        revealStructureNode(button, token);
      }, STRUCTURE_GEOMETRY_ENTER_MS);
    });
  }

  function reverseStructureNodeExitFade(button) {
    clearStructureElementTimer(button, '__structureMotionTimer');
    clearStructureElementTimer(button, '__structureRemovalTimer');
    button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
    const token = button.__structureMotionToken;
    button.removeAttribute('data-exit-hidden');
    const latest = button.__structureNode;
    setStructureNodePosition(button, latest.x, latest.y);
    revealStructureNode(button, token);
  }

  function reconcileStructureNodes({
    initialRender = false,
    reducedMotion = false,
    entryGeometry = deriveStructureEntryGeometry(),
  } = {}) {
    const existing = new Map(Array.from(
      refs.mapNodes.querySelectorAll?.('button[data-structure-node="true"]') ?? [],
    ).map((button) => [button.dataset.structureId, button]));
    const { visibleBeforeReconciliation, entryOriginById } = entryGeometry;

    structureProjection.nodes.forEach((node, index) => {
      let button = existing.get(node.id);
      const isNew = !button;
      const previousMotionState = button?.getAttribute('data-motion-state');
      const previousExitHidden = button?.hasAttribute('data-exit-hidden') === true;
      const wasExiting = previousMotionState === 'exit-fading' || previousMotionState === 'exiting';
      if (!button) button = makeStructureNodeButton(node);
      else updateStructureNodeButton(button, node);
      existing.delete(node.id);
      clearStructureElementTimer(button, '__structureRemovalTimer');
      button.hidden = false;
      button.disabled = false;
      button.removeAttribute('aria-hidden');
      button.removeAttribute('tabindex');
      button.removeAttribute('data-shadowed-by-semantic-anchor');
      button.removeAttribute('data-exit-hidden');
      button.style.setProperty('--structure-stagger', `${boundedStructureStagger(index)}ms`);

      if (isNew) {
        const origin = entryOriginById.get(node.id)
          ?? visibleStructureOrigin(node, visibleBeforeReconciliation, structureProjection);
        refs.mapNodes.append(button);
        if (initialRender || reducedMotion) {
          clearStructureElementTimer(button, '__structureMotionTimer');
          button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
          button.setAttribute('data-motion-state', 'active');
          setStructureNodePosition(button, node.x, node.y, true);
        } else {
          beginStructureNodeEntry(button, origin);
        }
        return;
      }

      refs.mapNodes.append(button);
      if (reducedMotion) {
        clearStructureElementTimer(button, '__structureMotionTimer');
        button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
        button.setAttribute('data-motion-state', 'active');
        setStructureNodePosition(button, node.x, node.y);
        return;
      }
      if (wasExiting) {
        if (previousMotionState === 'exit-fading' && !previousExitHidden) {
          reverseStructureNodeExitFade(button);
          return;
        }
        const origin = visibleBeforeReconciliation.get(node.id)
          ?? currentStructureButtonPosition(button)
          ?? visibleStructureOrigin(node, visibleBeforeReconciliation, structureProjection);
        beginStructureNodeEntry(button, origin);
        return;
      }
      if (structureNodeIsEntering(button)) {
        if (button.getAttribute('data-motion-state') !== 'entering') {
          setStructureNodePosition(button, node.x, node.y);
        }
        return;
      }
      button.setAttribute('data-motion-state', 'active');
      setStructureNodePosition(button, node.x, node.y);
    });

    existing.forEach((button) => {
      if (button.dataset.structureId === structureSuppressedNodeId) {
        clearStructureElementTimer(button, '__structureMotionTimer');
        clearStructureElementTimer(button, '__structureRemovalTimer');
        button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
        button.remove();
        return;
      }
      if (reducedMotion) {
        clearStructureElementTimer(button, '__structureMotionTimer');
        clearStructureElementTimer(button, '__structureRemovalTimer');
        button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
        button.remove();
        return;
      }
      if (button.getAttribute('data-motion-state') === 'exit-fading'
        || button.getAttribute('data-motion-state') === 'exiting') return;
      const hideEntireExit = structureNodeIsHiddenEntry(button);
      clearStructureElementTimer(button, '__structureMotionTimer');
      button.__structureMotionToken = safeNumber(button.__structureMotionToken) + 1;
      const token = button.__structureMotionToken;
      const origin = visibleStructureOrigin(
        button.__structureNode,
        structureProjection.positions,
        structureProjection,
      );
      button.disabled = true;
      button.setAttribute('aria-hidden', 'true');
      button.setAttribute('tabindex', '-1');
      button.toggleAttribute('data-exit-hidden', hideEntireExit);
      button.setAttribute('data-motion-state', 'exit-fading');
      button.__structureRemovalTimer = setTimer(() => {
        if (destroyed || button.__structureMotionToken !== token || !button.parentNode) return;
        button.setAttribute('data-motion-state', 'exiting');
        setStructureNodePosition(button, origin.x, origin.y);
        button.__structureRemovalTimer = setTimer(() => {
          if (button.__structureMotionToken === token) button.remove();
          button.__structureRemovalTimer = null;
        }, STRUCTURE_NODE_EXIT_MS);
      }, STRUCTURE_NODE_EXIT_MS);
    });
  }

  function applyStructureUnderlayShadow() {
    for (const button of refs?.mapNodes.querySelectorAll?.('[data-shadowed-by-semantic-anchor="true"]') ?? []) {
      button.hidden = false;
      button.disabled = false;
      button.removeAttribute('aria-hidden');
      button.removeAttribute('tabindex');
      button.removeAttribute('data-shadowed-by-semantic-anchor');
    }
    if (!structureUnderlayShadowId) return;
    const button = structureNodeButton(structureUnderlayShadowId);
    if (!button) return;
    button.hidden = true;
    button.disabled = true;
    button.setAttribute('aria-hidden', 'true');
    button.setAttribute('tabindex', '-1');
    button.setAttribute('data-shadowed-by-semantic-anchor', 'true');
  }

  function renderStructureSemanticNodes() {
    for (const button of refs.mapNodes.querySelectorAll?.('button[data-structure-overlay="semantic"]') ?? []) {
      button.remove();
    }
    structureSemanticItems.forEach((item) => refs.mapNodes.append(makeStructureSemanticButton(item)));
  }

  function makeStructureSemanticButton(item) {
    const semanticItemId = plainText(item.semanticItemId ?? item.row?.relatedId);
    const isSelectedAnchor = item.orbitLayer === 'selected-semantic';
    const button = actionButton(doc, 'brain-structure-node brain-structure-node-semantic', '', () => {
      if (item.realNode) activateStructureNode(item.realNode);
      else if (semanticItemId) selectStructureSemanticItem(semanticItemId, item);
    });
    const semanticPath = item.realNode?.path
      ? `พาธ ${literalText(item.realNode.path, item.realNode.id)}`
      : 'ไม่มีพาธระบบไฟล์';
    setAttributes(button, {
      'data-structure-id': item.structureId,
      'data-structure-overlay': 'semantic',
      'data-kind': 'semantic',
      'data-provider': item.provider,
      'data-role': item.role,
      'data-depth': String(safeNumber(structureNode(structureFocusId)?.depth)
        + (item.orbitLayer === 'second-hop' ? 2 : 1)),
      'data-orbit-layer': literalText(item.orbitLayer, 'first-hop'),
      'data-label-side': item.labelSide || (item.x < structureGeometry.width / 2 ? 'right' : 'left'),
      'aria-label': isSelectedAnchor
        ? `ความรู้เชิงความหมายที่เลือก ${item.label}, ${semanticPath}, ผู้ให้บริการ ${structureProviderLabel({ provider: item.provider })}`
        : `ความสัมพันธ์ ${item.label}, ${thaiRelation(item.row)}, ${semanticPath}, ผู้ให้บริการ ${structureProviderLabel({ provider: item.provider })}`,
      'aria-pressed': String(isSelectedAnchor || semanticItemId === selectedId),
      title: item.label,
      style: `--structure-x:${item.x}px;--structure-y:${item.y}px;`,
    });
    button.append(
      element(doc, 'span', 'brain-structure-node-mark', isSelectedAnchor ? '◎' : '↔'),
      element(doc, 'span', 'brain-structure-node-label', item.label),
      element(doc, 'span', 'brain-structure-node-meta', isSelectedAnchor ? 'ความรู้ที่เลือก' : thaiRelation(item.row)),
    );
    return prepareStructureFocusButton(button);
  }

  function structureScrollPositions() {
    const scrollers = [...new Set([
      doc.scrollingElement,
      doc.documentElement,
      doc.body,
      refs?.pageEl,
      refs?.mapView,
      refs?.mapStage,
      refs?.mapBreadcrumb,
      refs?.mapRail,
    ].filter(Boolean))];
    return scrollers.map((scroller) => ({
      scroller,
      left: safeNumber(scroller.scrollLeft),
      top: safeNumber(scroller.scrollTop),
    }));
  }

  function invalidateStructureFocusTransactions({ clearAction = true } = {}) {
    structureFocusGeneration += 1;
    if (clearAction) structureActionScrollSnapshot = null;
    return structureFocusGeneration;
  }

  function clearStructurePointerCleanupTimer() {
    if (structurePointerCleanupTimer != null) clearTimer(structurePointerCleanupTimer);
    structurePointerCleanupTimer = null;
  }

  function clearStructureButtonSnapshots(button = null) {
    if (!button || structurePointerScrollSnapshot?.button === button) structurePointerScrollSnapshot = null;
    if (!button || structurePointerClickSnapshot?.button === button) structurePointerClickSnapshot = null;
    if (!button || structureKeyboardScrollSnapshot?.button === button) structureKeyboardScrollSnapshot = null;
    if (!button || structureActionScrollSnapshot?.button === button) structureActionScrollSnapshot = null;
    if (!button || structurePointerClickSnapshot == null) clearStructurePointerCleanupTimer();
  }

  function handleStructurePointerUp(event) {
    const pointer = structurePointerScrollSnapshot;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const releasedOnButton = event.target === pointer.button
      || pointer.button?.contains?.(event.target)
      || path.includes(pointer.button);
    structurePointerScrollSnapshot = null;
    structurePointerClickSnapshot = releasedOnButton
      ? { button: pointer.button, positions: pointer.positions }
      : null;
    clearStructurePointerCleanupTimer();
    if (!structurePointerClickSnapshot) return;
    const pending = structurePointerClickSnapshot;
    structurePointerCleanupTimer = setTimer(() => {
      if (structurePointerClickSnapshot === pending) structurePointerClickSnapshot = null;
      structurePointerCleanupTimer = null;
    }, 0);
  }

  function handleStructurePointerCancel(event) {
    if (structurePointerScrollSnapshot?.pointerId === event.pointerId) clearStructureButtonSnapshots();
  }

  function ensureStructurePointerListeners() {
    if (structurePointerListenersAttached || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('pointerup', handleStructurePointerUp, true);
    doc.addEventListener('pointercancel', handleStructurePointerCancel, true);
    structurePointerListenersAttached = true;
  }

  function beginStructureFocusTransaction({ useActionSnapshot = true } = {}) {
    const action = useActionSnapshot ? structureActionScrollSnapshot : null;
    structureActionScrollSnapshot = null;
    return {
      generation: invalidateStructureFocusTransactions({ clearAction: false }),
      positions: action?.positions ?? structureScrollPositions(),
    };
  }

  function prepareStructureFocusButton(button) {
    ensureStructurePointerListeners();
    button?.addEventListener?.('pointerdown', (event) => {
      invalidateStructureFocusTransactions();
      clearStructureButtonSnapshots();
      structurePointerScrollSnapshot = {
        button,
        pointerId: event.pointerId,
        positions: structureScrollPositions(),
      };
    });
    // Mouse buttons focus on mousedown, before their click handler can move
    // focus with preventScroll. Keep that native focus step from scrolling;
    // the click handler restores focus explicitly after reconciliation.
    button?.addEventListener?.('mousedown', (event) => event.preventDefault());
    button?.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      invalidateStructureFocusTransactions();
      clearStructureButtonSnapshots();
      structureKeyboardScrollSnapshot = { button, positions: structureScrollPositions() };
    });
    button?.addEventListener?.('click', (event) => {
      const keyboard = event.detail === 0;
      const pending = keyboard
        ? structureKeyboardScrollSnapshot
        : structurePointerClickSnapshot;
      const positions = pending?.button === button ? pending.positions : structureScrollPositions();
      invalidateStructureFocusTransactions();
      clearStructureButtonSnapshots(button);
      structureActionScrollSnapshot = { button, positions };
    }, true);
    button?.addEventListener?.('pointercancel', () => clearStructureButtonSnapshots(button));
    button?.addEventListener?.('contextmenu', () => clearStructureButtonSnapshots(button));
    button?.addEventListener?.('blur', () => {
      if (structurePointerScrollSnapshot?.button === button
        || structurePointerClickSnapshot?.button === button
        || structureKeyboardScrollSnapshot?.button === button
        || structureActionScrollSnapshot?.button === button) {
        clearStructureButtonSnapshots(button);
      }
    });
    // actionButton installs the activation listener first, so successful
    // focus handoffs consume the snapshot before this stale-state cleanup.
    button?.addEventListener?.('click', () => {
      clearStructureButtonSnapshots(button);
    });
    return button;
  }

  function focusStructureWithoutScroll(target, transaction = beginStructureFocusTransaction()) {
    if (!target || typeof target.focus !== 'function') return false;
    const restore = () => {
      if (destroyed || !refs || transaction.generation !== structureFocusGeneration) return;
      for (const position of transaction.positions) {
        if (position.scroller?.isConnected === false) continue;
        position.scroller.scrollLeft = position.left;
        position.scroller.scrollTop = position.top;
      }
    };
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
    // Restore even when the browser accepts preventScroll: older engines may
    // accept the option but still scroll a nested or document scroller. Two
    // paint frames also cover native click focus and scroll anchoring that run
    // after the click handler.
    restore();
    afterStructurePaint(restore);
    return true;
  }

  function centerStructureWorld({ moveFocus = false } = {}) {
    if (destroyed || !refs || !structureReady) return;
    clearStructureButtonSnapshots();
    const centerGeneration = invalidateStructureFocusTransactions();
    const center = () => {
      if (destroyed || !refs || !structureReady || centerGeneration !== structureFocusGeneration) return;
      const mapStage = refs.mapStage;
      const mapView = refs.mapView;
      const horizontalScroller = mapStage && safeNumber(mapStage.scrollWidth) > safeNumber(mapStage.clientWidth)
        ? mapStage
        : mapView;
      horizontalScroller.scrollLeft = Math.max(0, (
        safeNumber(horizontalScroller.scrollWidth) - safeNumber(horizontalScroller.clientWidth)
      ) / 2);
      const core = structureNodeButton('knowledge-core');
      const workspace = refs.pageEl;
      if (!core || !workspace || typeof core.getBoundingClientRect !== 'function') return;
      const workspaceRect = workspace.getBoundingClientRect?.();
      const coreRect = core.getBoundingClientRect();
      if (!workspaceRect || !Number.isFinite(coreRect.top)) return;
      if (safeNumber(workspace.scrollHeight) > safeNumber(workspace.clientHeight) + 1) {
        workspace.scrollTop += (coreRect.top - workspaceRect.top) + (coreRect.height / 2) - (workspace.clientHeight / 2);
      } else {
        const pageScroller = doc.scrollingElement;
        if (pageScroller) {
          pageScroller.scrollTop += (coreRect.top + (coreRect.height / 2)) - (globalThis.innerHeight / 2);
        }
      }
      if (moveFocus && centerGeneration === structureFocusGeneration) {
        focusStructureWithoutScroll(core, beginStructureFocusTransaction({ useActionSnapshot: false }));
      }
    };
    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame === 'function') requestFrame(center);
    else setTimer(center, 0);
  }

  function renderStructureGraph({ moveFocus = false, recenter = false } = {}) {
    if (!structureReady || !structureIndex || !refs) return;
    const focusTransaction = moveFocus && !recenter ? beginStructureFocusTransaction() : null;
    const projected = projectStructureGraph(structureIndex, {
      focusedId: structureFocusId,
      focusDepth,
      pageByParent: structurePageByParent,
      expandedProviders: structureExpandedProviders,
      expandedPathByProvider: structureExpandedPathByProvider,
    });
    updateStructureGeometry(structureAvailableWidth, projected.nodes.length);
    const layoutBounds = {
      width: structureGeometry.width,
      height: structureGeometry.height,
    };
    const laidOutProjection = layoutStructureGraph(projected, {
      ...layoutBounds,
    });
    const slotReservation = reserveStructureSemanticAnchorSlot(laidOutProjection, {
      selectedAnchor: focusRequestKind === 'structure-semantic' ? structureSemanticAnchor : null,
      structureFocusId,
    });
    structureProjection = slotReservation.projection;
    structureSuppressedNodeId = slotReservation.suppressedNodeId;
    structureUnderlayShadowId = slotReservation.shadowedNodeId;
    let semanticRoutes = [];
    if (structureFocusState === 'ready' && structureNode(structureFocusId)?.kind === 'file' && focusPayload) {
      const layers = semanticFocusLayers(
        focusPayload.items, focusPayload.relations, structureFocusId, focusDepth,
      );
      semanticRoutes = placeStructureSemantic(layers, structureProjection);
    } else if (focusRequestKind === 'structure-semantic' && structureSemanticAnchor) {
      const layers = structureFocusState === 'semantic' && focusPayload
        ? semanticFocusLayers(focusPayload.items, focusPayload.relations, selectedId, focusDepth)
        : { direct: { incoming: [], outgoing: [] }, secondHop: [] };
      semanticRoutes = placeStructureSemantic(layers, structureProjection, {
        semanticSelectedId: selectedId,
        selectedAnchor: structureSemanticAnchor,
      });
    } else {
      structureSemanticItems = [];
    }
    setStructurePresentation(true);
    renderStructureBreadcrumb();
    const initialRender = !structureHasRendered;
    const reducedMotion = structureMotionReduced();
    const entryGeometry = deriveStructureEntryGeometry(structureProjection);
    renderStructureRoutes(semanticRoutes, {
      initialRender,
      reducedMotion,
      motionOriginById: entryGeometry.motionOriginById,
    });
    reconcileStructureNodes({ initialRender, reducedMotion, entryGeometry });
    applyStructureUnderlayShadow();
    renderStructureSemanticNodes();
    structureHasRendered = true;
    const visibleStructureCount = Math.max(0,
      structureProjection.nodes.length - (structureUnderlayShadowId ? 1 : 0));
    const shadowedNodeIsReal = structureUnderlayShadowId
      && structureProjection.nodes.some((node) => node.id === structureUnderlayShadowId && node.synthetic !== true);
    const visible = visibleStructureCount + structureSemanticItems.length;
    const realVisible = structureProjection.nodes.filter((node) => node.synthetic !== true).length
      - (shadowedNodeIsReal ? 1 : 0);
    refs.mapCount.textContent = `แสดง ${visible} โหนดบนจอ · โครงสร้างจริง ${realVisible} จาก ${structureProjection.totalNodes} โหนดทั้งหมด · ดาวสัมพันธ์ ${structureSemanticItems.length}`;
    renderStructureRail();
    refs.mapView.removeAttribute('aria-busy');
    if (recenter) centerStructureWorld({ moveFocus });
    else if (moveFocus) focusStructureWithoutScroll(structureNodeButton(structureFocusId), focusTransaction);
  }

  function updateDepthControls() {
    for (const [depth, button] of refs?.depthButtons ?? []) {
      button.setAttribute('aria-pressed', String(depth === focusDepth));
    }
  }

  async function refreshSelectedFocusDepth(id, requestedDepth) {
    const requestKind = focusRequestKind;
    const previousPayload = focusPayload;
    const previousStructureState = structureFocusState;
    focusController?.abort();
    focusController = makeController();
    const requestId = ++focusRequestId;
    if (!previousPayload && structureReady) {
      structureFocusState = 'loading';
      refs.mapView.setAttribute('aria-busy', 'true');
      if (requestKind === 'structure-file') renderStructureGraph();
      else renderMapRailState('กำลังโหลดความสัมพันธ์ตามชั้นใหม่', 'กำลังอ่านความสัมพันธ์แบบจำกัดจากดัชนี Brain', 'loading');
    }
    try {
      const payload = await fetchPayload(brainFocusPath(id, requestedDepth), focusController);
      if (destroyed || requestId !== focusRequestId || selectedId !== id || focusDepth !== requestedDepth) return;
      if (!objectList(payload.items).some((item) => plainText(item.id) === id)) {
        throw new Error('focused item unavailable');
      }
      focusPayload = payload;
      if (structureReady) {
        structureFocusState = requestKind === 'structure-semantic' ? 'semantic' : 'ready';
        renderStructureGraph();
      } else {
        renderDetailsPayload(payload, id, false);
      }
    } catch {
      if (destroyed || requestId !== focusRequestId || selectedId !== id || focusDepth !== requestedDepth) return;
      focusPayload = previousPayload;
      if (structureReady) {
        structureFocusState = previousPayload
          ? previousStructureState
          : requestKind === 'structure-file' ? 'unavailable' : 'idle';
        renderStructureGraph();
        if (!previousPayload && requestKind === 'structure-semantic') {
          renderMapRailState('เปิดความสัมพันธ์ตามชั้นใหม่ไม่ได้', 'โครงสร้างเดิมยังอยู่และไม่มีการสร้างพาธขึ้นเอง', 'unavailable');
        } else {
          const notice = element(doc, 'p', 'brain-workflow-status', 'โหลดความสัมพันธ์ตามชั้นใหม่ไม่ได้ แผนที่และหลักฐานเดิมยังอยู่');
          setAttributes(notice, { role: 'status', 'aria-live': 'polite' });
          refs.mapRail?.append?.(notice);
        }
      } else if (previousPayload) {
        renderDetailsPayload(previousPayload, id, false);
        const notice = element(doc, 'p', 'brain-workflow-status', 'โหลดความสัมพันธ์ตามชั้นใหม่ไม่ได้ หลักฐานเดิมยังอยู่');
        setAttributes(notice, { role: 'status', 'aria-live': 'polite' });
        refs.mapRail?.append?.(notice);
      } else {
        renderDetailsUnavailable();
        refs.mapView.removeAttribute('aria-busy');
        renderMapRailState('เปิดความสัมพันธ์ตามชั้นใหม่ไม่ได้', 'เลือกโหนดอีกครั้งเพื่อลองใหม่', 'unavailable');
      }
    } finally {
      if (requestId === focusRequestId) focusController = null;
    }
  }

  function setFocusDepth(value) {
    const next = value === 2 ? 2 : 1;
    if (next === focusDepth) return;
    focusDepth = next;
    updateDepthControls();
    if (structureReady) renderStructureGraph();
    const hasCurrentSemanticFocus = Boolean(selectedId)
      && (focusPayload || focusController || structureFocusState === 'loading'
        || refs?.details?.hasAttribute?.('aria-busy') || refs?.mapView?.hasAttribute?.('aria-busy'));
    if (hasCurrentSemanticFocus && focusRequestKind !== 'idle') {
      refreshSelectedFocusDepth(selectedId, next);
    }
  }

  function clearStructureSemanticState() {
    focusController?.abort();
    focusController = null;
    focusRequestId += 1;
    focusPayload = null;
    selectedId = '';
    structureSemanticItems = [];
    structureSemanticAnchor = null;
    structureSuppressedNodeId = '';
    structureUnderlayShadowId = '';
    structureFocusState = 'idle';
    focusRequestKind = 'idle';
  }

  function resetStructureView() {
    if (!structureReady) return;
    clearStructureSemanticState();
    structureFocusId = '';
    structurePageByParent = new Map();
    structureExpandedProviders = new Set(['claude', 'codex']);
    structureExpandedPathByProvider = new Map(MAP_PROVIDERS.map((provider) => [provider, []]));
    renderStructureGraph({ moveFocus: true, recenter: true });
  }

  function focusStructureAncestor(id) {
    const node = structureNode(id);
    if (!node) return;
    if (node.kind === 'file') {
      selectStructureFile(node);
      return;
    }
    activateStructureNode(node);
  }

  function activateStructureNode(node) {
    if (!node || !structureReady) return;
    if (node.id === 'knowledge-core') {
      resetStructureView();
      return;
    }
    if (node.kind === 'more') {
      const focusTransaction = beginStructureFocusTransaction();
      structurePageByParent.set(node.parentId, { offset: safeNumber(node.offset) });
      renderStructureGraph();
      focusStructureWithoutScroll(structureNodeButton(node.parentId), focusTransaction);
      return;
    }
    if (node.id === 'claude' || node.id === 'codex') {
      clearStructureSemanticState();
      structureFocusId = node.id;
      if (structureExpandedProviders.has(node.id)) {
        structureExpandedProviders.delete(node.id);
        setStructureProviderPath(node.id, []);
      } else {
        structureExpandedProviders.add(node.id);
        structurePageByParent.set(node.id, 0);
        setStructureProviderPath(node.id, []);
      }
      renderStructureGraph({ moveFocus: true });
      return;
    }
    if (node.kind === 'dir') {
      clearStructureSemanticState();
      const realPath = realStructureDirectoryPath(node.id);
      if (!realPath) return;
      const currentPath = structureProviderPath(realPath.provider);
      const expandedIndex = currentPath.indexOf(node.id);
      structureFocusId = node.id;
      structureExpandedProviders.add(realPath.provider);
      if (expandedIndex >= 0) {
        setStructureProviderPath(realPath.provider, currentPath.slice(0, expandedIndex));
      } else {
        setStructureProviderPath(realPath.provider, realPath.path);
        structurePageByParent.set(node.id, 0);
      }
      renderStructureGraph({ moveFocus: true });
      return;
    }
    if (node.kind === 'file') selectStructureFile(node);
  }

  async function selectStructureFile(node) {
    if (!node || destroyed || !refs) return;
    focusController?.abort();
    focusController = makeController();
    const requestId = ++focusRequestId;
    focusRequestKind = 'structure-file';
    structureSemanticAnchor = null;
    structureFocusId = node.id;
    selectedId = node.id;
    focusPayload = null;
    structureSemanticItems = [];
    structureFocusState = 'loading';
    refs.mapView.setAttribute('aria-busy', 'true');
    renderStructureGraph({ moveFocus: true });
    try {
      const requestedDepth = focusDepth;
      const payload = await fetchPayload(brainFocusPath(node.id, requestedDepth), focusController);
      if (destroyed || requestId !== focusRequestId || structureFocusId !== node.id || focusDepth !== requestedDepth) return;
      const selected = objectList(payload.items).find((item) => plainText(item.id) === node.id);
      if (!selected) throw new Error('focused item unavailable');
      focusPayload = payload;
      structureFocusState = 'ready';
      renderStructureGraph({ moveFocus: true });
    } catch {
      if (destroyed || requestId !== focusRequestId || structureFocusId !== node.id) return;
      focusPayload = null;
      structureFocusState = 'unavailable';
      renderStructureGraph({ moveFocus: true });
    } finally {
      if (requestId === focusRequestId) focusController = null;
    }
  }

  async function selectStructureSemanticItem(value, anchorHint = null) {
    const id = plainText(value);
    if (!id || destroyed || !refs) return;
    const capturedHint = anchorHint
      ?? structureSemanticItems.find((item) => plainText(item.semanticItemId ?? item.row?.relatedId) === id)
      ?? (structureSemanticAnchor?.semanticItemId === id ? structureSemanticAnchor : null);
    structureSemanticAnchor = makeStructureSemanticAnchor(id, capturedHint);
    focusController?.abort();
    focusController = makeController();
    const requestId = ++focusRequestId;
    focusRequestKind = 'structure-semantic';
    selectedId = id;
    focusPayload = null;
    structureSemanticItems = [];
    structureFocusState = 'loading';
    // Reconcile immediately so the clicked semantic satellite becomes the
    // selected synthetic anchor while its neighborhood request is in flight.
    // This preserves the filesystem projection and current scroll position.
    renderStructureGraph();
    try {
      const requestedDepth = focusDepth;
      const payload = await fetchPayload(brainFocusPath(id, requestedDepth), focusController);
      if (destroyed || requestId !== focusRequestId || selectedId !== id || focusDepth !== requestedDepth) return;
      if (!objectList(payload.items).some((item) => plainText(item.id) === id)) throw new Error('focused item unavailable');
      const selected = objectList(payload.items).find((item) => plainText(item.id) === id);
      structureSemanticAnchor = makeStructureSemanticAnchor(id, structureSemanticAnchor, selected);
      focusPayload = payload;
      structureFocusState = 'semantic';
      const focusTransaction = beginStructureFocusTransaction({ useActionSnapshot: false });
      renderStructureGraph();
      focusStructureWithoutScroll(refs.mapRail.querySelector?.('.brain-map-focus-title'), focusTransaction);
    } catch {
      if (destroyed || requestId !== focusRequestId || selectedId !== id) return;
      structureFocusState = 'idle';
      const focusTransaction = beginStructureFocusTransaction({ useActionSnapshot: false });
      renderStructureGraph();
      renderMapRailState('เปิดรายการที่เกี่ยวข้องไม่ได้', 'โครงสร้างไฟล์เดิมยังคงแสดงอยู่และไม่มีการสร้างพาธขึ้นเอง', 'unavailable');
      focusStructureWithoutScroll(structureNodeButton(structureFocusId) ?? refs.mapTitle, focusTransaction);
    } finally {
      if (requestId === focusRequestId) focusController = null;
    }
  }

  function handleStructureEscape(event) {
    if (event.key !== 'Escape' || viewMode !== 'map' || !structureReady || !structureFocusId) return;
    const selected = structureNode(structureFocusId);
    const provider = providerForStructureNode(selected);
    const path = structureProviderPath(provider);
    if (!MAP_PROVIDERS.includes(provider) || !path.length) return;
    event.preventDefault();
    clearStructureSemanticState();
    structureFocusId = path.at(-1);
    setStructureProviderPath(provider, path.slice(0, -1));
    renderStructureGraph({ moveFocus: true });
  }

  function appendStructureUnavailableNotice() {
    if (!refs?.mapRail || structureReady || structurePayload?.unavailable !== true) return;
    if (refs.mapRail.querySelector?.('.brain-structure-unavailable-notice')) return;
    const notice = element(doc, 'section', 'brain-map-rail-state brain-map-rail-state-unavailable brain-structure-unavailable-notice');
    notice.append(
      element(doc, 'p', 'brain-section-label', 'โครงสร้างไฟล์'),
      element(doc, 'h3', 'brain-map-rail-title', 'ยังเปิดโครงสร้างจริงไม่ได้'),
      element(doc, 'p', 'brain-quiet-copy', 'กำลังใช้แผนที่ความรู้แบบจำกัดแทน เพราะ /api/graph ว่างหรือไม่พร้อมใช้งาน'),
    );
    refs.mapRail.append(notice);
  }

  async function requestStructure() {
    if (destroyed || !refs) return;
    structureController?.abort();
    structureController = makeController();
    const requestId = ++structureRequestId;
    try {
      const payload = await fetchPayload(STRUCTURE_GRAPH_ENDPOINT, structureController);
      if (destroyed || requestId !== structureRequestId) return;
      const index = indexStructureGraph(payload);
      const hasProviders = ['claude', 'codex'].every((provider) => {
        const root = index.nodesById.get(provider);
        return root?.kind === 'dir' && providerForStructureNode(root) === provider;
      });
      if (!hasProviders) throw new Error('structure roots unavailable');
      structurePayload = payload;
      structureIndex = index;
      structureReady = true;
      structureFocusId = '';
      structurePageByParent = new Map();
      structureExpandedProviders = new Set(['claude', 'codex']);
      structureExpandedPathByProvider = new Map(MAP_PROVIDERS.map((provider) => [provider, []]));
      structureHasRendered = false;
      structureFocusState = 'idle';
      renderStructureGraph({ recenter: true });
    } catch {
      if (destroyed || requestId !== structureRequestId) return;
      structurePayload = { unavailable: true };
      structureIndex = null;
      structureProjection = null;
      structureReady = false;
      structureSemanticItems = [];
      renderMapItems();
      appendStructureUnavailableNotice();
    } finally {
      if (requestId === structureRequestId) structureController = null;
    }
  }

  function renderMapCenter() {
    if (!refs?.mapCenter || structureReady) return;
    const selected = selectedFocusItem();
    refs.mapCenter.hidden = false;
    refs.mapCenter.setAttribute('aria-label', selected
      ? `ศูนย์กลางความรู้ กำลังเลือก ${itemTitle(selected)}`
      : 'ศูนย์กลางความรู้ ประสาน .claude และ .codex');
    refs.mapCenter.replaceChildren(
      element(doc, 'span', 'brain-map-center-symbol', 'AI'),
      element(doc, 'strong', 'brain-map-center-title', 'ศูนย์กลางความรู้'),
      element(doc, 'span', 'brain-map-center-kicker', 'ประสาน .claude + .codex'),
    );
  }

  function renderMapRailState(title, body, kind = 'empty') {
    if (!refs?.mapRail) return;
    refs.mapRail.setAttribute('data-state', kind);
    const state = element(doc, 'section', `brain-map-rail-state brain-map-rail-state-${kind}`);
    setAttributes(state, { role: 'status', 'aria-live': 'polite' });
    state.append(
      element(doc, 'p', 'brain-section-label', 'ความเชื่อมโยง'),
      element(doc, 'h3', 'brain-map-rail-title', title),
      element(doc, 'p', 'brain-quiet-copy', body),
    );
    refs.mapRail.replaceChildren(state);
    appendStructureUnavailableNotice();
  }

  function updateMapSelection() {
    if (!refs?.mapNodes) return;
    if (structureReady) {
      for (const button of refs.mapNodes.querySelectorAll?.('button[data-structure-node="true"]') ?? []) {
        button.setAttribute('aria-pressed', String(button.dataset.structureId === structureFocusId));
      }
      return;
    }
    for (const button of refs.mapNodes.querySelectorAll?.('button[data-map-item-id]') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.mapItemId === selectedId));
    }
    renderMapCenter();
  }

  function makeMapRelationGroup(heading, rows) {
    const section = element(doc, 'section', 'brain-map-relation-group');
    section.append(element(doc, 'h4', 'brain-map-relation-heading', heading));
    if (!rows.length) {
      section.append(element(doc, 'p', 'brain-map-relation-empty', 'ไม่มีความเชื่อมโยงในทิศทางนี้'));
      return section;
    }
    for (const row of rows) {
      const relatedTitle = itemTitle(row.relatedItem, plainText(row.relatedId) || 'รายการที่เกี่ยวข้อง');
      const relation = row.relatedItem
        ? actionButton(doc, 'brain-map-relation-row', '', () => selectItem(row.relatedItem.id))
        : element(doc, 'div', 'brain-map-relation-row');
      setAttributes(relation, {
        'data-direction': row.direction,
        'data-related-id': row.relatedId,
      });
      relation.append(
        element(doc, 'span', 'brain-map-relation-direction', row.direction === 'incoming' ? 'เชื่อมเข้ารายการนี้' : 'เชื่อมออกจากรายการนี้'),
        element(doc, 'strong', 'brain-map-relation-item', relatedTitle),
        element(doc, 'span', 'brain-map-relation-label', thaiRelation(row)),
      );
      section.append(relation);
    }
    return section;
  }

  function renderProviderTopology() {
    if (!refs?.mapOwnershipEdges || !refs.mapProviderRoots) return;
    refs.mapOwnershipEdges.replaceChildren();
    refs.mapOwnershipJunctions.replaceChildren();
    for (const provider of MAP_PROVIDERS) {
      const root = MAP_PROVIDER_ROOTS[provider];
      const providerItems = mapItems.filter((item) => item?.source?.provider === provider
        && mapPositions.has(plainText(item.id)));
      const count = refs.mapProviderCounts.get(provider);
      if (count) count.textContent = `${providerItems.length} รายการ`;
      const trunk = routePolyline({
        edge: { source: 'knowledge-core', target: provider },
        source: { x: 50, y: 50 },
        target: root,
        sourceRadius: 8,
        targetRadius: 5,
        layout: 'hex',
      });
      refs.mapOwnershipEdges.append(svgElement(doc, 'polyline', 'brain-map-provider-link brain-map-provider-trunk', {
        points: svgPointList(trunk),
        'data-provider': provider,
        'vector-effect': 'non-scaling-stroke',
      }));
      providerItems.forEach((item, index) => {
        const position = mapPositions.get(plainText(item.id));
        const points = routePolyline({
          edge: { source: provider, target: plainText(item.id) },
          source: root,
          target: position,
          sourceRadius: 5,
          targetRadius: 1.8,
          layout: 'hex',
          laneIndex: index,
        });
        refs.mapOwnershipEdges.append(svgElement(doc, 'polyline', 'brain-map-provider-link', {
          points: svgPointList(points),
          'data-provider': provider,
          'vector-effect': 'non-scaling-stroke',
        }));
        const junction = points[1];
        if (junction) refs.mapOwnershipJunctions.append(svgElement(doc, 'rect', 'brain-map-provider-junction', {
          x: String(junction.x - .45), y: String(junction.y - .45), width: '.9', height: '.9',
          transform: `rotate(45 ${junction.x} ${junction.y})`, 'data-provider': provider,
        }));
      });
    }
  }

  function clearMapSemanticSatellites() {
    for (const button of refs?.mapNodes?.querySelectorAll?.('[data-map-semantic-layer]') ?? []) {
      button.remove();
    }
    for (const button of refs?.mapNodes?.querySelectorAll?.('[data-shadowed-by-semantic-layer="true"]') ?? []) {
      button.hidden = false;
      button.removeAttribute('aria-hidden');
      button.removeAttribute('data-shadowed-by-semantic-layer');
    }
  }

  function renderMapSemanticLayerNodes(layers, id, items) {
    clearMapSemanticSatellites();
    const positions = mapSemanticLayerPositions(layers, id, mapPositions);
    const byId = new Map(objectList(items).map((item) => [plainText(item.id), item]));
    positions.shadowBaseIds.forEach((itemId) => {
      const existing = mapNodeById(itemId);
      if (!existing) return;
      existing.hidden = true;
      existing.setAttribute('aria-hidden', 'true');
      existing.setAttribute('data-shadowed-by-semantic-layer', 'true');
    });
    const appendOverlay = (itemId, position, layer) => {
      const item = byId.get(itemId);
      if (!item) return;
      const existing = mapNodeById(itemId);
      if (layer === 'second-hop' && existing) {
        existing.hidden = true;
        existing.setAttribute('aria-hidden', 'true');
        existing.setAttribute('data-shadowed-by-semantic-layer', 'true');
      }
      const provider = plainText(item.source?.provider).toLocaleLowerCase();
      const button = actionButton(doc, `brain-map-node brain-map-node-${layer}`, '', () => selectItem(itemId));
      setAttributes(button, {
        'data-map-item-id': itemId,
        'data-map-semantic-layer': layer,
        'data-orbit-layer': layer,
        'data-provider': provider,
        'data-type': plainText(item.type).toLocaleLowerCase(),
        'aria-label': `${itemTitle(item)}, ${layer === 'second-hop' ? 'ชั้นความสัมพันธ์ที่ 2' : 'ชั้นความสัมพันธ์ที่ 1'}, .${provider}`,
        'aria-pressed': String(itemId === selectedId),
        title: `${itemTitle(item)} · ${layer === 'second-hop' ? 'ชั้นที่ 2' : 'ชั้นที่ 1'}`,
        style: `--map-x:${position.x}%;--map-y:${position.y}%;`,
      });
      button.append(
        element(doc, 'span', 'brain-map-node-code', layer === 'second-hop' ? '2' : '1'),
        element(doc, 'span', `brain-map-node-provider brain-map-node-provider-${provider}`, `.${provider}`),
        element(doc, 'span', 'brain-map-node-title', itemTitle(item)),
      );
      refs.mapNodes.append(button);
    };
    positions.firstHop.forEach((entry, itemId) => {
      if (!entry.reusedBase) appendOverlay(itemId, entry.position, 'first-hop');
    });
    positions.secondHop.forEach((position, itemId) => appendOverlay(itemId, position, 'second-hop'));
    return positions;
  }

  function renderMapFocus(payload, id) {
    if (structureReady || !refs?.mapSemanticEdges || !refs.mapRail) return;
    const items = objectList(payload.items);
    const selected = items.find((item) => plainText(item.id) === id) ?? null;
    if (!selected) return;
    const layers = semanticFocusLayers(items, objectList(payload.relations), id, focusDepth);
    const focused = layers.direct;
    refs.mapRail.removeAttribute('data-state');
    refs.mapSemanticEdges.replaceChildren();
    refs.mapSemanticJunctions.replaceChildren();
    refs.mapRelationLabels.replaceChildren();
    const layerPositions = renderMapSemanticLayerNodes(layers, id, items);
    const selectedPosition = layerPositions.selectedPosition;

    [...focused.incoming, ...focused.outgoing].forEach((row, index) => {
      const position = layerPositions.firstHop.get(row.relatedId)?.position;
      if (!selectedPosition || !position || row.relatedId === id) return;
      const points = routePolyline({
        edge: { source: id, target: row.relatedId },
        source: selectedPosition,
        target: position,
        sourceRadius: 2.2,
        targetRadius: 2.2,
        layout: 'rings',
        geom: { cx: 50, cy: 50 },
        laneIndex: index,
      });
      refs.mapSemanticEdges.append(svgElement(doc, 'polyline', 'brain-map-link', {
        points: svgPointList(points),
        'data-direction': row.direction,
        'vector-effect': 'non-scaling-stroke',
      }));
      points.slice(1, -1).forEach((point) => refs.mapSemanticJunctions.append(svgElement(doc, 'rect', 'brain-map-semantic-junction', {
        x: String(point.x - .55), y: String(point.y - .55), width: '1.1', height: '1.1',
        transform: `rotate(45 ${point.x} ${point.y})`, 'data-direction': row.direction,
      })));
      const labelPoint = points[Math.max(1, Math.floor(points.length / 2))];
      if (labelPoint) {
        const label = svgElement(doc, 'text', 'brain-map-route-label', {
          x: String(labelPoint.x), y: String(labelPoint.y - 1.2), 'text-anchor': 'middle',
          'data-direction': row.direction,
        });
        label.textContent = thaiRelation(row);
        refs.mapRelationLabels.append(label);
      }
    });

    layers.secondHop.forEach((row, index) => {
      const source = layerPositions.firstHop.get(row.parentId)?.position;
      const target = layerPositions.secondHop.get(row.relatedId);
      if (!source || !target) return;
      const provider = plainText(row.relatedItem?.source?.provider).toLocaleLowerCase();
      const points = routePolyline({
        edge: { source: row.parentId, target: row.relatedId },
        source,
        target,
        sourceRadius: 2.2,
        targetRadius: 2.2,
        layout: 'rings',
        geom: { cx: 50, cy: 50 },
        laneIndex: index,
      });
      refs.mapSemanticEdges.append(svgElement(doc, 'polyline', 'brain-map-link', {
        points: svgPointList(points),
        'data-direction': row.direction,
        'data-provider': provider,
        'data-orbit-layer': 'second-hop',
        'data-source-id': row.parentId,
        'data-target-id': row.relatedId,
        'vector-effect': 'non-scaling-stroke',
      }));
      points.slice(1, -1).forEach((point) => refs.mapSemanticJunctions.append(svgElement(doc, 'rect', 'brain-map-semantic-junction', {
        x: String(point.x - .55), y: String(point.y - .55), width: '1.1', height: '1.1',
        transform: `rotate(45 ${point.x} ${point.y})`,
        'data-direction': row.direction, 'data-provider': provider, 'data-orbit-layer': 'second-hop',
      })));
    });

    const header = element(doc, 'header', 'brain-map-focus-header');
    header.append(
      element(doc, 'p', 'brain-section-label', `${thaiType(selected.type)} · ${thaiStatus(selected.status)} · .${plainText(selected.source?.provider)}`),
      element(doc, 'h3', 'brain-map-focus-title', itemTitle(selected)),
      element(doc, 'p', 'brain-map-focus-summary', itemSummary(selected)),
      actionButton(doc, 'brain-resume-trigger', 'ทำงานต่อจากตรงนี้', () => openResumeForItem(selected.id)),
    );
    header.querySelector?.('.brain-map-focus-title')?.setAttribute('tabindex', '-1');
    const railParts = [
      header,
      makeMapRelationGroup('เส้นทางที่เชื่อมเข้า', focused.incoming),
      makeMapRelationGroup('เส้นทางที่เชื่อมออก', focused.outgoing),
    ];
    const secondRows = uniqueSemanticEndpoints(layers.secondHop)
      .filter((row) => layerPositions.secondHop.has(row.relatedId));
    if (secondRows.length) railParts.push(makeMapRelationGroup('ชั้นที่ 2 · ผ่านรายการชั้นแรก', secondRows));
    refs.mapRail.replaceChildren(...railParts);
    refs.mapView.removeAttribute('aria-busy');
    updateMapSelection();
    appendStructureUnavailableNotice();
  }

  function renderMapItems() {
    if (!refs?.mapNodes) return;
    if (structureReady) {
      renderStructureGraph();
      return;
    }
    if (structureRequestId > 0 && structurePayload == null) {
      setStructurePresentation(true);
      refs.mapBreadcrumb.replaceChildren();
      refs.mapNodes.replaceChildren();
      refs.mapOwnershipEdges.replaceChildren();
      refs.mapOwnershipJunctions.replaceChildren();
      refs.mapSemanticEdges.replaceChildren();
      refs.mapSemanticJunctions.replaceChildren();
      refs.mapRelationLabels.replaceChildren();
      refs.mapCount.textContent = 'กำลังอ่านโครงสร้างจริงจาก .claude และ .codex';
      renderMapRailState('กำลังโหลดโครงสร้างไฟล์', 'กำลังสร้างมุมมองแบบอ่านอย่างเดียวจาก /api/graph', 'loading');
      return;
    }
    setStructurePresentation(false);
    mapPositions = mapItemPositions(mapItems);
    refs.mapNodes.replaceChildren();
    for (const item of mapItems) {
      const id = plainText(item.id);
      const position = mapPositions.get(id);
      if (!position) continue;
      const button = actionButton(doc, 'brain-map-node', '', () => selectItem(id));
      setAttributes(button, {
        'data-map-item-id': id,
        'data-type': position.band.type,
        'aria-label': `${itemTitle(item)}, ${position.band.label}, .${position.provider}`,
        'aria-pressed': String(id === selectedId),
        title: `${itemTitle(item)} · ${position.band.label}`,
        style: `--map-x:${position.x}%;--map-y:${position.y}%;`,
      });
      button.append(
        element(doc, 'span', 'brain-map-node-code', position.band.code),
        element(doc, 'span', `brain-map-node-provider brain-map-node-provider-${position.provider}`, `.${position.provider}`),
        element(doc, 'span', 'brain-map-node-title', itemTitle(item)),
      );
      refs.mapNodes.append(button);
    }
    const mapTotal = safeNumber(mapPayload?.page?.total ?? mapPositions.size);
    refs.mapCount.textContent = `แสดง ${mapPositions.size} จาก ${mapTotal} รายการ · สูงสุด 6 รายการต่อประเภทต่อผู้ให้บริการ`;
    renderProviderTopology();
    if (focusPayload && selectedId) renderMapFocus(focusPayload, selectedId);
    else {
      updateMapSelection();
      renderMapRailState('เลือกความรู้', 'เลือกโหนดเพื่อเน้นเส้นทางและดูความเชื่อมโยงที่มีป้ายกำกับ');
    }
    appendStructureUnavailableNotice();
  }

  async function requestMap() {
    if (destroyed || !refs) return;
    mapController?.abort();
    mapController = makeController();
    const requestId = ++mapRequestId;
    refs.mapView.setAttribute('aria-busy', 'true');
    try {
      const payload = await fetchPayload(`${BRAIN_ENDPOINT}?view=map`, mapController);
      if (destroyed || requestId !== mapRequestId) return;
      mapPayload = payload;
      mapItems = objectList(payload.items).slice(0, 84);
      refs.mapView.removeAttribute('aria-busy');
      renderMapItems();
    } catch {
      if (destroyed || requestId !== mapRequestId) return;
      refs.mapView.removeAttribute('aria-busy');
      mapPayload = null;
      mapItems = [];
      renderMapItems();
      renderMapRailState('โหลดแผนที่ความรู้ไม่ได้', 'ลองเปิดหน้านี้ใหม่อีกครั้ง ข้อมูลต้นฉบับไม่ได้ถูกแก้ไข', 'unavailable');
    } finally {
      if (requestId === mapRequestId) mapController = null;
    }
  }

  function setDrawerOpen(nextOpen, { moveFocus = false } = {}) {
    if (!refs) return;
    drawerOpen = viewMode === 'map' && Boolean(nextOpen);
    refs.pageEl.setAttribute('data-drawer-open', String(drawerOpen));
    refs.mapDrawerToggle.setAttribute('aria-expanded', String(drawerOpen));
    refs.mapDrawerToggle.textContent = drawerOpen ? 'ปิดคลังความรู้' : 'เปิดคลังความรู้';
    refs.discovery.inert = viewMode === 'map' && !drawerOpen;
    refs.content.inert = viewMode === 'map' && !drawerOpen;
    refs.discovery.setAttribute('aria-hidden', String(viewMode === 'map' && !drawerOpen));
    refs.content.setAttribute('aria-hidden', String(viewMode === 'map' && !drawerOpen));
    if (moveFocus && drawerOpen) refs.search.focus?.();
  }

  function setViewMode(nextMode, { focusListToggle = false } = {}) {
    if (!refs) return;
    viewMode = nextMode === 'map' ? 'map' : 'list';
    refs.content.hidden = false;
    refs.mapView.hidden = viewMode !== 'map';
    refs.today.hidden = viewMode === 'map';
    refs.discovery.hidden = false;
    refs.pageEl.setAttribute('data-view-mode', viewMode);
    refs.listViewButton.setAttribute('aria-pressed', String(viewMode === 'list'));
    refs.mapViewButton.setAttribute('aria-pressed', String(viewMode === 'map'));
    moveDeckToCurrentMode();
    if (viewMode === 'map') {
      setDrawerOpen(false);
      renderMapItems();
      if (!structureReady && !mapPayload && !mapController) requestMap();
    } else {
      drawerOpen = false;
      refs.pageEl.setAttribute('data-drawer-open', 'false');
      refs.discovery.inert = false;
      refs.content.inert = false;
      refs.discovery.setAttribute('aria-hidden', 'false');
      refs.content.setAttribute('aria-hidden', 'false');
    }
    if (focusListToggle) refs.listViewButton.focus?.();
  }

  function updateSelectedButtons() {
    if (!refs) return;
    for (const button of refs.resultList.querySelectorAll?.('button[data-item-id]') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.itemId === selectedId));
    }
    updateMapSelection();
  }

  function renderDetailsPayload(payload, id, moveFocus) {
    const items = objectList(payload.items);
    const selected = items.find((item) => plainText(item.id) === id) ?? null;
    if (!selected) throw new Error('focused item unavailable');
    focusPayload = payload;
    replaceDetails(makeDetails(doc, selected, items, objectList(payload.relations), selectItem, openResumeForItem));
    renderMapFocus(payload, id);
    updateSelectedButtons();
    if (moveFocus && viewMode === 'map') {
      (mapNodeById(id) ?? refs.mapRail.querySelector?.('.brain-map-focus-title'))?.focus?.();
    } else if (moveFocus) refs.details.querySelector?.('.brain-detail-title')?.focus?.();
  }

  function renderDetailsUnavailable() {
    const section = element(doc, 'section', 'brain-detail-state');
    setAttributes(section, { role: 'status', 'aria-live': 'polite' });
    section.append(
      element(doc, 'p', 'brain-section-label', 'รายละเอียด'),
      element(doc, 'h2', 'brain-empty-title', 'เปิดรายละเอียดไม่ได้'),
      element(doc, 'p', 'brain-quiet-copy', 'เลือกรายการอีกครั้งเพื่อลองโหลดความสัมพันธ์ใหม่'),
    );
    refs.details.removeAttribute('aria-busy');
    refs.details.replaceChildren(section);
  }

  async function selectItem(value) {
    const id = plainText(value);
    if (!id || destroyed || !refs) return;
    if (viewMode === 'map' && structureReady) {
      const node = structureNode(id);
      if (node) activateStructureNode(node);
      else selectStructureSemanticItem(id);
      return;
    }
    selectedId = id;
    focusPayload = null;
    if (viewMode === 'map' && drawerOpen) setDrawerOpen(false);
    const selectedPosition = mapPositions.get(id);
    refs.mapRail.setAttribute('data-side', selectedPosition?.x > 62 ? 'left' : 'right');
    updateSelectedButtons();
    refs.mapSemanticEdges.replaceChildren();
    refs.mapSemanticJunctions.replaceChildren();
    refs.mapRelationLabels.replaceChildren();
    clearMapSemanticSatellites();
    refs.mapView.setAttribute('aria-busy', 'true');
    renderMapRailState('กำลังโหลดความเชื่อมโยง', 'กำลังอ่านมุมมองความสัมพันธ์แบบจำกัดจากเครื่องนี้', 'loading');
    focusController?.abort();
    focusController = makeController();
    const requestId = ++focusRequestId;
    focusRequestKind = 'fallback';
    refs.details.setAttribute('aria-busy', 'true');
    try {
      const requestedDepth = focusDepth;
      const payload = await fetchPayload(brainFocusPath(id, requestedDepth), focusController);
      if (destroyed || requestId !== focusRequestId || focusDepth !== requestedDepth) return;
      renderDetailsPayload(payload, id, true);
    } catch {
      if (destroyed || requestId !== focusRequestId) return;
      renderDetailsUnavailable();
      refs.mapSemanticEdges.replaceChildren();
      refs.mapSemanticJunctions.replaceChildren();
      refs.mapRelationLabels.replaceChildren();
      refs.mapView.removeAttribute('aria-busy');
      renderMapRailState('เปิดความเชื่อมโยงไม่ได้', 'เลือกโหนดอีกครั้งเพื่อลองโหลดความสัมพันธ์ใหม่', 'unavailable');
    }
  }

  function renderToday(payload) {
    const today = payload?.today && typeof payload.today === 'object' && !Array.isArray(payload.today)
      ? payload.today
      : {};
    const continueWorking = today.continueWorking
      && typeof today.continueWorking === 'object'
      && !Array.isArray(today.continueWorking)
      ? today.continueWorking
      : null;
    const decisions = objectList(today.recentDecisions).slice(0, 3);
    const attention = objectList(today.needsAttention).slice(0, 3);
    const counts = summaryCounts(payload);
    refs.todayMeta.textContent = `${counts.items} รายการที่จัดหมวดแล้ว · ${counts.needsAttention} รายการต้องตรวจสอบ`;
    refs.todayGrid.replaceChildren(
      compactItem(doc, 'ทำงานต่อ', continueWorking, selectItem, 'ไม่มีโปรเจกต์หรืองานที่กำลังทำ', openResumeForItem),
      compactList(doc, 'การตัดสินใจล่าสุด', decisions, selectItem, 'ยังไม่มีการตัดสินใจในดัชนี'),
      compactList(doc, 'ต้องตรวจสอบ', attention, selectItem, 'ไม่มีรายการติดขัดหรือรอทำ'),
    );
    for (const [label, type] of Object.entries(CATEGORY_TYPE)) {
      const countKey = TYPE_COUNT_KEY[type];
      refs.categoryButtons.get(label).textContent = `${label} ${counts[countKey] ?? 0}`;
    }
  }

  function renderPagination() {
    const visible = listItems.length;
    const start = visible ? page.offset + 1 : 0;
    const end = visible ? page.offset + visible : 0;
    refs.pageStatus.textContent = page.total
      ? `แสดง ${start}–${end} จาก ${page.total}`
      : '0 รายการ';
    refs.pagePrev.hidden = page.offset <= 0;
    refs.pagePrev.disabled = page.offset <= 0;
    refs.pageNext.hidden = !page.hasMore;
    refs.pageNext.disabled = !page.hasMore;
  }

  function renderListPayload(payload) {
    listPayload = payload;
    listItems = objectList(payload.items).slice(0, BRAIN_PAGE_LIMIT);
    const rawPage = payload.page && typeof payload.page === 'object' ? payload.page : {};
    page = {
      total: safeNumber(rawPage.total ?? listItems.length),
      offset: safeNumber(rawPage.offset ?? offset),
      limit: Math.min(BRAIN_PAGE_LIMIT, safeNumber(rawPage.limit) || BRAIN_PAGE_LIMIT),
      hasMore: rawPage.hasMore === true,
    };
    offset = page.offset;
    refs.results.removeAttribute('aria-busy');
    refs.listTitle.textContent = category === 'ทั้งหมด' ? 'ความรู้ทั้งหมด' : category;
    refs.resultCount.textContent = `${page.total} รายการ`;
    refs.resultList.replaceChildren();

    if (!listItems.length) {
      const entry = element(doc, 'li', 'brain-result-entry');
      const empty = element(doc, 'section', 'brain-list-empty');
      const isEmptyIndex = page.total === 0 && !plainText(query) && category === 'ทั้งหมด';
      empty.append(
        element(doc, 'h3', 'brain-empty-title', isEmptyIndex ? 'ยังไม่มีความรู้ในดัชนี' : 'ไม่พบความรู้ที่ตรงกัน'),
        element(doc, 'p', 'brain-quiet-copy', isEmptyIndex
          ? 'เพิ่มโน้ต Markdown ที่อนุญาตใน .claude หรือ .codex แล้วลองใหม่'
          : 'ลองค้นหาให้กว้างขึ้น หรือเลือกหมวดเดิมอีกครั้งเพื่อแสดงทั้งหมด'),
      );
      entry.append(empty);
      refs.resultList.append(entry);
    } else {
      for (const item of listItems) {
        const entry = element(doc, 'li', 'brain-result-entry');
        const button = actionButton(doc, 'brain-result-item', '', () => selectItem(item.id));
        button.setAttribute('data-item-id', plainText(item.id));
        button.setAttribute('aria-pressed', String(plainText(item.id) === selectedId));
        button.append(
          element(doc, 'span', 'brain-result-type', thaiType(item.type)),
          element(doc, 'strong', 'brain-result-title', itemTitle(item)),
          element(doc, 'span', 'brain-result-summary', itemSummary(item)),
          element(doc, 'span', 'brain-item-meta', `${thaiStatus(item.status)} · .${plainText(item.source?.provider)} · ${formatDate(item.updatedAt)}`),
        );
        entry.append(button);
        refs.resultList.append(entry);
      }
    }
    renderPagination();
  }

  function renderListUnavailable() {
    refs.results.removeAttribute('aria-busy');
    const entry = element(doc, 'li', 'brain-result-entry');
    const state = element(doc, 'section', 'brain-list-empty');
    setAttributes(state, { role: 'status', 'aria-live': 'polite' });
    state.append(
      element(doc, 'h3', 'brain-empty-title', 'เปิดรายการความรู้ไม่ได้'),
      element(doc, 'p', 'brain-quiet-copy', 'ลองค้นหาหรือเลือกหมวดอีกครั้ง โน้ตในเครื่องไม่ได้ถูกแก้ไข'),
    );
    entry.append(state);
    refs.resultList.replaceChildren(entry);
  }

  function updateCategoryState() {
    for (const [label, button] of refs.categoryButtons) {
      button.setAttribute('aria-pressed', String(category === label));
    }
  }

  function restoreFocus(target) {
    if (!refs || !target) return;
    if (target.kind === 'search') refs.search.focus?.();
    if (target.kind === 'category') refs.categoryButtons.get(target.label)?.focus?.();
    if (target.kind === 'paging') {
      const preferred = target.direction === 'next' ? refs.pageNext : refs.pagePrev;
      const fallback = target.direction === 'next' ? refs.pagePrev : refs.pageNext;
      if (!preferred.hidden && !preferred.disabled) preferred.focus?.();
      else if (!fallback.hidden && !fallback.disabled) fallback.focus?.();
      else refs.listTitle.focus?.();
    }
  }

  async function requestList({ initial = false, focusTarget = null } = {}) {
    if (destroyed) return;
    listController?.abort();
    listController = makeController();
    const requestId = ++listRequestId;
    if (refs) refs.results.setAttribute('aria-busy', 'true');
    try {
      const payload = await fetchPayload(brainListPath({ query, category, offset }), listController);
      if (destroyed || requestId !== listRequestId) return;
      if (!refs) createWorkspace(payload);
      else renderListPayload(payload);
      restoreFocus(focusTarget);
    } catch {
      if (destroyed || requestId !== listRequestId) return;
      if (initial || !refs) renderUnavailable();
      else {
        renderListUnavailable();
        restoreFocus(focusTarget);
      }
    }
  }

  function createActionDeck() {
    const actionDeck = element(doc, 'section', 'brain-action-deck');
    actionDeck.setAttribute('aria-label', 'เครื่องมือทำงานกับ Second Brain');
    const head = element(doc, 'header', 'brain-action-deck-head');
    head.append(
      element(doc, 'p', 'brain-section-label', 'ACTION DECK // LOCAL ONLY'),
      element(doc, 'h2', 'brain-action-deck-title', 'ทำงานต่อด้วยหลักฐานในเครื่อง'),
    );
    const tabList = element(doc, 'div', 'brain-action-tabs');
    setAttributes(tabList, { role: 'tablist', 'aria-label': 'เลือกเครื่องมือ Second Brain' });
    const actionTabs = new Map();
    const actionPanels = new Map();
    const tabs = [
      ['resume', 'ทำงานต่อ'],
      ['inbox', 'กล่องเข้า'],
      ['ask', 'ถาม Brain'],
      ['gaps', 'Claude ↔ Codex'],
    ];
    tabs.forEach(([name, label]) => {
      const button = actionButton(doc, 'brain-action-tab', label, () => setActionTab(name));
      setAttributes(button, {
        id: `brain-action-tab-${name}`,
        role: 'tab',
        'aria-controls': `brain-action-panel-${name}`,
      });
      actionTabs.set(name, button);
      tabList.append(button);
      const panel = element(doc, 'div', 'brain-action-panel');
      setAttributes(panel, {
        id: `brain-action-panel-${name}`,
        role: 'tabpanel',
        'aria-labelledby': `brain-action-tab-${name}`,
      });
      actionPanels.set(name, panel);
    });
    tabList.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const names = tabs.map(([name]) => name);
      const current = Math.max(0, names.indexOf(activeDeckTab));
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setActionTab(names[(current + step + names.length) % names.length], { moveFocus: true });
    });

    const resumePanel = actionPanels.get('resume');
    workflowStatus(resumePanel, 'เลือกงานเพื่อทำต่อ', 'เลือกงานที่ Today รายละเอียด หรือรางแผนที่ แล้วกด “ทำงานต่อจากตรงนี้”');

    const inboxPanel = actionPanels.get('inbox');
    workflowStatus(inboxPanel, 'เปิดกล่องเข้าเมื่อต้องการ', 'ระบบจะเทียบความรู้ใหม่กับเวลาที่คุณกดตรวจแล้วครั้งล่าสุด');

    const askPanel = actionPanels.get('ask');
    const askForm = element(doc, 'form', 'brain-ask-form');
    const askLabel = element(doc, 'label', 'brain-workflow-field');
    askLabel.append(element(doc, 'span', 'brain-section-label', 'คำถามของคุณ'));
    const askInput = element(doc, 'input', 'brain-workflow-input');
    askInput.type = 'search';
    setAttributes(askInput, {
      maxlength: '160',
      autocomplete: 'off',
      placeholder: 'เช่น งานไหนติดขัดในโปรเจกต์เว็บไซต์',
    });
    askLabel.append(askInput);
    const providerLabel = element(doc, 'label', 'brain-workflow-field');
    providerLabel.append(element(doc, 'span', 'brain-section-label', 'แหล่งความรู้'));
    const askProvider = element(doc, 'select', 'brain-workflow-select');
    [['all', 'ทั้งหมด'], ['claude', 'Claude'], ['codex', 'Codex']].forEach(([value, label]) => {
      const option = element(doc, 'option', '', label);
      option.value = value;
      askProvider.append(option);
    });
    providerLabel.append(askProvider);
    askInput.addEventListener('input', cancelPendingAskForEdit);
    askProvider.addEventListener('change', cancelPendingAskForEdit);
    const submit = element(doc, 'button', 'brain-workflow-button brain-workflow-button-primary', 'ค้นหาใน Brain');
    submit.type = 'submit';
    askForm.append(askLabel, providerLabel, submit);
    askForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAsk();
    });
    const askNote = element(doc, 'p', 'brain-index-scope', 'ค้นหาจากดัชนีในเครื่องแบบกำหนดผลลัพธ์ ไม่ใช่คำตอบจาก AI ระยะไกล');
    const askResults = element(doc, 'div', 'brain-ask-output');
    workflowStatus(askResults, 'พร้อมค้นหา', 'คำตอบทุกชุดจะแสดงพาธอ้างอิงจริงจาก Claude หรือ Codex');
    askPanel.append(askForm, askNote, askResults);

    const gapPanel = actionPanels.get('gaps');
    workflowStatus(gapPanel, 'เปิดรายการที่ควรตรวจสอบ', 'ระบบจะโหลดข้อเสนอแนะเมื่อเปิดแท็บนี้ โดยไม่มีการซิงก์อัตโนมัติ');
    actionDeck.append(head, tabList, ...actionPanels.values());
    return {
      actionDeck, actionTabs, actionPanels, resumePanel, inboxPanel,
      askPanel, askInput, askProvider, askResults, gapPanel,
    };
  }

  function createWorkspace(initialPayload) {
    const pageEl = element(doc, 'main', 'brain-workspace');
    pageEl.append(makePageHeader(doc));

    const today = element(doc, 'section', 'brain-today');
    const todayHead = element(doc, 'header', 'brain-section-head');
    const todayMeta = element(doc, 'p', 'brain-section-meta');
    todayHead.append(element(doc, 'div', '', 'วันนี้'), todayMeta);
    const todayGrid = element(doc, 'div', 'brain-today-grid');
    today.append(todayHead, todayGrid);
    const actionDeckParts = createActionDeck();

    const discovery = element(doc, 'section', 'brain-discovery');
    discovery.id = 'brain-memory-discovery';
    const searchLabel = element(doc, 'label', 'brain-search-label', 'ค้นหาความรู้');
    const search = element(doc, 'input', 'brain-search');
    search.type = 'search';
    setAttributes(search, {
      placeholder: 'ค้นหาโปรเจกต์ การตัดสินใจ งาน บุคคล และโน้ต…',
      autocomplete: 'off', maxlength: '120',
      'aria-label': 'ค้นหาโปรเจกต์ การตัดสินใจ งาน บุคคล และโน้ต',
    });
    search.addEventListener('input', () => {
      query = String(search.value ?? '').slice(0, 120);
      offset = 0;
      if (searchTimer != null) clearTimer(searchTimer);
      searchTimer = setTimer(() => {
        searchTimer = null;
        requestList({ focusTarget: { kind: 'search' } });
      }, SEARCH_DEBOUNCE_MS);
    });
    searchLabel.append(search);
    discovery.append(searchLabel);
    discovery.append(element(
      doc,
      'p',
      'brain-index-scope',
      'นับเฉพาะความรู้ที่ตั้งใจเก็บ · ไม่รวมปลั๊กอิน แคช ไฟล์ชั่วคราว หรือเช็กลิสต์ในคู่มือ',
    ));

    const categories = element(doc, 'div', 'brain-categories');
    categories.setAttribute('aria-label', 'หมวดหมู่ความรู้');
    const categoryButtons = new Map();
    for (const label of Object.keys(CATEGORY_TYPE)) {
      const button = actionButton(doc, 'brain-category', label, () => {
        category = category === label ? 'ทั้งหมด' : label;
        offset = 0;
        updateCategoryState();
        requestList({ focusTarget: { kind: 'category', label } });
      });
      button.setAttribute('data-category', label);
      button.setAttribute('aria-pressed', 'false');
      categoryButtons.set(label, button);
      categories.append(button);
    }
    discovery.append(categories);

    const viewBar = element(doc, 'div', 'brain-view-bar');
    viewBar.append(element(doc, 'span', 'brain-view-label', 'มุมมอง'));
    const viewSwitch = element(doc, 'div', 'brain-view-switch');
    setAttributes(viewSwitch, { role: 'group', 'aria-label': 'เลือกมุมมองความรู้' });
    const listViewButton = actionButton(doc, 'brain-view-option', 'รายการ', () => setViewMode('list'));
    const mapViewButton = actionButton(doc, 'brain-view-option', 'แผนที่', () => setViewMode('map'));
    setAttributes(listViewButton, { 'aria-pressed': 'false', 'data-view': 'list' });
    setAttributes(mapViewButton, { 'aria-pressed': 'true', 'data-view': 'map' });
    viewSwitch.append(listViewButton, mapViewButton);
    viewBar.append(viewSwitch);
    discovery.append(viewBar);

    const content = element(doc, 'div', 'brain-content');
    content.id = 'brain-memory-results';
    const results = element(doc, 'section', 'brain-results');
    const listHead = element(doc, 'header', 'brain-list-head');
    const listTitle = element(doc, 'h2', 'brain-list-title', 'ความรู้ทั้งหมด');
    listTitle.setAttribute('tabindex', '-1');
    const resultCount = element(doc, 'span', 'brain-result-count');
    listHead.append(listTitle, resultCount);
    const resultList = element(doc, 'ul', 'brain-result-list');
    resultList.setAttribute('aria-label', 'ผลลัพธ์ความรู้');
    const pagination = element(doc, 'nav', 'brain-pagination');
    pagination.setAttribute('aria-label', 'หน้ารายการความรู้');
    const pagePrev = actionButton(doc, 'btn brain-page-prev', 'ก่อนหน้า', () => {
      if (page.offset <= 0) return;
      offset = Math.max(0, page.offset - BRAIN_PAGE_LIMIT);
      requestList({ focusTarget: { kind: 'paging', direction: 'prev' } });
    });
    const pageStatus = element(doc, 'span', 'brain-page-status');
    const pageNext = actionButton(doc, 'btn btn-accent brain-page-next', 'แสดงเพิ่ม', () => {
      if (!page.hasMore) return;
      offset = page.offset + BRAIN_PAGE_LIMIT;
      requestList({ focusTarget: { kind: 'paging', direction: 'next' } });
    });
    pagination.append(pagePrev, pageStatus, pageNext);
    results.append(listHead, resultList, pagination);

    const details = element(doc, 'aside', 'brain-details');
    setAttributes(details, { 'aria-label': 'รายละเอียดรายการ', 'aria-live': 'polite' });
    content.append(results, details);

    const mapView = element(doc, 'section', 'brain-map-view');
    mapView.hidden = true;
    setAttributes(mapView, { 'aria-label': 'แผนที่ความรู้เชิงความหมาย' });
    const interruptStructureFocusRestore = () => {
      clearStructureButtonSnapshots();
      invalidateStructureFocusTransactions();
    };
    mapView.addEventListener('pointerdown', interruptStructureFocusRestore, true);
    mapView.addEventListener('wheel', interruptStructureFocusRestore, { capture: true, passive: true });
    const mapHead = element(doc, 'header', 'brain-map-head');
    const mapHeading = element(doc, 'div', 'brain-map-heading');
    const systemLine = element(doc, 'div', 'brain-map-systemline');
    const mapSystemStatus = element(doc, 'span', 'brain-map-system-status', 'ระบบเชื่อมโยงความรู้พร้อมใช้งาน');
    const mapSystemCode = element(doc, 'span', 'brain-map-system-code', 'BBN // ศูนย์ความรู้ในเครื่อง');
    systemLine.append(
      mapSystemStatus,
      mapSystemCode,
    );
    const mapTitle = element(doc, 'h2', 'brain-map-title', 'BIGNOSE OS');
    mapTitle.setAttribute('tabindex', '-1');
    mapHeading.append(
      systemLine,
      mapTitle,
    );
    const mapCount = element(doc, 'p', 'brain-map-count');
    const mapActions = element(doc, 'div', 'brain-map-actions');
    const depthControls = element(doc, 'div', 'brain-depth-controls');
    setAttributes(depthControls, { role: 'group', 'aria-label': 'จำนวนชั้นความสัมพันธ์ที่แสดง' });
    const depthButtons = new Map();
    [1, 2].forEach((depth) => {
      const button = actionButton(doc, 'brain-depth-button', `${depth} ชั้น`, () => setFocusDepth(depth));
      button.setAttribute('aria-pressed', String(depth === focusDepth));
      depthButtons.set(depth, button);
      depthControls.append(button);
    });
    const mapZoomControls = element(doc, 'div', 'brain-map-zoom-controls');
    setAttributes(mapZoomControls, { role: 'group', 'aria-label': 'ปรับขนาดแผนที่' });
    const mapZoomOut = actionButton(doc, 'brain-map-zoom-button', '− ย่อ', () => {
      setStructureZoom(structureZoomPercent - STRUCTURE_ZOOM_STEP);
    });
    mapZoomOut.setAttribute('aria-label', 'ย่อแผนที่ลง 10 เปอร์เซ็นต์');
    const mapZoomReset = actionButton(doc, 'brain-map-zoom-reset', `${STRUCTURE_ZOOM_DEFAULT}% · รีเซ็ต`, () => {
      setStructureZoom(STRUCTURE_ZOOM_DEFAULT);
    });
    const mapZoomIn = actionButton(doc, 'brain-map-zoom-button', '+ ขยาย', () => {
      setStructureZoom(structureZoomPercent + STRUCTURE_ZOOM_STEP);
    });
    mapZoomIn.setAttribute('aria-label', 'ขยายแผนที่ขึ้น 10 เปอร์เซ็นต์');
    mapZoomControls.append(mapZoomOut, mapZoomReset, mapZoomIn);
    const mapDrawerToggle = actionButton(doc, 'btn btn-accent brain-map-drawer-toggle', 'เปิดคลังความรู้', () => {
      setDrawerOpen(!drawerOpen, { moveFocus: !drawerOpen });
    });
    setAttributes(mapDrawerToggle, {
      'aria-expanded': 'false',
      'aria-controls': 'brain-memory-discovery brain-memory-results',
    });
    const mapBack = actionButton(doc, 'btn brain-map-back', 'กลับหน้ารายการ', () => setViewMode('list', { focusListToggle: true }));
    mapActions.append(depthControls, mapZoomControls, mapDrawerToggle, mapBack);
    mapHead.append(mapHeading, mapCount, mapActions);

    const mapBreadcrumb = element(doc, 'nav', 'brain-structure-breadcrumb');
    mapBreadcrumb.hidden = true;
    mapBreadcrumb.setAttribute('aria-label', 'เส้นทางโครงสร้างความรู้');

    const mapLayout = element(doc, 'div', 'brain-map-layout');
    const mapStage = element(doc, 'div', 'brain-map-stage');
    setAttributes(mapStage, { role: 'region', 'aria-label': 'โหนดความรู้เรียงในวงความหมายเจ็ดชั้น แยก Claude และ Codex' });
    const mapStars = element(doc, 'div', 'brain-map-stars');
    const mapSvg = svgElement(doc, 'svg', 'brain-map-svg', {
      viewBox: '0 0 100 100',
      preserveAspectRatio: 'xMidYMid meet',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    const mapRings = svgElement(doc, 'g', 'brain-map-rings');
    const mapOwnershipEdges = svgElement(doc, 'g', 'brain-map-ownership-edges');
    const mapOwnershipJunctions = svgElement(doc, 'g', 'brain-map-ownership-junctions');
    const mapSemanticEdges = svgElement(doc, 'g', 'brain-map-semantic-edges');
    const mapSemanticJunctions = svgElement(doc, 'g', 'brain-map-semantic-junctions');
    const mapRelationLabels = svgElement(doc, 'g', 'brain-map-route-labels');
    const mapBandLabels = svgElement(doc, 'g', 'brain-map-band-labels');
    const mapHud = svgElement(doc, 'g', 'brain-map-hud');
    mapHud.append(
      svgElement(doc, 'line', 'brain-map-hud-axis', { x1: '2', y1: '50', x2: '98', y2: '50' }),
      svgElement(doc, 'line', 'brain-map-hud-axis', { x1: '50', y1: '2', x2: '50', y2: '98' }),
      svgElement(doc, 'circle', 'brain-map-hud-arc brain-map-hud-arc-outer', { cx: '50', cy: '50', r: '49' }),
      svgElement(doc, 'circle', 'brain-map-hud-arc brain-map-hud-arc-mid', { cx: '50', cy: '50', r: '43.5' }),
      svgElement(doc, 'circle', 'brain-map-hud-arc brain-map-hud-arc-core', { cx: '50', cy: '50', r: '11' }),
    );
    for (const band of MAP_BANDS) {
      mapRings.append(svgElement(doc, 'circle', 'brain-map-ring', {
        cx: '50', cy: '50', r: String(band.radius), 'data-type': band.type,
      }));
      const label = svgElement(doc, 'text', 'brain-map-band-label', {
        x: '50', y: String(50 - band.radius), 'data-type': band.type, 'text-anchor': 'middle',
      });
      label.textContent = band.label;
      mapBandLabels.append(label);
    }
    mapSvg.append(
      mapHud, mapRings, mapOwnershipEdges, mapOwnershipJunctions,
      mapSemanticEdges, mapSemanticJunctions, mapRelationLabels, mapBandLabels,
    );
    const mapCenter = element(doc, 'div', 'brain-map-center');
    const mapProviderRoots = element(doc, 'div', 'brain-map-provider-roots');
    const mapProviderCounts = new Map();
    for (const provider of MAP_PROVIDERS) {
      const root = element(doc, 'article', `brain-map-provider-root brain-map-provider-root-${provider}`);
      setAttributes(root, {
        'data-provider': provider,
        'aria-label': `แหล่งความรู้ .${provider}`,
      });
      const logo = element(doc, 'img', 'brain-map-provider-logo');
      setAttributes(logo, { src: `/assets/brand/${provider}.svg`, alt: provider === 'claude' ? 'Claude' : 'Codex' });
      const count = element(doc, 'span', 'brain-map-provider-count', '0 รายการ');
      mapProviderCounts.set(provider, count);
      root.append(
        logo,
        element(doc, 'strong', 'brain-map-provider-name', `.${provider}`),
        count,
      );
      mapProviderRoots.append(root);
    }
    const mapNodes = element(doc, 'div', 'brain-map-nodes');
    setAttributes(mapNodes, { role: 'group', 'aria-label': 'โหนดแผนที่ความรู้' });
    const mapTelemetry = element(doc, 'div', 'brain-map-telemetry');
    const mapTelemetryIndex = element(doc, 'span', 'brain-map-telemetry-item brain-map-telemetry-index', 'ดัชนี // ในเครื่อง');
    const mapTelemetryMode = element(doc, 'span', 'brain-map-telemetry-item brain-map-telemetry-mode', 'โหมด // อ่านอย่างเดียว');
    const mapTelemetryLink = element(doc, 'span', 'brain-map-telemetry-item brain-map-telemetry-link', 'เส้นเชื่อม // เชิงความหมาย');
    mapTelemetry.append(
      mapTelemetryIndex,
      mapTelemetryMode,
      mapTelemetryLink,
    );
    const mapWorldSpace = element(doc, 'div', 'brain-map-world-space');
    const mapWorld = element(doc, 'div', 'brain-map-world');
    mapWorld.append(mapStars, mapSvg, mapCenter, mapProviderRoots, mapNodes, mapTelemetry);
    mapWorldSpace.append(mapWorld);
    mapStage.append(mapWorldSpace);
    const mapRail = element(doc, 'aside', 'brain-map-rail');
    setAttributes(mapRail, { 'aria-label': 'ความเชื่อมโยงของรายการที่เลือก', 'aria-live': 'polite' });
    mapLayout.append(mapStage, mapRail);
    mapView.append(mapHead, mapBreadcrumb, mapLayout);

    pageEl.append(today, actionDeckParts.actionDeck, discovery, content, mapView);
    rootEl.replaceChildren(pageEl);

    refs = {
      pageEl, today, todayGrid, todayMeta, discovery, search, categories, categoryButtons,
      viewBar, listViewButton, mapViewButton,
      content, results, listTitle, resultCount, resultList, pagination,
      pagePrev, pageNext, pageStatus, details,
      mapView, mapCount, mapBack, mapDrawerToggle, depthControls, depthButtons,
      mapZoomControls, mapZoomOut, mapZoomReset, mapZoomIn,
      mapLayout, mapStage, mapWorldSpace, mapWorld,
      mapSvg, mapHud, mapRings, mapBandLabels, mapBreadcrumb,
      mapTitle, mapSystemStatus, mapSystemCode,
      mapTelemetryIndex, mapTelemetryMode, mapTelemetryLink,
      mapOwnershipEdges, mapOwnershipJunctions, mapSemanticEdges, mapSemanticJunctions,
      mapRelationLabels, mapCenter, mapProviderRoots, mapProviderCounts, mapNodes, mapRail,
      ...actionDeckParts,
    };
    structureKeydownTarget = mapView;
    structureKeydownTarget.addEventListener('keydown', handleStructureEscape);
    updateCategoryState();
    updateActionTab();
    updateDepthControls();
    updateStructureZoomControls();
    renderToday(initialPayload);
    renderListPayload(initialPayload);
    renderEmptyDetails();
    requestStructure();
    setViewMode('map');
    observeStructureGeometry();
  }

  function renderUnavailable() {
    refs = null;
    const retry = actionButton(doc, 'btn btn-accent brain-retry', 'ลองอีกครั้ง', () => requestList({ initial: true }));
    rootEl.replaceChildren(makeState(
      doc,
      'unavailable',
      'เปิดสมองที่สองไม่ได้',
      'ตรวจสอบว่าโปรแกรมดูข้อมูลในเครื่องกำลังทำงาน แล้วลองอีกครั้ง โน้ตของคุณไม่ได้ถูกแก้ไข',
      retry,
    ));
  }

  rootEl.replaceChildren(makeState(
    doc,
    'loading',
    'กำลังโหลดความรู้ในเครื่อง…',
    'กำลังอ่านดัชนีที่ปลอดภัยจากคอมพิวเตอร์เครื่องนี้',
  ));
  requestList({ initial: true });
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      invalidateStructureFocusTransactions();
      clearStructureButtonSnapshots();
      if (structurePointerListenersAttached) {
        doc.removeEventListener?.('pointerup', handleStructurePointerUp, true);
        doc.removeEventListener?.('pointercancel', handleStructurePointerCancel, true);
        structurePointerListenersAttached = false;
      }
      if (searchTimer != null) clearTimer(searchTimer);
      listController?.abort();
      focusController?.abort();
      mapController?.abort();
      structureController?.abort();
      resumeController?.abort();
      inboxController?.abort();
      askController?.abort();
      gapController?.abort();
      refreshController?.abort();
      structureResizeObserver?.disconnect?.();
      structureResizeObserver = null;
      structureKeydownTarget?.removeEventListener('keydown', handleStructureEscape);
      structureKeydownTarget = null;
      rootEl.replaceChildren();
    },
  };
}
