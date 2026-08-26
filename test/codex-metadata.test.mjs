import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as codexMetadata from '../server/lib/codex-metadata.js';
import {
  clearCodexMetadataCache,
  compareApplications,
  getCodexMetadata,
  onCodexMetadataChange,
  parseCodexAutomation,
  parseCodexMcpJson,
  parseCodexPluginJson,
} from '../server/lib/codex-metadata.js';

function makeExecutableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-codex-exec-'));
  const executable = path.join(root, 'fake codex');
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    "const mode = process.argv[2];",
    "if (mode === 'echo') process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    "else if (mode === 'hang') setInterval(() => {}, 1000);",
    "else if (mode === 'stdout-over') process.stdout.write('x'.repeat(1024 * 1024 + 1));",
    "else if (mode === 'stderr-over') {",
    "  process.stdout.write('{}');",
    "  process.stderr.write('x'.repeat(1024 * 1024 + 1));",
    '}',
  ].join('\n'), { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, executable };
}

test('automation parser retains only honest routine fields', () => {
  const routine = parseCodexAutomation([
    'id = "morning"',
    'name = "Morning review"',
    'status = "ACTIVE"',
    'rrule = "FREQ=DAILY;BYHOUR=9"',
    'prompt = "secret prompt"',
    'cwds = ["/Users/private/work"]',
    'target = "private"',
  ].join('\n'), 'fallback');
  assert.deepEqual(routine, {
    id: 'codex:morning', name: 'Morning review', schedule: 'FREQ=DAILY;BYHOUR=9',
    runner: 'desktop', lastRunAt: null, nextRunAt: null, status: 'idle', provider: 'codex',
  });
  assert.equal(JSON.stringify(routine).includes('secret prompt'), false);
  assert.equal(JSON.stringify(routine).includes('/Users/private'), false);
});

test('automation parser rejects malformed approved scalars and empty files', () => {
  assert.equal(parseCodexAutomation('prompt = "secret"\ncwds = ["/private"]', 'fallback'), null);
  assert.equal(parseCodexAutomation('id = "unterminated\nname = "Morning"', 'fallback'), null);
  assert.equal(parseCodexAutomation('id = ../../escape\nname = Morning', 'fallback'), null);
});

test('Codex 0.149 parsers accept only enabled installed plugins and top-level MCP arrays', () => {
  assert.deepEqual(parseCodexPluginJson({
    installed: [
      { pluginId: 'browser@bundled', name: 'Browser', version: '1.0', installed: true, enabled: true },
      { pluginId: 'odd@bundled', name: 'Odd', version: '/private/version', installed: true, enabled: true },
      { pluginId: 'disabled@bundled', name: 'Disabled', version: '1.0', installed: true, enabled: false },
      { pluginId: 'not-installed@bundled', name: 'Not installed', version: '1.0', installed: false, enabled: true },
    ],
    available: [{ pluginId: 'available@bundled', name: 'Available', version: '9.9' }],
  }), [{
    id: 'codex:plugin:browser@bundled', name: 'Browser', provider: 'codex', kind: 'plugin', version: '1.0',
  }, {
    id: 'codex:plugin:odd@bundled', name: 'Odd', provider: 'codex', kind: 'plugin', version: null,
  }]);
  assert.deepEqual(parseCodexPluginJson([{ pluginId: 'wrong-shape', installed: true, enabled: true }]), []);
  assert.deepEqual(parseCodexMcpJson([
    { name: 'docs', enabled: true },
    { name: 'disabled', enabled: false },
  ]), [{ id: 'codex:mcp:docs', name: 'docs', provider: 'codex', kind: 'mcp', version: null }]);
  assert.deepEqual(parseCodexMcpJson({ servers: [{ name: 'wrong-wrapper', enabled: true }] }), []);
});

