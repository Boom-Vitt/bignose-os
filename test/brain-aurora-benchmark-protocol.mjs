export function percentile(values, quantile) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

export function measureAlternatingPair(index, {
  baseline,
  aura,
  now = () => performance.now(),
}) {
  const order = index % 2 === 0
    ? [['baselineMs', baseline], ['auraMs', aura]]
    : [['auraMs', aura], ['baselineMs', baseline]];
  const measured = {};
  for (const [key, draw] of order) {
    const startedAt = now();
    draw();
    measured[key] = Math.max(0, now() - startedAt);
  }
  return { baselineMs: measured.baselineMs, auraMs: measured.auraMs };
}

export function prebuildStates(count, build) {
  return Array.from({ length: count }, (_, index) => build(index));
}

export function measurementBlocks(count, blockSize) {
  const blocks = [];
  for (let start = 0, blockIndex = 0; start < count; start += blockSize, blockIndex++) {
    const length = Math.min(blockSize, count - start);
    const offset = blockIndex % 2;
    blocks.push(Array.from(
      { length },
      (_, localIndex) => start + ((localIndex + offset) % length),
    ));
  }
  return blocks;
}

export function summarizeFixture(baselineTimes, auraTimes, maxOps) {
  const baselineP95 = percentile(baselineTimes, 0.95);
  const auraP95 = percentile(auraTimes, 0.95);
  return {
    baselineP95,
    auraP95,
    deltaP95: Math.max(0, auraP95 - baselineP95),
    maxOps,
  };
}
