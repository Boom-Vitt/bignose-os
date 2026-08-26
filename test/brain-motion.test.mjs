import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOTION_MS,
  createBrainMotionState,
  needsBrainFrame,
  reduceBrainMotion,
  sampleBrainMotion,
} from '../public/js/brain-motion.js';

function positions(entries) {
  return new Map(entries.map(([id, x, y]) => [id, { x, y, r: 0, a: 0 }]));
}

function apply(state, event) {
  return reduceBrainMotion(state, event);
}

test('Rings load has an 850ms bounded envelope and becomes idle exactly at its end', () => {
  assert.deepEqual(MOTION_MS, {
    layout: 600, load: 850, ring: 480, core: 300, selection: 420, hover: 150,
  });
  let state = createBrainMotionState({ now: 100, layout: 'rings', visible: true });
  state = apply(state, { type: 'ring-transient', now: 100, kind: 'load' });

  const start = sampleBrainMotion(state, 100);
  const middle = sampleBrainMotion(start.state, 525);
  const end = sampleBrainMotion(middle.state, 950);

  assert.equal(start.aurora.ringSweep.progress, 0);
  assert.ok(middle.aurora.ringSweep.progress > 0);
  assert.ok(middle.aurora.ringSweep.progress < 1);
  assert.equal(end.aurora.ringSweep, null);
  assert.equal(end.state.ringTransient, null);
  assert.equal(end.needsFrame, false);
});

test('non-ring activation is a 300ms core flash and never exposes semantic ring progress', () => {
  let state = createBrainMotionState({ now: 0, layout: 'hex' });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
  const middle = sampleBrainMotion(state, 150);
  const end = sampleBrainMotion(middle.state, 300);
  assert.equal(middle.aurora.ringSweep, null);
  assert.ok(middle.aurora.coreFlash > 0);
  assert.equal(end.aurora.coreFlash, 0);
  assert.equal(end.needsFrame, false);
});

test('leaving Rings reclassifies an active sweep as a bounded core flash without restarting it', () => {
  for (const layout of ['circle', 'hex', 'force']) {
    let state = createBrainMotionState({ now: 0, layout: 'rings' });
    state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
    const priorEnd = state.ringTransient.start + state.ringTransient.duration;
    state = apply(state, { type: 'set-layout', now: 100, layout });

    assert.equal(state.ringTransient.mode, 'core');
    assert.equal(state.ringTransient.start, 0);
    assert.equal(state.ringTransient.duration, 300);
    assert.ok(state.ringTransient.start + state.ringTransient.duration <= priorEnd);

    const active = sampleBrainMotion(state, 100);
    assert.equal(active.aurora.ringSweep, null);
    assert.ok(active.aurora.coreFlash > 0);
    const end = sampleBrainMotion(active.state, 300);
    assert.equal(end.state.ringTransient, null);
    assert.equal(end.aurora.coreFlash, 0);
    assert.equal(end.needsFrame, false);
  }
});

test('entering Rings reclassifies a core transient without extending its absolute deadline', () => {
  let state = createBrainMotionState({ now: 0, layout: 'hex' });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
  const priorEnd = state.ringTransient.start + state.ringTransient.duration;
  state = apply(state, { type: 'set-layout', now: 100, layout: 'rings' });

  assert.equal(state.ringTransient.mode, 'rings');
  assert.equal(state.ringTransient.start, 0);
  assert.equal(state.ringTransient.duration, 300);
  assert.ok(state.ringTransient.start + state.ringTransient.duration <= priorEnd);
  const active = sampleBrainMotion(state, 100);
  assert.notEqual(active.aurora.ringSweep, null);
  assert.ok(active.aurora.ringSweep.progress > 0);
  const end = sampleBrainMotion(active.state, priorEnd);
  assert.equal(end.state.ringTransient, null);
  assert.equal(end.aurora.ringSweep, null);
  assert.equal(end.needsFrame, false);
});

test('layout interpolation ends at the exact target and new nodes start at the core', () => {
  let state = createBrainMotionState({
    now: 0,
    positions: positions([['a', 0, 0]]),
  });
  const target = positions([['a', 100, 40], ['b', 60, 20]]);
  state = apply(state, {
    type: 'layout-target', now: 0, target, origin: { x: 10, y: 10 }, animate: true,
  });
  const middle = sampleBrainMotion(state, 300);
  assert.ok(middle.positions.get('a').x > 0 && middle.positions.get('a').x < 100);
  assert.ok(middle.positions.get('b').x > 10 && middle.positions.get('b').x < 60);
  const end = sampleBrainMotion(middle.state, 600);
  assert.deepEqual(end.positions, target);
  assert.equal(end.state.layoutTween, null);
});