test('metadata keeps enabled identity and discards paths and auth material', async () => {
  clearCodexMetadataCache();
  const calls = [];
  const execJson = async (args) => {
    calls.push(args);
    if (args[0] === 'plugin') return {
      installed: [{ pluginId: 'browser@bundled', name: 'browser', version: '1.0', installed: true,
        enabled: true, source: { path: '/Users/private/cache' } }],
      available: [{ pluginId: 'not-installed', name: 'must-not-appear', version: '9.9' }],
    };
    return [
      { name: 'docs', enabled: true, auth_status: 'authenticated',
        transport: { type: 'stdio', command: 'secret-command', env: { TOKEN: 'secret' } } },
      { name: 'disabled', enabled: false, disabled_reason: 'operator choice',
        transport: { type: 'http', url: 'https://secret.invalid' } },
    ];
  };
  const out = await getCodexMetadata({ bin: '/fake/codex', execJson, now: () => 100, force: true });
  assert.deepEqual(out.applications.map(({ id, name, provider, kind, version }) =>
    ({ id, name, provider, kind, version })), [
    { id: 'codex:plugin:browser@bundled', name: 'browser', provider: 'codex', kind: 'plugin', version: '1.0' },
    { id: 'codex:mcp:docs', name: 'docs', provider: 'codex', kind: 'mcp', version: null },
  ]);
  assert.equal(JSON.stringify(out).includes('/Users/private'), false);
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.equal(JSON.stringify(out).includes('must-not-appear'), false);
  assert.equal(JSON.stringify(out).includes('disabled'), false);
  assert.deepEqual(calls, [['plugin', 'list', '--json'], ['mcp', 'list', '--json']]);
});

test('metadata preserves one command contribution when the other command fails', async () => {
  clearCodexMetadataCache();
  const pluginsOnly = await getCodexMetadata({
    bin: '/fake/codex', force: true, now: () => 100,
    execJson: (args) => {
      if (args[0] === 'mcp') throw new Error('private stderr must not escape');
      return Promise.resolve({ installed: [{
        pluginId: 'browser@bundled', name: 'browser', version: '1', installed: true, enabled: true,
      }], available: [] });
    },
  });
  assert.deepEqual(pluginsOnly.applications.map((row) => row.id), ['codex:plugin:browser@bundled']);
  assert.deepEqual(pluginsOnly.mcpNames, []);

  clearCodexMetadataCache();
  const mcpOnly = await getCodexMetadata({
    bin: '/fake/codex', force: true, now: () => 200,
    execJson: (args) => {
      if (args[0] === 'plugin') throw new Error('private stdout must not escape');
      return Promise.resolve([{ name: 'docs', enabled: true }]);
    },
  });
  assert.deepEqual(mcpOnly.applications.map((row) => row.id), ['codex:mcp:docs']);
  assert.deepEqual(mcpOnly.mcpNames, ['docs']);
});

test('Application order and fingerprint are invariant to CLI row order', async () => {
  const pluginRows = [
    { pluginId: 'z@bundled', name: 'zeta', version: '2', installed: true, enabled: true },
    { pluginId: 'a@bundled', name: 'alpha', version: '1', installed: true, enabled: true },
  ];
  const mcpRows = [
    { name: 'zeta-mcp', enabled: true },
    { name: 'alpha-mcp', enabled: true },
  ];
  const read = async (reversed) => getCodexMetadata({
    bin: '/fake/codex', force: true, now: () => 100,
    execJson: async (args) => args[0] === 'plugin'
      ? { installed: reversed ? [...pluginRows].reverse() : pluginRows, available: [] }
      : reversed ? [...mcpRows].reverse() : mcpRows,
  });
  clearCodexMetadataCache();
  const first = await read(false);
  clearCodexMetadataCache();
  const second = await read(true);
  assert.deepEqual(first.applications.map((row) => row.id), [
    'codex:plugin:a@bundled', 'codex:plugin:z@bundled',
    'codex:mcp:alpha-mcp', 'codex:mcp:zeta-mcp',
  ]);
  assert.deepEqual(second.applications, first.applications);
  assert.equal(second.fingerprint, first.fingerprint);
});

