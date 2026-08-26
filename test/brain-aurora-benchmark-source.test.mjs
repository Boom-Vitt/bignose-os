import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('./brain-aurora-benchmark.html', import.meta.url), 'utf8');

test('benchmark prebuilds warm-up and measured Aura states outside timed draw callbacks', () => {
  assert.match(html, /const warmAuraStates = prebuildStates\(30,/);
  assert.match(html, /const measuredAuraStates = prebuildStates\(120,/);
  assert.match(html, /aura: \(\) => renderer\.draw\(warmAuraStates\[index\]\)/);
  assert.match(html, /aura: \(\) => renderer\.draw\(measuredAuraStates\[index\]\)/);
  assert.doesNotMatch(html, /aura: \(\) => renderer\.draw\(animated\(/);
});

test('benchmark yields before each balanced twelve-pair measurement block', () => {
  assert.match(
    html,
    /for \(const block of measurementBlocks\(120, 12\)\) \{\s*await new Promise\(requestAnimationFrame\);\s*for \(const index of block\)/,
  );
  assert.doesNotMatch(html, /if \(index % 12 === 0\) await new Promise\(requestAnimationFrame\)/);
});
