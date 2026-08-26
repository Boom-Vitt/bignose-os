import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CLAUDEOS_CODEX_BIN = path.join(os.tmpdir(), 'missing-codex-for-scanner-tests');

const { CONFIG } = await import('../server/lib/config.js');
const {
  buildGraphFromSources,
  buildGraphSources,
  getGraph,
  invalidateGraph,
  startScanner,
  stopScanner,
} = await import('../server/lib/scanner.js');

const scannerFixtureHomes = new Set();

function makeScannerHome(prefix = 'agent-os-scanner-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scannerFixtureHomes.add(home);
  return home;
}

function fixtureHomeWithClaudeAndCodex() {
  const home = makeScannerHome();
  const claudeReview = path.join(home, '.claude', 'skills', 'review');
  const codexReview = path.join(home, '.codex', 'skills', 'review');
  const codexSystemReview = path.join(home, '.codex', 'skills', '.system', 'system-review');
  const codexMemory = path.join(home, '.codex', 'memories', 'note');
  for (const dir of [claudeReview, codexReview, codexSystemReview, codexMemory]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(claudeReview, 'SKILL.md'), '# Claude review\n', 'utf8');
  fs.writeFileSync(path.join(codexReview, 'SKILL.md'), '# Codex review\n', 'utf8');
  fs.writeFileSync(path.join(codexSystemReview, 'SKILL.md'), '# Codex system review\n', 'utf8');
  fs.writeFileSync(path.join(codexMemory, 'note.md'), '# Memory\n', 'utf8');
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# Codex instructions\n', 'utf8');
  fs.mkdirSync(path.join(home, '.codex', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "safe"\n', 'utf8');
  return home;
}

function fixtureHomeContainingCodexSecrets() {
  const home = fixtureHomeWithClaudeAndCodex();
  const codex = path.join(home, '.codex');
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"token":"secret-token"}', 'utf8');
  fs.writeFileSync(path.join(codex, 'history.jsonl'), 'secret-token\n', 'utf8');
  fs.writeFileSync(path.join(codex, 'state_5.sqlite'), 'secret-token', 'utf8');
  for (const name of [
    'sessions', 'archived_sessions', 'attachments', 'browser', 'ipc', 'worktrees',
  ]) {
    const dir = path.join(codex, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret-token.txt'), 'secret-token', 'utf8');
  }
  for (const file of [
    path.join(codex, 'rules', 'team', 'sessions', 'event.jsonl'),
    path.join(codex, 'rules', 'team', 'credentials', 'value.json'),
    path.join(codex, 'skills', 'review', 'private', 'auth.json'),
    path.join(codex, 'skills', 'review', 'tokens.json'),
    path.join(codex, 'memories', 'note', 'archive', 'history.jsonl'),
    path.join(codex, 'automations', 'morning', 'cache', 'state_5.sqlite-wal'),
    path.join(codex, 'rules', 'team', 'browser', 'state.json'),
    path.join(codex, 'skills', 'review', 'computer-use', 'state.json'),
    path.join(codex, 'memories', 'note', 'generated_images', 'frame.png'),
    path.join(codex, 'automations', 'morning', 'process_manager', 'state.json'),
    path.join(codex, 'rules', 'team', 'shell_snapshots', 'snapshot.txt'),
    path.join(codex, 'memories', 'note', 'log', 'latest.txt'),
    path.join(codex, 'skills', 'review', 'vendor_imports', 'module.md'),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'nested-secret-token', 'utf8');
  }

  const outside = path.join(home, 'outside-secret');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'leak.md'), 'symlink-secret-token', 'utf8');
  fs.symlinkSync(outside, path.join(codex, 'rules', 'outside-alias'));
  fs.symlinkSync(path.join(codex, 'rules', 'team', 'sessions'),
    path.join(codex, 'rules', 'session-alias'));
  return home;
}