test('new ring and selection events replace their own lane while hover preserves selection', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings' });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'load' });
  state = apply(state, { type: 'ring-transient', now: 25, kind: 'topology' });
  state = apply(state, { type: 'select', now: 30, nodeId: 'selected' });
  state = apply(state, { type: 'hover', now: 40, nodeId: 'hovered' });
  assert.equal(state.ringTransient.kind, 'topology');
  assert.equal(state.selectionTransient.id, 'selected');
  assert.equal(state.selectedId, 'selected');
  assert.equal(state.hoveredId, 'hovered');
  const sample = sampleBrainMotion(state, 80);
  assert.ok(sample.aurora.selectedCorona > 0);
  assert.ok(sample.aurora.hoverBloom > 0);
});

test('selection exposes one bounded route trace and reduced motion suppresses it', () => {
  let state = createBrainMotionState({ now: 100, layout: 'rings', reducedMotion: false });
  state = reduceBrainMotion(state, {
    type: 'select', nodeId: 'codex/skills/review', now: 100,
  });
  const active = sampleBrainMotion(state, 220);
  assert.equal(active.routeTrace.id, 'codex/skills/review');
  assert.ok(active.routeTrace.progress > 0 && active.routeTrace.progress < 1);
  state = reduceBrainMotion(active.state, { type: 'reduced-motion', value: true, now: 220 });
  assert.equal(sampleBrainMotion(state, 221).routeTrace, null);
});

test('hidden time shifts every active deadline and does not advance spin', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings', spin: 1 });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'load' });
  const before = sampleBrainMotion(state, 200);
  const progress = before.aurora.ringSweep.progress;
  const phase = before.state.spinPhase;
  state = apply(before.state, { type: 'visibility', now: 200, visible: false });
  assert.equal(needsBrainFrame(state), false);
  state = apply(state, { type: 'visibility', now: 5200, visible: true });
  const resumed = sampleBrainMotion(state, 5200);
  assert.equal(resumed.aurora.ringSweep.progress, progress);
  assert.equal(resumed.state.spinPhase, phase);
});

test('hidden time preserves layout, ring, selection, and hover progress', () => {
  let state = createBrainMotionState({
    now: 0,
    layout: 'rings',
    positions: positions([['a', 0, 0]]),
  });
  state = apply(state, {
    type: 'layout-target', now: 0, target: positions([['a', 120, 60]]),
    origin: { x: 0, y: 0 }, animate: true,
  });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
  state = apply(state, { type: 'select', now: 0, nodeId: 'a' });
  state = apply(state, { type: 'hover', now: 0, nodeId: 'hovered' });

  const before = sampleBrainMotion(state, 120);
  state = apply(before.state, { type: 'visibility', now: 120, visible: false });
  state = apply(state, { type: 'visibility', now: 1120, visible: true });

  assert.equal(state.layoutTween.start, 1000);
  assert.equal(state.ringTransient.start, 1000);
  assert.equal(state.selectionTransient.start, 1000);
  assert.equal(state.hoverStartedAt, 1000);

  const resumed = sampleBrainMotion(state, 1120);
  assert.equal(resumed.positions.get('a').x, before.positions.get('a').x);
  assert.equal(resumed.positions.get('a').y, before.positions.get('a').y);
  assert.equal(resumed.aurora.ringSweep.progress, before.aurora.ringSweep.progress);
  assert.equal(resumed.aurora.selectedCorona, before.aurora.selectedCorona);
  assert.equal(resumed.aurora.hoverBloom, before.aurora.hoverBloom);
});

test('a transient created while hidden resumes from its own creation time', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings', visible: true });
  state = apply(state, { type: 'visibility', now: 100, visible: false });
  state = apply(state, { type: 'ring-transient', now: 400, kind: 'refresh' });
  state = apply(state, { type: 'visibility', now: 1000, visible: true });
  const resumed = sampleBrainMotion(state, 1000);
  assert.equal(resumed.aurora.ringSweep.progress, 0);
  assert.equal(resumed.state.ringTransient.start, 1000);
});

test('a selection created while hidden resumes from its own creation time', () => {
  let state = createBrainMotionState({ now: 0, visible: true });
  state = apply(state, { type: 'visibility', now: 100, visible: false });
  state = apply(state, { type: 'select', now: 400, nodeId: 'a' });
  state = apply(state, { type: 'visibility', now: 1000, visible: true });
  const resumed = sampleBrainMotion(state, 1000);
  assert.equal(resumed.state.selectionTransient.start, 1000);
  assert.equal(resumed.aurora.selectedCorona, 0);
  assert.equal(resumed.needsFrame, true);
});