test('Application comparison uses provider, kind, and code-point lexical tie-breaks', () => {
  const rows = [
    { id: 'codex:mcp:z', name: 'same', provider: 'codex', kind: 'mcp', version: null },
    { id: 'claude:mcp:z', name: 'same', provider: 'claude', kind: 'mcp', version: null },
    { id: 'codex:plugin:z', name: 'same', provider: 'codex', kind: 'plugin', version: '2' },
    { id: 'codex:plugin:a', name: 'same', provider: 'codex', kind: 'plugin', version: '1' },
  ];
  assert.deepEqual([...rows].sort(compareApplications).map((row) => row.id), [
    'claude:mcp:z', 'codex:plugin:a', 'codex:plugin:z', 'codex:mcp:z',
  ]);
});

test('metadata fingerprint listener skips baseline, reports changes once, and unsubscribes', async () => {
  clearCodexMetadataCache();
  const notices = [];
  const unsubscribe = onCodexMetadataChange((notice) => notices.push(notice));
  const read = (name, now) => getCodexMetadata({
    bin: '/fake/codex', force: true, now: () => now,
    execJson: async (args) => args[0] === 'plugin'
      ? { installed: [], available: [] }
      : [{ name, enabled: true }],
  });

  const first = await read('docs', 100);
  assert.deepEqual(notices, []);
  const second = await read('search', 200);
  assert.deepEqual(notices, [{
    previousFingerprint: first.fingerprint,
    fingerprint: second.fingerprint,
  }]);
  unsubscribe();
  await read('calendar', 300);
  assert.equal(notices.length, 1);
  clearCodexMetadataCache();
});

test('metadata cache returns plain DTOs and refreshes only after its TTL', async () => {
  clearCodexMetadataCache();
  let calls = 0;
  let clock = 100;
  const execJson = async (args) => {
    calls += 1;
    return args[0] === 'plugin' ? { installed: [], available: [] } : [{ name: 'docs', enabled: true }];
  };
  const first = await getCodexMetadata({ bin: '/fake/codex', execJson, now: () => clock });
  clock += 59_999;
  const second = await getCodexMetadata({ bin: '/fake/codex', execJson, now: () => clock });
  assert.strictEqual(second, first);
  assert.equal(typeof second.then, 'undefined');
  assert.equal(calls, 2);
  clock += 2;
  const third = await getCodexMetadata({ bin: '/fake/codex', execJson, now: () => clock });
  assert.notStrictEqual(third, first);
  assert.equal(calls, 4);
  clearCodexMetadataCache();
});

test('production Codex JSON execution passes literal argv without a shell', async (t) => {
  const { root, executable } = makeExecutableFixture(t);
  const marker = path.join(root, 'shell-marker');
  const shellText = `$(touch ${marker})`;
  const args = ['echo', shellText, `; touch ${marker}`];

  assert.deepEqual(await codexMetadata.execCodexJson(executable, args), args);
  assert.equal(fs.existsSync(marker), false);
});

test('production Codex JSON execution enforces the 2000ms timeout', async (t) => {
  const { executable } = makeExecutableFixture(t);
  const started = Date.now();
  await assert.rejects(
    codexMetadata.execCodexJson(executable, ['hang']),
    (error) => error?.killed === true && error?.signal === 'SIGTERM',
  );
  const elapsed = Date.now() - started;
  assert.equal(elapsed >= 1_800, true, elapsed);
  assert.equal(elapsed < 3_500, true, elapsed);
});

test('production Codex JSON execution caps stdout and stderr independently at 1 MiB', async (t) => {
  const { executable } = makeExecutableFixture(t);
  for (const stream of ['stdout-over', 'stderr-over']) {
    await assert.rejects(
      codexMetadata.execCodexJson(executable, [stream]),
      (error) => error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stream,
    );
  }
});
