// Pure, bounded projection of the scanner's filesystem tree.

export const ROOT_CHILD_LIMIT = 10;
export const FOCUS_CHILD_LIMIT = 14;
export const SIBLING_CONTEXT_LIMIT = 4;
export const SEMANTIC_LIMIT = 12;
export const VISIBLE_NODE_LIMIT = 40;

const PROVIDERS = new Set(['claude', 'codex']);
const RINGS = new Set(['core', 'skills', 'memory', 'routines', 'applications']);
const collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });

function text(value) { return typeof value === 'string' ? value : ''; }
function idOf(value) { return text(value).trim(); }
function providerValue(value) { return PROVIDERS.has(value) ? value : 'unified'; }
function nodeKind(node) { return node?.kind === 'dir' || node?.kind === 'directory' ? 'dir' : 'file'; }
function isSynthetic(node) { return node?.synthetic === true || node?.kind === 'more' || node?.id === 'knowledge-core'; }

function compareChildren(a, b) {
  const ak = nodeKind(a) === 'dir' ? 0 : 1;
  const bk = nodeKind(b) === 'dir' ? 0 : 1;
  if (ak !== bk) return ak - bk;
  const files = (Number(b?.files) || 0) - (Number(a?.files) || 0);
  if (files) return files;
  return collator.compare(text(a?.label) || idOf(a?.id), text(b?.label) || idOf(b?.id))
    || collator.compare(idOf(a?.id), idOf(b?.id));
}

function safeNode(raw) {
  const id = idOf(raw?.id);
  if (!id || isSynthetic(raw)) return null;
  const kind = nodeKind(raw);
  return {
    ...raw,
    id,
    label: text(raw?.label) || id.split('/').pop() || id,
    kind,
    provider: providerValue(raw?.provider),
    files: Number.isFinite(Number(raw?.files)) ? Math.max(0, Number(raw.files)) : 0,
    ring: RINGS.has(raw?.ring) ? raw.ring : undefined,
    synthetic: false,
  };
}

export function indexStructureGraph(payload) {
  const nodesById = new Map();
  for (const raw of Array.isArray(payload?.nodes) ? payload.nodes : []) {
    const node = safeNode(raw);
    if (node && !nodesById.has(node.id)) nodesById.set(node.id, node);
  }
  const childrenById = new Map([...nodesById.keys()].map((id) => [id, []]));
  const parentById = new Map();
  const edges = [];
  for (const edge of Array.isArray(payload?.edges) ? payload.edges : []) {
    const source = idOf(edge?.source);
    const target = idOf(edge?.target);
    if (!nodesById.has(source) || !nodesById.has(target) || source === target || parentById.has(target)) continue;
    let ancestor = source;
    let cyclic = false;
    while (ancestor) {
      if (ancestor === target) { cyclic = true; break; }
      ancestor = parentById.get(ancestor);
    }
    if (cyclic) continue;
    parentById.set(target, source);
    childrenById.get(source).push(target);
    edges.push({ source, target });
  }
  for (const [parent, children] of childrenById) {
    children.sort((a, b) => compareChildren(nodesById.get(a), nodesById.get(b)));
    childrenById.set(parent, children);
  }
  return { nodesById, childrenById, parentById, edges };
}

function moreNode(parent, page, count, offset) {
  return {
    id: `more:${parent.id}:${offset}`,
    label: `+${count} เพิ่มเติม`,
    kind: 'more', synthetic: true, apiLookupId: null,
    provider: providerValue(parent.provider), parentId: parent.id,
    page, offset, files: count, ring: parent.ring,
  };
}

