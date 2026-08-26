import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutRings } from '../public/js/graph-layout.js';

function makeContext(ops = null) {
  const gradient = { addColorStop() {} };
  const methods = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    measureText: (text) => ({ width: String(text).length * 7 }),
    beginPath: () => { if (ops) ops.beginPath += 1; },
    stroke: () => { if (ops) ops.stroke += 1; },
  };
  return new Proxy(methods, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function installRendererEnvironment() {
  const prior = new Map();
  const save = (key, value) => {
    prior.set(key, {
      present: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const rootStyle = { getPropertyValue: () => '' };
  const offscreen = () => ({ width: 0, height: 0, getContext: () => makeContext() });
  save('window', {
    devicePixelRatio: 2,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  });
  save('document', {
    documentElement: {},
    createElement: () => offscreen(),
  });
  save('getComputedStyle', () => rootStyle);
  save('Path2D', class FakePath2D {});
  return () => {
    for (const [key, old] of prior) {
      if (old.present) globalThis[key] = old.value;
      else delete globalThis[key];
    }
  };
}

function makeCanvas() {
  const ops = { beginPath: 0, stroke: 0 };
  const context = makeContext(ops);
  return {
    width: 0,
    height: 0,
    parentElement: null,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 1200, height: 800 }),
    _ops: ops,
  };
}

const RINGS = ['skills', 'memory', 'routines', 'applications'];

function fixture(count) {
  const nodes = [{
    id: 'agent-core', label: 'AGENT CORE', ring: 'core', kind: 'dir', depth: 0, files: count,
  }];
  for (let index = 1; index < count; index++) {
    const ring = RINGS[index % RINGS.length];
    nodes.push({
      id: `node-${index}`, label: `node-${index}`, ring, kind: 'dir', depth: 1,
      files: index % 23, department: ring === 'memory' ? 'PRODUCT' : null,
    });
  }
  const counts = {};
  for (const node of nodes) counts[node.ring] = (counts[node.ring] || 0) + 1;
  const geom = { width: 1200, height: 800, cx: 450, cy: 404, radius: 348, counts };
  return { nodes, positions: layoutRings(nodes, { ...geom, spin: 0, spacing: 11 }), geom };
}

function drawState(data, overrides = {}) {
  return {
    nodes: data.nodes,
    positions: data.positions,
    geom: data.geom,
    view: { x: 0, y: 0, k: 1 },
    hover: null,
    selected: null,
    showLabels: false,
    viewMode: 'departments',
    layout: 'rings',
    dimIds: null,
    opts: { ...data.geom, spin: 0, spacing: 11 },
    aurora: {
      enabled: true,
      ringSweep: { kind: 'load', progress: 0.55, allowNodeSparks: true },
      coreFlash: 0.7,
      selectedCorona: 0,
      hoverBloom: 0,
      spinPhase: 0,
      staticOnly: false,
    },
    ...overrides,
  };
}

test('aura operations are bounded independently of node count', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    for (const count of [100, 10_000]) {
      const reports = [];
      const renderer = createRenderer(makeCanvas(), { onAuraOps: (ops) => reports.push(ops) });
      renderer.draw(drawState(fixture(count)));
      const ops = reports.at(-1);
      assert.ok(ops.gradients <= 6, JSON.stringify(ops));
      assert.ok(ops.arcs <= 12, JSON.stringify(ops));
      assert.ok(ops.sprites <= 12, JSON.stringify(ops));
      renderer.destroy();
    }
  } finally { restore(); }
});

test('a 3500-edge selection trace adds at most one path and stroke operation', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    const data = fixture(3501);
    const edges = data.nodes.slice(1).map((node) => ({
      source: 'agent-core', target: node.id,
    }));
    const canvas = makeCanvas();
    const renderer = createRenderer(canvas);
    const base = drawState(data, {
      edges,
      selected: 'node-3500',
      aurora: null,
    });
    renderer.draw(base);
    const baseline = { ...canvas._ops };
    canvas._ops.beginPath = 0;
    canvas._ops.stroke = 0;
    renderer.draw({
      ...base,
      routeTrace: { id: 'node-3500', progress: 0.5 },
    });
    assert.ok(canvas._ops.beginPath <= baseline.beginPath + 1);
    assert.ok(canvas._ops.stroke <= baseline.stroke + 1);
    renderer.destroy();
  } finally { restore(); }
});

test('non-ring layouts suppress semantic ring arcs but retain a core flash', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    const reports = [];
    const renderer = createRenderer(makeCanvas(), { onAuraOps: (ops) => reports.push(ops) });
    renderer.draw(drawState(fixture(100), {
      layout: 'hex',
      aurora: {
        enabled: true, ringSweep: null, coreFlash: 0.8, selectedCorona: 0,
        hoverBloom: 0, spinPhase: 0, staticOnly: false,
      },
    }));
    assert.equal(reports.at(-1).gradients, 0);
    assert.equal(reports.at(-1).arcs, 0);
    assert.equal(reports.at(-1).sprites, 1);
    renderer.destroy();
  } finally { restore(); }
});

test('selection adds exactly two corona arcs and hover adds exactly one sprite over static aura', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    const data = fixture(100);
    const reports = [];
    const renderer = createRenderer(makeCanvas(), { onAuraOps: (ops) => reports.push(ops) });
    renderer.draw(drawState(data, {
      selected: 'node-1',
      hover: 'node-2',
      aurora: {
        enabled: true, ringSweep: null, coreFlash: 0, selectedCorona: 0,
        hoverBloom: 0, spinPhase: 0, staticOnly: true,
      },
    }));
    const baseline = reports.at(-1);
    assert.deepEqual(baseline, { gradients: 4, arcs: 4, sprites: 4 });
    renderer.draw(drawState(data, {
      selected: 'node-1',
      hover: 'node-2',
      aurora: {
        enabled: true, ringSweep: null, coreFlash: 0, selectedCorona: 0.5,
        hoverBloom: 0.5, spinPhase: 0, staticOnly: false,
      },
    }));
    const active = reports.at(-1);
    assert.equal(active.gradients, baseline.gradients);
    assert.equal(active.arcs, baseline.arcs + 2);
    assert.equal(active.sprites, baseline.sprites + 1);
    renderer.destroy();
  } finally { restore(); }
});

test('disabled aura performs zero aura operations', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    const reports = [];
    const renderer = createRenderer(makeCanvas(), { onAuraOps: (ops) => reports.push(ops) });
    renderer.draw(drawState(fixture(100), { aurora: null }));
    assert.deepEqual(reports.at(-1), { gradients: 0, arcs: 0, sprites: 0 });
    renderer.destroy();
  } finally { restore(); }
});

test('node-spark lookup batches every semantic ring into one additional node traversal', async () => {
  const restore = installRendererEnvironment();
  try {
    const { createRenderer } = await import('../public/js/graph-render.js');
    const data = fixture(100);
    let traversals = 0;
    const countedNodes = new Proxy(data.nodes, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) {
          return function countedIterator() {
            traversals += 1;
            return target[Symbol.iterator]();
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const renderer = createRenderer(makeCanvas());
    renderer.draw(drawState({ ...data, nodes: countedNodes }, { aurora: null }));
    const baselineTraversals = traversals;
    traversals = 0;
    renderer.draw(drawState({ ...data, nodes: countedNodes }));
    assert.equal(traversals, baselineTraversals + 1);
    renderer.destroy();
  } finally { restore(); }
});