test('reduced motion snaps a tween, clears transients, suppresses spin, and does not replay', () => {
  const target = positions([['a', 100, 50]]);
  let state = createBrainMotionState({
    now: 0, spin: 1, positions: positions([['a', 0, 0]]),
  });
  state = apply(state, {
    type: 'layout-target', now: 0, target, origin: { x: 0, y: 0 }, animate: true,
  });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'load' });
  state = apply(state, { type: 'select', now: 0, nodeId: 'a' });
  state = apply(state, { type: 'reduced-motion', now: 100, value: true });
  const reduced = sampleBrainMotion(state, 500);
  assert.deepEqual(reduced.positions, target);
  assert.equal(reduced.aurora.ringSweep, null);
  assert.equal(reduced.aurora.selectedCorona, 0);
  assert.equal(reduced.aurora.spinPhase, 0);
  assert.equal(reduced.needsFrame, false);
  state = apply(reduced.state, { type: 'reduced-motion', now: 500, value: false });
  assert.equal(sampleBrainMotion(state, 500).needsFrame, true); // saved spin resumes only now
  assert.equal(sampleBrainMotion(state, 500).aurora.ringSweep, null);
});

test('only aura-only motion over 2500 nodes is throttled and node sparks stop over 3500', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings', nodeCount: 3500 });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
  let sample = sampleBrainMotion(state, 20);
  assert.equal(sample.minFrameInterval, 1000 / 30);
  assert.equal(sample.aurora.ringSweep.allowNodeSparks, true);
  state = apply(sample.state, { type: 'set-node-count', now: 20, value: 3501 });
  sample = sampleBrainMotion(state, 21);
  assert.equal(sample.aurora.ringSweep.allowNodeSparks, false);
  state = apply(sample.state, { type: 'set-spin', now: 21, value: 1 });
  assert.equal(sampleBrainMotion(state, 22).minFrameInterval, 0);
});

test('a 480ms Rings transient is active before its boundary and idle exactly at its end', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings' });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'refresh' });
  const beforeEnd = sampleBrainMotion(state, 479);
  assert.notEqual(beforeEnd.aurora.ringSweep, null);
  assert.equal(beforeEnd.needsFrame, true);
  const end = sampleBrainMotion(beforeEnd.state, 480);
  assert.equal(end.state.ringTransient, null);
  assert.equal(end.aurora.ringSweep, null);
  assert.equal(end.needsFrame, false);
});

test('Rings spin advances phase directly at its configured rate', () => {
  const state = createBrainMotionState({ now: 0, layout: 'rings', spin: 1 });
  const sample = sampleBrainMotion(state, 100);
  assert.ok(Math.abs(sample.state.spinPhase - 0.028) < 1e-12);
  assert.equal(sample.needsFrame, true);
});

test('Circle retains node spin but its activation sample contains no semantic ring sweep', () => {
  let state = createBrainMotionState({ now: 0, layout: 'circle', spin: 1 });
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'layout' });
  const sample = sampleBrainMotion(state, 100);
  assert.ok(sample.state.spinPhase > 0);
  assert.equal(sample.aurora.ringSweep, null);
  assert.ok(sample.aurora.coreFlash > 0);
});

test('a spun layout target updates coordinates without restarting an active tween', () => {
  let state = createBrainMotionState({
    now: 0,
    positions: positions([['a', 0, 0]]),
  });
  state = apply(state, {
    type: 'layout-target', now: 0,
    target: positions([['a', 100, 0]]),
    origin: { x: 0, y: 0 }, animate: true,
  });
  state = apply(state, {
    type: 'spin-layout-target', now: 200,
    target: positions([['a', 0, 100]]),
  });
  assert.equal(state.layoutTween.start, 0);
  assert.equal(state.layoutTween.duration, 600);
  assert.deepEqual(state.layoutTween.target, positions([['a', 0, 100]]));

  const end = sampleBrainMotion(state, 600);
  assert.deepEqual(end.positions, positions([['a', 0, 100]]));
});