function pageWindow(index, parentId, limit, cursor = 0) {
  const parent = index.nodesById.get(parentId);
  const ids = index.childrenById.get(parentId) || [];
  const explicitOffset = cursor && typeof cursor === 'object' ? Number(cursor.offset) : Number.NaN;
  const numericPage = Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;
  const requestedStart = Number.isFinite(explicitOffset) ? Math.max(0, explicitOffset) : numericPage * limit;
  const lastPageStart = ids.length ? Math.floor((ids.length - 1) / limit) * limit : 0;
  const start = Math.min(requestedStart, lastPageStart);
  const selected = ids.slice(start, start + limit).map((id) => index.nodesById.get(id));
  const nodes = selected.filter(Boolean);
  const nextOffset = start + limit;
  if (nextOffset < ids.length && parent) {
    nodes.push(moreNode(parent, Math.floor(nextOffset / limit), ids.length - nextOffset, nextOffset));
  }
  return { nodes, start, capacity: nodes.length };
}

function ancestors(index, id) {
  const out = [];
  const seen = new Set();
  let current = id;
  while (current && index.nodesById.has(current) && !seen.has(current)) {
    seen.add(current);
    out.unshift(index.nodesById.get(current));
    current = index.parentById.get(current);
  }
  return out;
}

function addNode(map, node) { if (node && !map.has(node.id)) map.set(node.id, node); }

function collectionValue(collection, key) {
  if (collection instanceof Map) return collection.get(key);
  return collection && typeof collection === 'object' ? collection[key] : undefined;
}

function hasCollectionKey(collection, key) {
  if (collection instanceof Map) return collection.has(key);
  return Boolean(collection && typeof collection === 'object'
    && Object.prototype.hasOwnProperty.call(collection, key));
}

function normalizeProviderPath(index, provider, requested) {
  const normalized = [];
  let expectedParent = provider;
  for (const rawId of Array.isArray(requested) ? requested : []) {
    const id = idOf(rawId);
    const node = index.nodesById.get(id);
    if (!node || nodeKind(node) !== 'dir' || providerValue(node.provider) !== provider
      || index.parentById.get(id) !== expectedParent) break;
    normalized.push(id);
    expectedParent = id;
  }
  return normalized;
}

function legacyProviderPath(index, provider, state) {
  const focusedId = idOf(state?.focusedId ?? state?.focusId ?? state?.selectedId);
  const focus = index.nodesById.get(focusedId);
  if (!focus || providerValue(focus.provider) !== provider) return [];
  const targetId = nodeKind(focus) === 'dir' ? focusedId : index.parentById.get(focusedId);
  const target = index.nodesById.get(targetId);
  if (!target || nodeKind(target) !== 'dir') return [];
  const chain = ancestors(index, targetId).map((node) => node.id);
  const rootIndex = chain.indexOf(provider);
  return rootIndex < 0 ? [] : normalizeProviderPath(index, provider, chain.slice(rootIndex + 1));
}