function applicationRows() {
  return [
    { id: 'codex:mcp:docs', name: 'docs', provider: 'codex', kind: 'mcp', version: null },
    { id: 'claude:mcp:docs', name: 'docs', provider: 'claude', kind: 'mcp', version: null },
    { id: 'codex:plugin:browser@bundled', name: 'Browser', provider: 'codex', kind: 'plugin', version: '1.0' },
  ];
}

function graphApplicationProjection(graph) {
  const nodeIds = graph.nodes.filter((node) => node.ring === 'applications').map((node) => node.id);
  const appIds = new Set(nodeIds);
  return {
    nodeIds,
    edges: graph.edges.filter((edge) => appIds.has(edge.source) || appIds.has(edge.target)),
  };
}

after(() => {
  stopScanner();
  for (const home of scannerFixtureHomes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('builds one collision-free provider graph and joins every edge', async () => {
  const home = fixtureHomeWithClaudeAndCodex();
  const graph = await buildGraphFromSources(buildGraphSources({
    home, claudeDir: path.join(home, '.claude'),
  }), { applications: applicationRows(), now: () => 1234 });

  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(ids.has('agent-core'), true);
  assert.equal(ids.has('claude'), true);
  assert.equal(ids.has('codex'), true);
  assert.equal(ids.has('claude/skills/review'), true);
  assert.equal(ids.has('codex/skills/review'), true);
  assert.equal(ids.has('codex/skills/.system/system-review'), true);
  assert.equal(ids.has('codex/applications/mcp/docs'), true);
  assert.equal(ids.has('claude/applications/mcp/docs'), true);
  for (const edge of graph.edges) {
    assert.equal(ids.has(edge.source), true, edge.source);
    assert.equal(ids.has(edge.target), true, edge.target);
  }
  assert.equal(graph.stats.schemaVersion, 2);
  assert.equal(graph.schema, 3);
  assert.equal(graph.builtAt, 1234);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('codex/skills/review').ring, 'skills');
  assert.equal(byId.get('codex/memories/note').ring, 'memory');
  assert.equal(byId.get('claude/skills/review').provider, 'claude');
  assert.equal(byId.get('claude/skills/review').resourceKind, 'filesystem');
  assert.equal(byId.get('claude/skills/review').claudeOnly, true);
  assert.equal(byId.get('codex/skills/review').claudeOnly, false);
  assert.equal(byId.get('agent-core').provider, 'unified');

  const app = byId.get('codex/applications/mcp/docs');
  assert.deepEqual({
    kind: app.kind, ring: app.ring, provider: app.provider,
    resourceKind: app.resourceKind, ext: app.ext, size: app.size,
    mtime: app.mtime, files: app.files, mdFiles: app.mdFiles, bytes: app.bytes,
    path: app.path,
  }, {
    kind: 'dir', ring: 'applications', provider: 'codex', resourceKind: 'mcp',
    ext: null, size: 0, mtime: 0, files: 0, mdFiles: 0, bytes: 0,
    path: 'codex://applications/mcp/docs',
  });
});

test('Codex allowlist excludes sensitive native state and every symlink alias', async () => {
  const home = fixtureHomeContainingCodexSecrets();
  const graph = await buildGraphFromSources(buildGraphSources({ home }));
  const json = JSON.stringify(graph);
  for (const forbidden of ['auth.json', 'sessions', 'credentials', 'tokens.json',
    'history.jsonl', 'state_5.sqlite', 'attachments', 'browser', 'computer-use',
    'generated_images', 'process_manager', 'shell_snapshots', 'log',
    'vendor_imports', 'ipc', 'worktrees', 'outside-alias', 'session-alias',
    'secret-token', 'nested-secret-token', 'symlink-secret-token']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.equal(json.includes(`${home}${path.sep}`), false);
});

test('Application injection is deterministic and does not mutate its input', async () => {
  const home = fixtureHomeWithClaudeAndCodex();
  const applications = Object.freeze(applicationRows().map((row) => Object.freeze(row)));
  const sources = buildGraphSources({ home });
  const forward = await buildGraphFromSources(sources, { applications, now: () => 10 });
  const reverseInput = [...applications].reverse();
  const reverse = await buildGraphFromSources(sources, { applications: reverseInput, now: () => 10 });

  assert.deepEqual(graphApplicationProjection(reverse), graphApplicationProjection(forward));
  assert.deepEqual(applications.map((row) => row.id), applicationRows().map((row) => row.id));
});

test('graph source descriptors expose only the approved mounts', () => {
  const home = makeScannerHome();
  const sources = buildGraphSources({ home, claudeDir: path.join(home, '.claude') });
  const codex = sources.find((source) => source.provider === 'codex');
  assert.ok(codex);
  assert.deepEqual(codex.mounts.map(({ id, kind }) => ({ id, kind })), [
    { id: 'AGENTS.md', kind: 'file' },
    { id: 'rules', kind: 'dir' },
    { id: 'skills', kind: 'dir' },
    { id: 'memories', kind: 'dir' },
    { id: 'automations', kind: 'dir' },
    { id: 'config.toml', kind: 'file' },
  ]);
  assert.equal(codex.mounts.some((mount) => mount.absPath === path.join(home, '.codex')), false);
});

test('scanner watches only existing approved mounts and recursively ignores denied Codex paths', () => {
  stopScanner();
  const home = fixtureHomeWithClaudeAndCodex();
  const handlers = new Map();
  let watched = null;
  let options = null;
  const fakeWatcher = {
    on(event, handler) { handlers.set(event, handler); return this; },
    close() {},
  };

  startScanner({
    home,
    claudeDir: path.join(home, '.claude'),
    watch(roots, nextOptions) { watched = roots; options = nextOptions; return fakeWatcher; },
    onMetadataChange() { return () => {}; },
  });

  const codexRoot = path.join(home, '.codex');
  assert.ok(Array.isArray(watched));
  assert.equal(watched.includes(codexRoot), false);
  assert.deepEqual(watched.filter((entry) => entry.startsWith(codexRoot)), [
    path.join(codexRoot, 'AGENTS.md'),
    path.join(codexRoot, 'rules'),
    path.join(codexRoot, 'skills'),
    path.join(codexRoot, 'memories'),
    path.join(codexRoot, 'config.toml'),
  ]);
  assert.equal(options.followSymlinks, false);
  assert.equal(options.depth, 4);
  assert.equal(options.ignored(path.join(codexRoot, 'skills', '.system', 'review', 'SKILL.md')), false);
  assert.equal(options.ignored(path.join(codexRoot, 'skills', 'review', 'deep', 'sessions', 'event.jsonl')), true);
  assert.equal(options.ignored(path.join(codexRoot, 'rules', 'deep', 'auth.json')), true);
  assert.equal(typeof handlers.get('change'), 'function');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    handlers.get('error')(new Error('/private/first-watcher-error'));
    handlers.get('error')(new Error('/private/second-watcher-error'));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [['[scanner] watcher error']]);
  stopScanner();
});

test('metadata fingerprint changes invalidate graph cache once per callback', async () => {
  stopScanner();
  const home = makeScannerHome('agent-os-scanner-metadata-');
  const claudeSkills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(claudeSkills, { recursive: true });
  const cachePath = path.join(home, 'graph-cache.json');
  const original = {
    HOME: CONFIG.HOME,
    CLAUDE_DIR: CONFIG.CLAUDE_DIR,
    GRAPH_CACHE_PATH: CONFIG.GRAPH_CACHE_PATH,
  };
  Object.assign(CONFIG, { HOME: home, CLAUDE_DIR: path.join(home, '.claude'), GRAPH_CACHE_PATH: cachePath });
  let metadataListener = null;
  const events = [];
  const fakeWatcher = { on() { return this; }, close() {} };

  try {
    invalidateGraph();
    const first = await getGraph();
    assert.equal(first.nodes.some((node) => node.id.endsWith('/one.md')), false);

    startScanner({
      home,
      claudeDir: CONFIG.CLAUDE_DIR,
      watch() { return fakeWatcher; },
      onMetadataChange(listener) { metadataListener = listener; return () => {}; },
      emitEvent(type, payload) { events.push({ type, payload }); },
    });
    assert.equal(typeof metadataListener, 'function');

    fs.writeFileSync(path.join(claudeSkills, 'one.md'), '# one\n', 'utf8');
    metadataListener({ previousFingerprint: 'a', fingerprint: 'b' });
    const second = await getGraph();
    assert.equal(second.nodes.some((node) => node.id === 'claude/skills/one.md'), true);

    fs.writeFileSync(path.join(claudeSkills, 'two.md'), '# two\n', 'utf8');
    metadataListener({ previousFingerprint: 'b', fingerprint: 'c' });
    const third = await getGraph();
    assert.equal(third.nodes.some((node) => node.id === 'claude/skills/two.md'), true);
    assert.deepEqual(events, [
      { type: 'graph.invalidated', payload: { reason: 'provider-metadata' } },
      { type: 'graph.invalidated', payload: { reason: 'provider-metadata' } },
    ]);
  } finally {
    stopScanner();
    Object.assign(CONFIG, original);
    invalidateGraph();
  }
});

test('invalidation during cache persistence retries for every shared caller and replaces stale disk data', async () => {
  stopScanner();
  const home = makeScannerHome('agent-os-scanner-write-race-');
  const claudeSkills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(claudeSkills, { recursive: true });
  const cachePath = path.join(home, 'graph-cache.json');
  const originalConfig = {
    HOME: CONFIG.HOME,
    CLAUDE_DIR: CONFIG.CLAUDE_DIR,
    GRAPH_CACHE_PATH: CONFIG.GRAPH_CACHE_PATH,
  };
  const originalRename = fsPromises.rename;
  let releaseRename;
  const renameGate = new Promise((resolve) => { releaseRename = resolve; });
  let signalRename;
  const renameStarted = new Promise((resolve) => { signalRename = resolve; });
  let heldRename = true;

  Object.assign(CONFIG, {
    HOME: home,
    CLAUDE_DIR: path.join(home, '.claude'),
    GRAPH_CACHE_PATH: cachePath,
  });
  fsPromises.rename = async (...args) => {
    if (heldRename && args[1] === cachePath) {
      heldRename = false;
      signalRename();
      await renameGate;
    }
    return originalRename(...args);
  };

  try {
    invalidateGraph();
    const originalCaller = getGraph();
    await renameStarted;
    const sharedCaller = getGraph();

    fs.writeFileSync(path.join(claudeSkills, 'arrived-during-write.md'), '# fresh\n', 'utf8');
    invalidateGraph();
    releaseRename();

    const [first, second] = await Promise.all([originalCaller, sharedCaller]);
    assert.strictEqual(first, second);
    assert.equal(first.nodes.some((node) => node.id === 'claude/skills/arrived-during-write.md'), true);

    const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(persisted.schema, 3);
    assert.equal(persisted.nodes.some((node) => node.id === 'claude/skills/arrived-during-write.md'), true);

    fs.rmSync(path.join(claudeSkills, 'arrived-during-write.md'));
    const memory = await getGraph();
    assert.strictEqual(memory.nodes, first.nodes);
    assert.equal(memory.nodes.some((node) => node.id === 'claude/skills/arrived-during-write.md'), true);
  } finally {
    releaseRename();
    fsPromises.rename = originalRename;
    Object.assign(CONFIG, originalConfig);
    invalidateGraph();
  }
});

test('metadata subscription remains active with zero filesystem mounts', () => {
  stopScanner();
  const home = makeScannerHome('agent-os-scanner-applications-only-');
  let metadataListener = null;
  let unsubscribeCalls = 0;
  let watchCalls = 0;
  const events = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    startScanner({
      home,
      claudeDir: path.join(home, '.claude'),
      watch() { watchCalls += 1; throw new Error('must not watch'); },
      onMetadataChange(listener) {
        metadataListener = listener;
        return () => { unsubscribeCalls += 1; };
      },
      emitEvent(type, payload) { events.push({ type, payload }); },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(watchCalls, 0);
  assert.equal(typeof metadataListener, 'function');
  metadataListener({ previousFingerprint: 'a', fingerprint: 'b' });
  assert.deepEqual(events, [
    { type: 'graph.invalidated', payload: { reason: 'provider-metadata' } },
  ]);
  assert.deepEqual(warnings, [['[scanner] no approved graph sources to watch']]);
  stopScanner();
  assert.equal(unsubscribeCalls, 1);
});

test('metadata subscription survives filesystem watcher creation failure', () => {
  stopScanner();
  const home = makeScannerHome('agent-os-scanner-watch-failure-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  let metadataListener = null;
  let unsubscribeCalls = 0;
  const events = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    startScanner({
      home,
      claudeDir: path.join(home, '.claude'),
      watch() { throw new Error('/private/watcher-create-failure'); },
      onMetadataChange(listener) {
        metadataListener = listener;
        return () => { unsubscribeCalls += 1; };
      },
      emitEvent(type, payload) { events.push({ type, payload }); },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(typeof metadataListener, 'function');
  metadataListener({ previousFingerprint: 'a', fingerprint: 'b' });
  assert.deepEqual(events, [
    { type: 'graph.invalidated', payload: { reason: 'provider-metadata' } },
  ]);
  assert.deepEqual(warnings, [['[scanner] could not start watcher']]);
  stopScanner();
  assert.equal(unsubscribeCalls, 1);
});

test('failed metadata listener registration leaves filesystem invalidation operational', () => {
  stopScanner();
  const home = fixtureHomeWithClaudeAndCodex();
  const handlers = new Map();
  const events = [];
  const fakeWatcher = {
    on(event, handler) { handlers.set(event, handler); return this; },
    close() {},
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    startScanner({
      home,
      claudeDir: path.join(home, '.claude'),
      watch() { return fakeWatcher; },
      onMetadataChange() { throw new Error('/private/metadata-listener'); },
      emitEvent(type, payload) { events.push({ type, payload }); },
      setTimer(handler) { handler(); return { unref() {} }; },
      clearTimer() {},
    });
  } finally {
    console.warn = originalWarn;
  }

  handlers.get('add')(path.join(home, '.claude', 'skills', 'new.md'));
  assert.deepEqual(events, [{ type: 'graph.invalidated', payload: { reason: 'fs' } }]);
  assert.deepEqual(warnings, [['[scanner] provider metadata listener unavailable']]);
  stopScanner();
});

test('private cache schema 2 is rejected before schema 3 graph is served', async () => {
  stopScanner();
  const home = makeScannerHome('agent-os-scanner-cache-');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'fresh.md'), '# fresh\n', 'utf8');
  const cachePath = path.join(home, 'graph-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    schema: 2,
    builtAt: Date.now(),
    nodes: [{ id: 'legacy-unprefixed', kind: 'dir' }],
    edges: [],
    stats: { schemaVersion: 1 },
  }), 'utf8');
  const original = {
    HOME: CONFIG.HOME,
    CLAUDE_DIR: CONFIG.CLAUDE_DIR,
    GRAPH_CACHE_PATH: CONFIG.GRAPH_CACHE_PATH,
  };
  Object.assign(CONFIG, { HOME: home, CLAUDE_DIR: claudeDir, GRAPH_CACHE_PATH: cachePath });
  try {
    invalidateGraph();
    const graph = await getGraph();
    assert.equal(graph.nodes.some((node) => node.id === 'legacy-unprefixed'), false);
    assert.equal(graph.nodes.some((node) => node.id === 'claude/skills/fresh.md'), true);
    assert.equal(graph.stats.schemaVersion, 2);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).schema, 3);
  } finally {
    Object.assign(CONFIG, original);
    invalidateGraph();
  }
});