test('every finite lane becomes idle on its exact fixed-end frame', () => {
  let selection = createBrainMotionState({ now: 0 });
  selection = apply(selection, { type: 'select', now: 0, nodeId: 'a' });
  const selectionBeforeEnd = sampleBrainMotion(selection, 419);
  assert.ok(selectionBeforeEnd.aurora.selectedCorona > 0);
  assert.equal(selectionBeforeEnd.needsFrame, true);
  const selectionEnd = sampleBrainMotion(selectionBeforeEnd.state, 420);
  assert.equal(selectionEnd.state.selectionTransient, null);
  assert.equal(selectionEnd.aurora.selectedCorona, 0);
  assert.equal(selectionEnd.needsFrame, false);

  let hover = createBrainMotionState({ now: 0 });
  hover = apply(hover, { type: 'hover', now: 0, nodeId: 'a' });
  const hoverBeforeEnd = sampleBrainMotion(hover, 149);
  assert.ok(hoverBeforeEnd.aurora.hoverBloom > 0);
  assert.equal(hoverBeforeEnd.needsFrame, true);
  const hoverEnd = sampleBrainMotion(hoverBeforeEnd.state, 150);
  assert.equal(hoverEnd.state.hoverStartedAt, null);
  assert.equal(hoverEnd.aurora.hoverBloom, 0);
  assert.equal(hoverEnd.needsFrame, false);

  let layout = createBrainMotionState({
    now: 0,
    positions: positions([['a', 0, 0]]),
  });
  layout = apply(layout, {
    type: 'layout-target', now: 0, target: positions([['a', 50, 25]]),
    origin: { x: 0, y: 0 }, animate: true,
  });
  const layoutBeforeEnd = sampleBrainMotion(layout, 599);
  assert.notEqual(layoutBeforeEnd.state.layoutTween, null);
  assert.equal(layoutBeforeEnd.needsFrame, true);
  const layoutEnd = sampleBrainMotion(layoutBeforeEnd.state, 600);
  assert.equal(layoutEnd.state.layoutTween, null);
  assert.equal(layoutEnd.needsFrame, false);
});

test('caller-owned position Maps are cloned and never mutated by transitions or samples', () => {
  const initial = positions([['a', 0, 0]]);
  const state = createBrainMotionState({ now: 0, positions: initial });
  assert.notStrictEqual(state.positions, initial);
  initial.set('intruder', { x: 1, y: 1, r: 0, a: 0 });
  assert.equal(state.positions.has('intruder'), false);

  const target = positions([['a', 100, 50]]);
  const tweening = apply(state, {
    type: 'layout-target', now: 0, target, origin: { x: 0, y: 0 }, animate: true,
  });
  assert.notStrictEqual(tweening.layoutTween.target, target);
  target.set('intruder', { x: 2, y: 2, r: 0, a: 0 });
  assert.equal(tweening.layoutTween.target.has('intruder'), false);

  const beforeMap = tweening.positions;
  const middle = sampleBrainMotion(tweening, 300);
  assert.strictEqual(tweening.positions, beforeMap);
  assert.deepEqual(tweening.positions, positions([['a', 0, 0]]));
  assert.notStrictEqual(middle.positions, beforeMap);

  const spunTarget = positions([['a', 0, 100]]);
  const retargeted = apply(tweening, { type: 'spin-layout-target', target: spunTarget });
  assert.notStrictEqual(retargeted.layoutTween.target, spunTarget);
  spunTarget.clear();
  assert.deepEqual(retargeted.layoutTween.target, positions([['a', 0, 100]]));
});

test('motion state and sample expose only the specified public keys', () => {
  let state = createBrainMotionState({ now: 0, layout: 'rings' });
  assert.equal(Object.isFrozen(MOTION_MS), true);
  assert.deepEqual(Object.keys(state), [
    'layout', 'reducedMotion', 'visible', 'spin', 'spinPhase', 'lastTick',
    'nodeCount', 'positions', 'layoutTween', 'ringTransient', 'selectionTransient',
    'selectedId', 'hoveredId', 'hoverStartedAt', 'pausedAt',
  ]);
  state = apply(state, { type: 'ring-transient', now: 0, kind: 'load' });
  const sample = sampleBrainMotion(state, 10);
  assert.deepEqual(Object.keys(sample), [
    'state', 'positions', 'aurora', 'routeTrace', 'needsFrame', 'minFrameInterval',
  ]);
  assert.deepEqual(Object.keys(sample.aurora), [
    'enabled', 'ringSweep', 'coreFlash', 'selectedCorona', 'hoverBloom',
    'spinPhase', 'staticOnly',
  ]);
  assert.deepEqual(Object.keys(sample.aurora.ringSweep), [
    'kind', 'progress', 'allowNodeSparks',
  ]);
});

test('invalid events are ignored and numeric controls are bounded', () => {
  const state = createBrainMotionState({ now: 10, spin: 5, nodeCount: -4 });
  assert.equal(state.spin, 1);
  assert.equal(state.nodeCount, 0);
  assert.strictEqual(apply(state, null), state);
  assert.strictEqual(apply(state, { type: 'unknown', now: 20 }), state);
  assert.strictEqual(apply(state, { type: 'ring-transient', kind: 'invalid' }), state);

  const withSpin = apply(state, { type: 'set-spin', now: 20, value: -3 });
  assert.equal(withSpin.spin, 0);
  assert.equal(withSpin.lastTick, 20);
  const withCount = apply(withSpin, { type: 'set-node-count', value: -1 });
  assert.equal(withCount.nodeCount, 0);
});