function pageCursor(state, parentId) {
  const value = collectionValue(state?.pageByParent, parentId);
  if (value && typeof value === 'object' && Number.isFinite(Number(value.offset))) {
    return { offset: Math.max(0, Number(value.offset)) };
  }
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function childSlot(index, state, parentId, childId, limit) {
  const ids = index.childrenById.get(parentId) || [];
  const siblingIndex = ids.indexOf(childId);
  const page = pageWindow(index, parentId, limit, pageCursor(state, parentId));
  if (siblingIndex >= page.start && siblingIndex < page.start + limit) {
    return { slotIndex: siblingIndex - page.start, slotCapacity: Math.max(1, page.capacity) };
  }
  return { slotIndex: Math.max(0, siblingIndex), slotCapacity: Math.max(1, ids.length) };
}

function annotatedNode(node, annotation = {}) {
  return {
    ...node,
    parentId: annotation.parentId ?? node.parentId ?? null,
    layerDepth: Math.max(0, Number(annotation.layerDepth) || 0),
    slotIndex: Math.max(0, Number(annotation.slotIndex) || 0),
    slotCapacity: Math.max(1, Number(annotation.slotCapacity) || 1),
    orbitLayer: text(annotation.orbitLayer) || 'context',
  };
}

export function projectStructureGraph(index, state = {}) {
  const source = index && index.nodesById instanceof Map ? index : indexStructureGraph(index);
  // The map controls pass numbers. Keep every other caller value on the
  // established one-layer projection rather than coercing strings or booleans.
  const focusDepth = state?.focusDepth === 2 ? 2 : 1;
  const roots = ['claude', 'codex'].filter((id) => source.nodesById.has(id));
  const requestedExpanded = state?.expandedProviders instanceof Set
    ? state.expandedProviders
    : new Set(Array.isArray(state?.expandedProviders) ? state.expandedProviders : roots);
  const expandedProviders = new Set(roots.filter((provider) => requestedExpanded.has(provider)));
  const pathState = state?.expandedPathByProvider;
  const hasExplicitPaths = pathState instanceof Map
    || Boolean(pathState && typeof pathState === 'object');
  const normalizedPaths = {};
  for (const provider of ['claude', 'codex']) {
    const requestedPath = hasExplicitPaths
      ? (hasCollectionKey(pathState, provider) ? collectionValue(pathState, provider) : [])
      : legacyProviderPath(source, provider, state);
    normalizedPaths[provider] = normalizeProviderPath(source, provider, requestedPath);
  }

  const fixed = new Map();
  const overview = new Map();
  const paths = new Map();
  const core = { id: 'knowledge-core', label: 'Knowledge Core', kind: 'core', provider: 'unified', ring: 'core', synthetic: true, apiLookupId: null };
  addNode(fixed, annotatedNode(core, {
    parentId: null, layerDepth: 0, slotIndex: 0, slotCapacity: 1, orbitLayer: 'core',
  }));
  roots.forEach((provider, providerIndex) => {
    const root = source.nodesById.get(provider);
    if (root) addNode(fixed, annotatedNode(root, {
      parentId: 'knowledge-core', layerDepth: 1, slotIndex: providerIndex, slotCapacity: 2, orbitLayer: 'provider',
    }));
  });

  for (const provider of roots) {
    if (!expandedProviders.has(provider)) continue;
    const rootPage = pageWindow(source, provider, ROOT_CHILD_LIMIT, pageCursor(state, provider));
    rootPage.nodes.forEach((node, slotIndex) => addNode(overview, annotatedNode(node, {
      parentId: node.kind === 'more' ? node.parentId : provider,
      layerDepth: 2,
      slotIndex,
      slotCapacity: Math.max(1, rootPage.capacity),
      orbitLayer: 'overview',
    })));
  }

  // Protect both provider overview pages before admitting paths. Active paths
  // advance one depth round at a time, so a tight final budget cannot favor
  // whichever provider happens to be iterated first.
  const protectedIds = new Set([...fixed.keys(), ...overview.keys()]);
  const pathIdsByProvider = {
    claude: expandedProviders.has('claude') ? [] : normalizedPaths.claude,
    codex: expandedProviders.has('codex') ? [] : normalizedPaths.codex,
  };
  const activePathProviders = roots.filter((provider) => expandedProviders.has(provider));
  let pathDepth = 0;
  while (true) {
    const candidates = activePathProviders
      .filter((provider) => pathDepth < normalizedPaths[provider].length)
      .map((provider) => ({ provider, id: normalizedPaths[provider][pathDepth] }));
    if (!candidates.length) break;
    const additions = new Set(candidates.map(({ id }) => id).filter((id) => !protectedIds.has(id)));
    if (protectedIds.size + additions.size > VISIBLE_NODE_LIMIT) break;
    for (const { provider, id } of candidates) {
      pathIdsByProvider[provider].push(id);
      protectedIds.add(id);
    }
    pathDepth += 1;
  }

  const disclosedByProvider = { claude: new Map(), codex: new Map() };
  for (const provider of roots) {
    if (!expandedProviders.has(provider)) continue;
    const providerPath = pathIdsByProvider[provider];
    providerPath.forEach((id, pathIndex) => {
      const node = source.nodesById.get(id);
      const parentId = pathIndex === 0 ? provider : providerPath[pathIndex - 1];
      const slot = childSlot(source, state, parentId, id,
        parentId === provider ? ROOT_CHILD_LIMIT : FOCUS_CHILD_LIMIT);
      addNode(paths, annotatedNode(node, {
        parentId,
        layerDepth: pathIndex + 2,
        ...slot,
        orbitLayer: pathIndex === 0 ? 'overview' : 'path',
      }));
    });

    const deepestId = providerPath.at(-1);
    if (!deepestId) continue;
    const childPage = pageWindow(source, deepestId, FOCUS_CHILD_LIMIT, pageCursor(state, deepestId));
    childPage.nodes.forEach((node, slotIndex) => addNode(disclosedByProvider[provider], annotatedNode(node, {
      parentId: node.kind === 'more' ? node.parentId : deepestId,
      layerDepth: providerPath.length + 2,
      slotIndex,
      slotCapacity: Math.max(1, childPage.capacity),
      orbitLayer: 'children',
    })));
  }

  const selectedIds = new Set([...fixed.keys(), ...overview.keys(), ...paths.keys()]);
  const disclosedLists = Object.fromEntries(roots.map((provider) => (
    [provider, [...disclosedByProvider[provider].values()]]
  )));
  let childSlotIndex = 0;
  while (selectedIds.size < VISIBLE_NODE_LIMIT) {
    const candidates = roots
      .map((provider) => disclosedLists[provider][childSlotIndex])
      .filter(Boolean);
    if (!candidates.length) break;
    const additions = new Set(candidates.map((node) => node.id).filter((id) => !selectedIds.has(id)));
    if (selectedIds.size + additions.size > VISIBLE_NODE_LIMIT) break;
    for (const node of candidates) selectedIds.add(node.id);
    childSlotIndex += 1;
  }
  const disclosed = new Map(roots.flatMap((provider) => [...disclosedByProvider[provider]]));
  const secondHop = new Map();
  if (focusDepth === 2) {
    // Each queue is one visible first-hop directory. A round takes at most one
    // child from each queue, so a directory with many files cannot exhaust the
    // remaining global budget before its peers are represented.
    const queues = roots.flatMap((provider) => (
      [...disclosedByProvider[provider].values()]
        .filter((node) => selectedIds.has(node.id) && nodeKind(node) === 'dir')
        .sort((a, b) => collator.compare(a.id, b.id))
        .map((parent) => {
          const page = pageWindow(source, parent.id, FOCUS_CHILD_LIMIT, pageCursor(state, parent.id));
          return {
            provider,
            parent,
            slotCapacity: Math.max(1, page.capacity),
            children: page.nodes.filter((node) => !isSynthetic(node)),
          };
        })
    ));
    for (let round = 0; selectedIds.size < VISIBLE_NODE_LIMIT; round += 1) {
      let admitted = false;
      for (const queue of queues) {
        const child = queue.children[round];
        if (!child || selectedIds.has(child.id) || selectedIds.size >= VISIBLE_NODE_LIMIT) continue;
        addNode(secondHop, annotatedNode(child, {
          parentId: queue.parent.id,
          layerDepth: queue.parent.layerDepth + 1,
          slotIndex: round,
          slotCapacity: queue.slotCapacity,
          orbitLayer: 'second-hop',
        }));
        selectedIds.add(child.id);
        admitted = true;
      }
      if (!admitted) break;
    }
  }
  const allNodes = new Map([...fixed, ...overview, ...paths, ...disclosed, ...secondHop]);
  const nodes = [...allNodes.values()].filter((node) => selectedIds.has(node.id));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = [{ source: 'knowledge-core', target: 'claude' }, { source: 'knowledge-core', target: 'codex' }]
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  for (const node of nodes) {
    if (node.id === 'knowledge-core' || node.id === 'claude' || node.id === 'codex') continue;
    if (node.parentId && visibleIds.has(node.parentId)) edges.push({ source: node.parentId, target: node.id });
  }
  const focusedId = idOf(state.focusedId ?? state.focusId ?? state.selectedId);
  const focus = source.nodesById.get(focusedId);
  const visibleAncestors = focus ? ancestors(source, focusedId).filter((node) => visibleIds.has(node.id)) : [];
  const allFocusAncestors = focus ? ancestors(source, focusedId) : [];
  const outgoingIds = new Set(edges.map((edge) => edge.source));
  const expandedIds = roots.filter((provider) => (
    expandedProviders.has(provider) && outgoingIds.has(provider)
  ));
  for (const provider of roots) {
    if (!expandedProviders.has(provider)) continue;
    for (const id of pathIdsByProvider[provider]) {
      if (visibleIds.has(id) && outgoingIds.has(id)) expandedIds.push(id);
    }
  }
  return {
    nodes, edges,
    focusDepth,
    focusedId: focus ? focusedId : null,
    expandedIds,
    pathIdsByProvider,
    ancestorIds: visibleAncestors.map((node) => node.id),
    omittedAncestorCount: allFocusAncestors.length - visibleAncestors.length,
    contextIds: [],
    pageNodeIds: nodes.filter((node) => node.kind === 'more').map((node) => node.id),
    totalNodes: source.nodesById.size,
  };
}

// A square, circular world keeps the real filesystem projection navigable at
// every viewport. CSS may scroll this minimum canvas on narrow screens; the
// data layout itself never degrades to vertical lanes.
const MAX_STRUCTURE_RADIUS = 48;
const MIN_STRUCTURE_RADIUS = 20;
function radius(node) {
  if (node?.id === 'knowledge-core' || node?.kind === 'core') return 48;
  if (node?.id === 'claude' || node?.id === 'codex') return 40;
  if (node?.kind === 'dir' || node?.kind === 'directory') return 24;
  if (node?.kind === 'file' || node?.kind === 'more') return 20;
  return Math.min(MAX_STRUCTURE_RADIUS, Math.max(MIN_STRUCTURE_RADIUS,
    Number(node?.radius ?? node?.r ?? 20) || 20));
}

function bounded(value, low, high) { return Math.min(high, Math.max(low, value)); }

function collisionFree(point, positions) {
  return [...positions.values()].every((other) => (
    Math.hypot(point.x - other.x, point.y - other.y) >= point.r + other.r + 18
  ));
}

function deterministicSlots(desired, r, bounds, provider = 'unified') {
  let minX = r; let maxX = Math.max(minX, bounds.width - r);
  if (provider === 'claude') maxX = Math.min(maxX, bounds.centerX - r);
  if (provider === 'codex') minX = Math.max(minX, bounds.centerX + r);
  const minY = r; const maxY = Math.max(minY, bounds.height - r);
  const step = r * 2 + 18;
  const columns = Math.max(1, Math.floor((maxX - minX) / step) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / step) + 1);
  const slots = [{ x: bounded(desired.x, minX, maxX), y: bounded(desired.y, minY, maxY) }];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      slots.push({ x: Math.min(maxX, minX + column * step), y: Math.min(maxY, minY + row * step) });
    }
  }
  return slots.sort((a, b) => (
    Math.hypot(a.x - desired.x, a.y - desired.y) - Math.hypot(b.x - desired.x, b.y - desired.y)
    || a.y - b.y || a.x - b.x
  ));
}

