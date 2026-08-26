import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureAlternatingPair,
  measurementBlocks,
  prebuildStates,
  summarizeFixture,
} from './brain-aurora-benchmark-protocol.mjs';

test('prebuildStates materializes every state before measurement callbacks use them', () => {
  const events = [];
  const states = prebuildStates(3, (index) => {
    events.push(`build:${index}`);
    return { index };
  });

  events.push('timing');
  for (const state of states) events.push(`draw:${state.index}`);

  assert.deepEqual(states, [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.deepEqual(events, [
    'build:0', 'build:1', 'build:2',
    'timing',
    'draw:0', 'draw:1', 'draw:2',
  ]);
});

test('measurement blocks contain each sample once and alternate post-yield arm parity', () => {
  const blocks = measurementBlocks(120, 12);
  const flattened = blocks.flat();

  assert.equal(blocks.length, 10);
  assert.ok(blocks.every((block) => block.length === 12));
  assert.deepEqual(blocks.map((block) => block[0] % 2), [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(new Set(flattened).size, 120);
  assert.deepEqual(
    flattened.slice().sort((a, b) => a - b),
    Array.from({ length: 120 }, (_, index) => index),
  );
  assert.equal(flattened.filter((index) => index % 2 === 0).length, 60);
  assert.equal(flattened.filter((index) => index % 2 === 1).length, 60);
});

test('measurement alternates AB and BA while timing draw submission only', () => {
  const events = [];
  const clock = [0, 2, 2, 7, 10, 14, 14, 20];
  const now = () => clock.shift();
  const arms = {
    baseline() { events.push('baseline'); },
    aura() { events.push('aura'); },
    now,
  };

  assert.deepEqual(measureAlternatingPair(0, arms), { baselineMs: 2, auraMs: 5 });
  assert.deepEqual(measureAlternatingPair(1, arms), { baselineMs: 6, auraMs: 4 });
  assert.deepEqual(events, [
    'baseline', 'aura',
    'aura', 'baseline',
  ]);
});

test('fixture delta compares arm p95 values instead of order-sensitive paired differences', () => {
  const baselineTimes = Array.from({ length: 120 }, (_, index) => index % 2 === 0 ? 100 : 0);
  const auraTimes = Array.from({ length: 120 }, (_, index) => index % 2 === 0 ? 0 : 100);
  const maxOps = { gradients: 4, arcs: 4, sprites: 9 };

  assert.deepEqual(summarizeFixture(baselineTimes, auraTimes, maxOps), {
    baselineP95: 100,
    auraP95: 100,
    deltaP95: 0,
    maxOps,
  });
});

test('fixture delta retains positive aura overhead and clamps a faster aura arm to zero', () => {
  const maxOps = { gradients: 4, arcs: 4, sprites: 9 };
  assert.equal(summarizeFixture(Array(120).fill(2), Array(120).fill(3.25), maxOps).deltaP95, 1.25);
  assert.equal(summarizeFixture(Array(120).fill(3), Array(120).fill(2), maxOps).deltaP95, 0);
});
