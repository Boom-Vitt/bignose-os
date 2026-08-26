export const MOTION_MS = Object.freeze({
  layout: 600,
  load: 850,
  ring: 480,
  core: 300,
  selection: 420,
  hover: 150,
});

const RING_KINDS = new Set(['load', 'refresh', 'topology', 'layout']);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function triangular(progress) {
  const p = clamp01(progress);
  return 1 - Math.abs(p * 2 - 1);
}

function transientDuration(layout, kind) {
  if (layout !== 'rings') return MOTION_MS.core;
  return kind === 'load' ? MOTION_MS.load : MOTION_MS.ring;
}

function clonePositions(value) {
  return value instanceof Map ? new Map(value) : new Map();
}

export function createBrainMotionState({
  now = 0,
  layout = 'rings',
  reducedMotion = false,
  visible = true,
  spin = 0,
  positions = new Map(),
  nodeCount = 0,
} = {}) {
  const time = Number.isFinite(Number(now)) ? Number(now) : 0;
  return {
    layout,
    reducedMotion: !!reducedMotion,
    visible: !!visible,
    spin: clamp01(spin),
    spinPhase: 0,
    lastTick: time,
    nodeCount: Math.max(0, Number(nodeCount) || 0),
    positions: clonePositions(positions),
    layoutTween: null,
    ringTransient: null,
    selectionTransient: null,
    selectedId: null,
    hoveredId: null,
    hoverStartedAt: null,
    pausedAt: visible ? null : time,
  };
}

function shiftStart(item, pausedAt, now) {
  if (!item) return null;
  const hiddenForItem = Math.max(0, now - Math.max(pausedAt, item.start));
  return { ...item, start: item.start + hiddenForItem };
}

function shiftTimestamp(value, pausedAt, now) {
  if (value == null) return null;
  return value + Math.max(0, now - Math.max(pausedAt, value));
}

function shiftPausedTimes(state, now) {
  const pausedAt = state.pausedAt ?? now;
  return {
    ...state,
    layoutTween: shiftStart(state.layoutTween, pausedAt, now),
    ringTransient: shiftStart(state.ringTransient, pausedAt, now),
    selectionTransient: shiftStart(state.selectionTransient, pausedAt, now),
    hoverStartedAt: shiftTimestamp(state.hoverStartedAt, pausedAt, now),
    lastTick: now,
    pausedAt: null,
  };
}

export function reduceBrainMotion(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state;
  const now = Number.isFinite(Number(event.now)) ? Number(event.now) : state.lastTick;

  if (event.type === 'set-node-count') {
    return { ...state, nodeCount: Math.max(0, Number(event.value) || 0) };
  }
  if (event.type === 'set-spin') {
    return { ...state, spin: clamp01(event.value), lastTick: now };
  }
  if (event.type === 'set-layout') {
    const layout = event.layout;
    const ringTransient = state.ringTransient
      ? {
        ...state.ringTransient,
        mode: layout === 'rings' ? 'rings' : 'core',
        duration: Math.min(
          state.ringTransient.duration,
          transientDuration(layout, state.ringTransient.kind),
        ),
      }
      : null;
    return { ...state, layout, ringTransient, lastTick: now };
  }
  if (event.type === 'ring-transient') {
    if (state.reducedMotion || !RING_KINDS.has(event.kind)) return state;
    return {
      ...state,
      ringTransient: {
        kind: event.kind,
        mode: state.layout === 'rings' ? 'rings' : 'core',
        start: now,
        duration: transientDuration(state.layout, event.kind),
      },
    };
  }
  if (event.type === 'select') {
    const id = typeof event.nodeId === 'string' ? event.nodeId : null;
    return {
      ...state,
      selectedId: id,
      selectionTransient: id && !state.reducedMotion
        ? { id, start: now, duration: MOTION_MS.selection }
        : null,
    };
  }
  if (event.type === 'hover') {
    const id = typeof event.nodeId === 'string' ? event.nodeId : null;
    if (id === state.hoveredId) return state;
    return {
      ...state,
      hoveredId: id,
      hoverStartedAt: id && !state.reducedMotion ? now : null,
    };
  }
  if (event.type === 'layout-target') {
    const target = clonePositions(event.target);
    const origin = event.origin && Number.isFinite(event.origin.x) && Number.isFinite(event.origin.y)
      ? { x: event.origin.x, y: event.origin.y }
      : { x: 0, y: 0 };
    if (!event.animate || state.reducedMotion || state.positions.size === 0) {
      return { ...state, positions: target, layoutTween: null, lastTick: now };
    }
    return {
      ...state,
      layoutTween: {
        from: clonePositions(state.positions), target, origin,
        start: now, duration: MOTION_MS.layout,
      },
      lastTick: now,
    };
  }
  if (event.type === 'spin-layout-target') {
    const target = clonePositions(event.target);
    if (state.layoutTween) {
      return {
        ...state,
        layoutTween: { ...state.layoutTween, target },
      };
    }
    return { ...state, positions: target };
  }
  if (event.type === 'visibility') {
    const visible = !!event.visible;
    if (visible === state.visible) return state;
    if (!visible) return { ...state, visible: false, pausedAt: now, lastTick: now };
    return { ...shiftPausedTimes(state, now), visible: true };
  }
  if (event.type === 'reduced-motion') {
    const reducedMotion = !!event.value;
    if (reducedMotion === state.reducedMotion) return state;
    if (!reducedMotion) return { ...state, reducedMotion: false, lastTick: now };
    return {
      ...state,
      reducedMotion: true,
      positions: state.layoutTween ? clonePositions(state.layoutTween.target) : state.positions,
      layoutTween: null,
      ringTransient: null,
      selectionTransient: null,
      hoverStartedAt: null,
      lastTick: now,
    };
  }
  return state;
}