function placeWithoutCollision(node, desired, positions, bounds) {
  positions.delete(node.id);
  const requested = Math.min(radius(node), bounds.radiusCap ?? MAX_STRUCTURE_RADIUS);
  // Folder buttons render at a fixed 48px diameter. Never make the logical
  // radius smaller than the visible button merely to fit a dense projection;
  // fail closed if the 980px world genuinely has no valid slot.
  const minimum = nodeKind(node) === 'dir' ? 24 : MIN_STRUCTURE_RADIUS;
  for (let r = requested; r >= minimum; r -= 1) {
    for (const slot of deterministicSlots(desired, r, bounds, providerValue(node?.provider))) {
      const point = { ...desired, x: slot.x, y: slot.y, r };
      if (collisionFree(point, positions)) {
        positions.set(node.id, point);
        return point;
      }
    }
  }
  throw new RangeError('structure layout capacity invariant violated');
}

function sectorFor(provider) {
  // Claude owns the left half; Codex owns the right half. The slight angular
  // inset leaves the horizontal provider-root axis clear for its labels while
  // retaining enough arc length for 15 fixed 48px circles plus 18px gaps.
  return provider === 'codex'
    ? { start: -Math.PI / 2 + .10, end: Math.PI / 2 - .10, labelSide: 'right' }
    : { start: Math.PI / 2 + .10, end: Math.PI * 1.5 - .10, labelSide: 'left' };
}

