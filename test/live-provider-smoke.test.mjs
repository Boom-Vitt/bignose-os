import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live provider smoke safety helpers pass without provider or Git usage', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/live-provider-smoke.mjs', '--self-test'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(output, 'LIVE_SMOKE_SELF_TEST=ok\n');
});