function makeEase(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (progress) => {
    const p = clamp01(progress);
    let t = p;
    for (let i = 0; i < 6; i++) {
      const error = fx(t) - p;
      if (Math.abs(error) < 1e-5) break;
      const slope = dx(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

const EASE = makeEase(0.22, 0.61, 0.36, 1);

function interpolatePositions(tween, progress) {
  const amount = EASE(progress);
  const next = new Map();
  for (const [id, target] of tween.target) {
    const from = tween.from.get(id) || { x: tween.origin.x, y: tween.origin.y };
    next.set(id, {
      x: from.x + (target.x - from.x) * amount,
      y: from.y + (target.y - from.y) * amount,
      r: target.r,
      a: target.a,
    });
  }
  return next;
}

function spinAllowed(state) {
  return state.visible && !state.reducedMotion && state.spin > 0
    && (state.layout === 'rings' || state.layout === 'circle');
}

export function needsBrainFrame(state) {
  if (!state || !state.visible || state.reducedMotion) return false;
  const hoverActive = state.hoverStartedAt != null;
  return !!(state.layoutTween || state.ringTransient || state.selectionTransient
    || hoverActive || spinAllowed(state));
}

export function sampleBrainMotion(state, now) {
  const time = Number.isFinite(Number(now)) ? Number(now) : state.lastTick;
  if (!state.visible) {
    return {
      state,
      positions: state.positions,
      aurora: {
        enabled: true, ringSweep: null, coreFlash: 0, selectedCorona: 0,
        hoverBloom: 0, spinPhase: state.spinPhase, staticOnly: true,
      },
      routeTrace: null,
      needsFrame: false,
      minFrameInterval: 0,
    };
  }

  let next = state;
  if (spinAllowed(next)) {
    const deltaSeconds = Math.max(0, time - next.lastTick) / 1000;
    next = { ...next, spinPhase: next.spinPhase + deltaSeconds * next.spin * 0.28 };
  }
  next = { ...next, lastTick: time };

  if (next.layoutTween) {
    const progress = clamp01((time - next.layoutTween.start) / next.layoutTween.duration);
    next = {
      ...next,
      positions: progress >= 1
        ? clonePositions(next.layoutTween.target)
        : interpolatePositions(next.layoutTween, progress),
      layoutTween: progress >= 1 ? null : next.layoutTween,
    };
  }

  let ringSweep = null;
  let coreFlash = 0;
  if (next.ringTransient) {
    const progress = clamp01((time - next.ringTransient.start) / next.ringTransient.duration);
    if (progress >= 1) next = { ...next, ringTransient: null };
    else if (next.ringTransient.mode === 'rings') {
      ringSweep = {
        kind: next.ringTransient.kind,
        progress,
        allowNodeSparks: next.nodeCount <= 3500,
      };
      coreFlash = triangular(clamp01(progress / 0.28));
    } else {
      coreFlash = triangular(progress);
    }
  }

  let selectedCorona = 0;
  let routeTrace = null;
  if (next.selectionTransient) {
    const transient = next.selectionTransient;
    const progress = clamp01(
      (time - transient.start) / transient.duration,
    );
    if (progress >= 1) next = { ...next, selectionTransient: null };
    else {
      selectedCorona = progress;
      routeTrace = next.reducedMotion ? null : { id: transient.id, progress };
    }
  }

  let hoverBloom = 0;
  if (next.hoverStartedAt != null) {
    const progress = clamp01((time - next.hoverStartedAt) / MOTION_MS.hover);
    if (progress >= 1) next = { ...next, hoverStartedAt: null };
    else hoverBloom = progress;
  }

  const active = needsBrainFrame(next);
  const auraOnly = !next.layoutTween && !spinAllowed(next);
  return {
    state: next,
    positions: next.positions,
    aurora: {
      enabled: true,
      ringSweep,
      coreFlash,
      selectedCorona,
      hoverBloom,
      spinPhase: next.spinPhase,
      staticOnly: next.reducedMotion || !active,
    },
    routeTrace,
    needsFrame: active,
    minFrameInterval: next.nodeCount > 2500 && auraOnly ? 1000 / 30 : 0,
  };
}