function circularPoint(cx, cy, orbitRadius, angle, r, labelSide, orbitLayer) {
  return {
    x: cx + Math.cos(angle) * orbitRadius,
    y: cy + Math.sin(angle) * orbitRadius,
    r, labelSide, orbitRadius, orbitAngle: angle, orbitLayer,
  };
}

function stableCircularPoint(node, orbitRadius, provider, cx, cy, orbitLayer, radiusCap) {
  const sector = sectorFor(provider);
  const span = sector.end - sector.start;
  const capacity = Math.max(1, Number(node.slotCapacity) || 1);
  const slot = bounded(Number(node.slotIndex) || 0, 0, capacity - 1);
  const angle = sector.start + ((slot + 1) * span) / (capacity + 1);
  // Children prefer the quiet space outside their provider half. A final
  // label-only pass below chooses a tangent/inward side if that exact slot is
  // clipped or occupied; node coordinates remain stable.
  const inwardLabel = orbitLayer !== 'children' && (
    orbitLayer === 'path' || Math.abs(Math.cos(angle)) > .72 || Math.sin(angle) > .62
  );
  const labelSide = inwardLabel ? (Math.cos(angle) > 0 ? 'left' : 'right') : sector.labelSide;
  return circularPoint(cx, cy, orbitRadius, angle,
    Math.min(radius(node), radiusCap), labelSide, orbitLayer);
}

function labelMetrics(node) {
  const label = node?.id === 'knowledge-core'
    ? 'ศูนย์กลางความรู้'
    : node?.id === 'claude' || node?.id === 'codex'
      ? `.${node.id}`
      : text(node?.label || node?.id);
  const compact = node?.orbitLayer === 'overview' || node?.orbitLayer === 'children';
  const maxWidth = compact ? 82 : 124;
  const rawWidth = 8 + [...label].reduce((sum, character) => (
    sum + (character.codePointAt(0) > 0x7f ? 8.5 : 6.1)
  ), 0);
  return {
    width: Math.min(maxWidth, Math.max(18, rawWidth)),
    height: Math.min(2, Math.max(1, Math.ceil(rawWidth / maxWidth))) * 13.75,
  };
}

function visibleNodeRadius(node) {
  if (node?.id === 'knowledge-core' || node?.kind === 'core') return 48;
  if (node?.id === 'claude' || node?.id === 'codex') return 40;
  return Math.max(24, radius(node));
}

function markRadius(node) {
  // Label clearance protects the complete interactive circle. The inner
  // logo/hex/diamond is decorative and materially smaller than the button.
  return visibleNodeRadius(node);
}

function labelRect(node, point, side, offsetY = 0, offsetX = 0) {
  const metrics = labelMetrics(node);
  const nodeRadius = visibleNodeRadius(node);
  const horizontalGap = nodeRadius + 8;
  if (side === 'left') {
    return {
      left: point.x - horizontalGap - metrics.width + offsetX,
      right: point.x - horizontalGap + offsetX,
      top: point.y - 3 - metrics.height + offsetY,
      bottom: point.y - 3 + offsetY,
    };
  }
  if (side === 'right') {
    return {
      left: point.x + horizontalGap + offsetX,
      right: point.x + horizontalGap + metrics.width + offsetX,
      top: point.y - 3 - metrics.height + offsetY,
      bottom: point.y - 3 + offsetY,
    };
  }
  return {
    left: point.x - metrics.width / 2 + offsetX,
    right: point.x + metrics.width / 2 + offsetX,
    top: point.y + nodeRadius + 8 + offsetY,
    bottom: point.y + nodeRadius + 8 + metrics.height + offsetY,
  };
}

function overlapsRect(left, right) {
  return left.left < right.right && left.right > right.left
    && left.top < right.bottom && left.bottom > right.top;
}

function resolveBranchLabelSides(nodes, positions, width, height, expandedIds = []) {
  // The 980px world is centred inside a slightly narrower stage at the
  // 941px desktop breakpoint. This inset keeps edge labels readable after the
  // stage clips its symmetric overflow.
  const safeMargin = 24;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const expanded = new Set(Array.isArray(expandedIds) ? expandedIds : []);
  const isAdjustableBranch = (node) => node.orbitLayer === 'children'
    || node.orbitLayer === 'path'
    // A first-level directory stays on the stable overview ring when it is
    // opened. Its label still needs to avoid the disclosed child circles.
    || (node.orbitLayer === 'overview' && expanded.has(node.id));
  const branches = nodes.filter(isAdjustableBranch).sort((a, b) => (
    (Number(a.layerDepth) || 0) - (Number(b.layerDepth) || 0)
    || (providerValue(a.provider) === 'claude' ? 0 : 1) - (providerValue(b.provider) === 'claude' ? 0 : 1)
    || (Number(a.slotIndex) || 0) - (Number(b.slotIndex) || 0)
    || collator.compare(a.id, b.id)
  ));
  const markRects = [...positions].map(([id, point]) => {
    const node = byId.get(id);
    const r = markRadius(node);
    return { id, left: point.x - r, right: point.x + r, top: point.y - r, bottom: point.y + r };
  });
  const occupiedLabels = [];
  for (const node of nodes) {
    if (isAdjustableBranch(node)) continue;
    const point = positions.get(node.id);
    if (point) occupiedLabels.push(labelRect(node, point, point.labelSide || 'bottom'));
  }
  for (const node of branches) {
    const point = positions.get(node.id);
    if (!point) continue;
    const outward = sectorFor(providerValue(node.provider)).labelSide;
    const inward = outward === 'left' ? 'right' : 'left';
    const sides = [outward, 'bottom', inward];
    const offsetSteps = [0, -12, 12, -24, 24, -36, 36, -48, 48, -60, 60, -72, 72, -84, 84, -96, 96];
    const labelOffsets = offsetSteps.flatMap((labelOffsetY) => (
      offsetSteps.map((labelOffsetX) => ({ labelOffsetX, labelOffsetY }))
    )).sort((a, b) => (
      Math.hypot(a.labelOffsetX, a.labelOffsetY) - Math.hypot(b.labelOffsetX, b.labelOffsetY)
      || Math.abs(a.labelOffsetX) - Math.abs(b.labelOffsetX)
      || a.labelOffsetY - b.labelOffsetY
      || a.labelOffsetX - b.labelOffsetX
    ));
    let best = null;
    for (const { labelOffsetX, labelOffsetY } of labelOffsets) {
      for (const side of sides) {
        const rect = labelRect(node, point, side, labelOffsetY, labelOffsetX);
        const outside = rect.left < safeMargin || rect.right > width - safeMargin
          || rect.top < safeMargin || rect.bottom > height - safeMargin;
        // Score against every complete button circle, including this node's
        // own circle. In particular, a negative bottom-label offset must not
        // pull the label back across the button it describes.
        const markHits = markRects.filter((mark) => overlapsRect(rect, mark)).length;
        const labelHits = occupiedLabels.filter((label) => overlapsRect(rect, label)).length;
        const conflicts = (outside ? 100 : 0) + markHits * 10 + labelHits;
        const displacement = Math.hypot(labelOffsetX, labelOffsetY);
        if (!best || conflicts < best.conflicts
          || (conflicts === best.conflicts && displacement < best.displacement)) {
          best = { side, rect, conflicts, labelOffsetX, labelOffsetY, displacement };
        }
        if (conflicts === 0) break;
      }
      if (best?.conflicts === 0) break;
    }
    positions.set(node.id, {
      ...point,
      labelSide: best.side,
      labelOffsetX: best.labelOffsetX,
      labelOffsetY: best.labelOffsetY,
    });
    occupiedLabels.push(best.rect);
  }
}

export function layoutStructureGraph(projection, bounds = {}) {
  const requestedWidth = Number(bounds.width);
  const requestedHeight = Number(bounds.height);
  const requestedSide = Math.min(
    Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : 980,
    Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 980,
  );
  const width = Math.max(720, requestedSide);
  const height = width;
  const nodes = Array.isArray(projection?.nodes) ? projection.nodes : [];
  const layoutBounds = {
    width, height,
    centerX: width * 0.5,
    // Directory buttons render as 48px circles. Their collision radius must
    // remain 24px even though file and paging marks may use the 20px minimum.
    radiusCap: 24,
  };
  const positions = new Map();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cx = width * 0.5; const cy = height * 0.5;
  const coreNode = byId.get('knowledge-core');
  if (coreNode) positions.set('knowledge-core', { x: cx, y: cy, r: radius(coreNode), labelSide: 'bottom', orbitRadius: 0, orbitAngle: 0, orbitLayer: 'core' });
  const outerOrbit = Math.max(250, width / 2 - 60);
  const providerOrbit = Math.max(112, outerOrbit * .35);
  if (byId.has('claude')) positions.set('claude', circularPoint(cx, cy, providerOrbit, Math.PI, radius(byId.get('claude')), 'bottom', 'provider'));
  if (byId.has('codex')) positions.set('codex', circularPoint(cx, cy, providerOrbit, 0, radius(byId.get('codex')), 'bottom', 'provider'));

  const placeable = nodes.filter((node) => !positions.has(node.id)).sort((a, b) => (
    // Place the optional layer after every established node, even if another
    // provider has a deeper active path. This leaves all depth-1 coordinates
    // untouched because the greedy collision solver sees its exact old input.
    (a.orbitLayer === 'second-hop' ? 1 : 0) - (b.orbitLayer === 'second-hop' ? 1 : 0)
    || (Number(a.layerDepth) || 0) - (Number(b.layerDepth) || 0)
    // A clicked directory is promoted from children to path. Its placement
    // order must not depend on that presentation state, otherwise greedy
    // fallback slots can make the same circle jump at capped deep layers.
    || (providerValue(a.provider) === 'claude' ? 0 : 1) - (providerValue(b.provider) === 'claude' ? 0 : 1)
    || (Number(a.slotIndex) || 0) - (Number(b.slotIndex) || 0)
    || collator.compare(a.id, b.id)
  ));
  for (const node of placeable) {
    const depth = Math.max(2, Number(node.layerDepth) || 2);
    // Each filesystem depth owns a complete circular layer. The 70px step
    // yields visibly distinct overview, first-child and nested-child rings at
    // about 290px, 360px and 430px inside the fixed 980px world.
    const orbitRadius = Math.min(outerOrbit, providerOrbit + 140 + (depth - 2) * 70);
    const provider = providerValue(node.provider);
    const desired = stableCircularPoint(
      node, orbitRadius, provider, cx, cy, node.orbitLayer, layoutBounds.radiusCap,
    );
    placeWithoutCollision(node, desired, positions, layoutBounds);
  }
  resolveBranchLabelSides(nodes, positions, width, height, projection?.expandedIds);
  for (const [id, point] of positions) {
    const node = byId.get(id);
    if (!node || point.r < MIN_STRUCTURE_RADIUS || point.r > MAX_STRUCTURE_RADIUS
      || point.x < point.r || point.x > width - point.r
      || point.y < point.r || point.y > height - point.r) {
      throw new RangeError('structure layout bounds invariant violated');
    }
    const others = new Map([...positions].filter(([otherId]) => otherId !== id));
    if (!collisionFree(point, others)) throw new RangeError('structure layout collision invariant violated');
  }
  const positioned = nodes.map((node) => ({ ...node, ...positions.get(node.id) }));
  return { ...projection, nodes: positioned, positions, width, height, center: { x: cx, y: cy } };
}

export function roleForStructureNode(node) {
  const ring = text(node?.ring).toLowerCase();
  return RINGS.has(ring) ? ring : 'other';
}

export function providerForStructureNode(node) {
  return providerValue(node?.provider ?? (node?.id === 'claude' ? 'claude' : node?.id === 'codex' ? 'codex' : 'unified'));
}
