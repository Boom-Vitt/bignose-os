import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import express from 'express';

const originalHome = process.env.HOME;
const originalHookToken = process.env.CLAUDEOS_HOOK_TOKEN;
const originalCodexBin = process.env.CLAUDEOS_CODEX_BIN;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-catalog-test-home-'));
process.env.HOME = isolatedHome;
process.env.CLAUDEOS_HOOK_TOKEN = 'synthetic-hook-token-for-catalog-tests';
process.env.CLAUDEOS_CODEX_BIN = path.join(isolatedHome, 'missing-codex');

const { default: chokidar } = await import('chokidar');
const { CONFIG } = await import('../server/lib/config.js');
const catalogModule = await import('../server/lib/catalog.js');
const { createCatalogRouter } = await import('../server/routes/catalog.js');
const { codexPaths, skillIdentity } = await import('../server/lib/providers.js');

const PROJECT_FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
// Local noon stays well clear of a local-date boundary in every test TZ.
const NOW = new Date(2026, 7, 21, 12, 0, 0, 0).getTime();
const SYNTHETIC_SECRET = 'syntheticcatalogsecret123456';

const SKILL_KEYS = [
  'name', 'description', 'scope', 'path', 'argumentHint', 'allowedTools',
  'userInvokable', 'disableModelInvocation', 'model', 'effort', 'provider',
];
const AGENT_KEYS = ['name', 'description', 'model', 'tools', 'memory', 'path', 'provider'];

after(() => {
  catalogModule.stopCatalogWatch();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalHookToken === undefined) delete process.env.CLAUDEOS_HOOK_TOKEN;
  else process.env.CLAUDEOS_HOOK_TOKEN = originalHookToken;
  if (originalCodexBin === undefined) delete process.env.CLAUDEOS_CODEX_BIN;
  else process.env.CLAUDEOS_CODEX_BIN = originalCodexBin;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

function makeCatalogTree(label) {
  const root = fs.mkdtempSync(path.join(isolatedHome, `${label}-`));
  const claudeDir = path.join(root, '.claude');
  const stateDir = path.join(root, '.boombignose_claudeos');
  const tree = {
    root,
    claudeDir,
    stateDir,
    skillsDir: path.join(claudeDir, 'skills'),
    agentsDir: path.join(claudeDir, 'agents'),
    commandsDir: path.join(claudeDir, 'commands'),
    pluginsDir: path.join(claudeDir, 'plugins'),
    scheduledDir: path.join(claudeDir, 'scheduled-tasks'),
    settingsPath: path.join(claudeDir, 'settings.json'),
    sidecarPath: path.join(stateDir, 'sidecar.json'),
  };
  for (const dir of [
    tree.skillsDir,
    tree.agentsDir,
    tree.commandsDir,
    tree.pluginsDir,
    tree.scheduledDir,
    tree.stateDir,
  ]) fs.mkdirSync(dir, { recursive: true });
  return tree;
}

function configFor(tree, repoRoot = path.join(tree.root, 'missing-project-root')) {
  return {
    HOME: tree.root,
    REPO_ROOT: repoRoot,
    SKILLS_DIR: tree.skillsDir,
    AGENTS_DIR: tree.agentsDir,
    COMMANDS_DIR: tree.commandsDir,
    PLUGINS_DIR: tree.pluginsDir,
    SCHEDULED_DIR: tree.scheduledDir,
    SETTINGS_PATH: tree.settingsPath,
    SIDECAR_PATH: tree.sidecarPath,
  };
}

async function withCatalogConfig(overrides, fn) {
  const original = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, CONFIG[key]]),
  );
  catalogModule.stopCatalogWatch();
  Object.assign(CONFIG, overrides);
  catalogModule.invalidateCatalog();
  try {
    return await fn();
  } finally {
    catalogModule.stopCatalogWatch();
    Object.assign(CONFIG, original);
    catalogModule.invalidateCatalog();
  }
}

async function withHttpServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function requestJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.once('error', reject);
    request.end(encoded);
  });
}

test('deriveRoutineStatuses is pure and selects one deterministic future scheduled routine', () => {
  assert.equal(typeof catalogModule.deriveRoutineStatuses, 'function');

  const rows = [
    { id: 'z-tie', schedule: '0 * * * *', lastRunAt: null, nextRunAt: NOW + 60_000, status: 'idle' },
    { id: 'a-tie', schedule: '0 * * * *', lastRunAt: null, nextRunAt: NOW + 60_000, status: 'idle' },
    { id: 'fired', schedule: '0 * * * *', lastRunAt: NOW - 60_000, nextRunAt: NOW - 1, status: 'idle' },
    { id: 'queued', schedule: '0 * * * *', lastRunAt: null, nextRunAt: null, status: 'idle' },
    { id: 'idle', schedule: null, lastRunAt: null, nextRunAt: null, status: 'queued' },
  ];
  const before = structuredClone(rows);

  const result = catalogModule.deriveRoutineStatuses(rows, NOW);

  assert.notStrictEqual(result, rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(result.map((row) => row.id), rows.map((row) => row.id));
  for (let index = 0; index < rows.length; index++) assert.notStrictEqual(result[index], rows[index]);
  assert.deepEqual(
    Object.fromEntries(result.map((row) => [row.id, row.status])),
    {
      'z-tie': 'queued',
      'a-tie': 'next',
      fired: 'fired',
      queued: 'queued',
      idle: 'idle',
    },
  );
  assert.equal(result.filter((row) => row.status === 'next').length, 1);
});

test('deriveRoutineStatuses treats a finite future one-off run as next without a schedule string', () => {
  const result = catalogModule.deriveRoutineStatuses([
    { id: 'one-off', schedule: null, lastRunAt: null, nextRunAt: NOW + 60_000, status: 'idle' },
  ], NOW);

  assert.equal(result[0].status, 'next');
});

test('deriveRoutineStatuses preserves fired-today status for an unscheduled routine', () => {
  const result = catalogModule.deriveRoutineStatuses([
    { id: 'manual', schedule: null, lastRunAt: NOW - 60_000, nextRunAt: null, status: 'idle' },
  ], NOW);

  assert.equal(result[0].status, 'fired');
});

test('deriveRoutineStatuses clones malformed rows to honest idle objects without throwing', () => {
  const rows = [null, 42, []];
  const before = structuredClone(rows);
  let result;

  assert.doesNotThrow(() => {
    result = catalogModule.deriveRoutineStatuses(rows, NOW);
  });
  assert.deepEqual(result, [
    { status: 'idle' },
    { status: 'idle' },
    { status: 'idle' },
  ]);
  assert.deepEqual(rows, before);
  for (const row of result) assert.equal(typeof row, 'object');
});

test('deriveRoutineStatuses leaves every row honest when no scheduled run is in the future', () => {
  assert.equal(typeof catalogModule.deriveRoutineStatuses, 'function');

  const result = catalogModule.deriveRoutineStatuses([
    { id: 'unscheduled', schedule: null, lastRunAt: null, nextRunAt: null, status: 'next' },
    { id: 'past', schedule: '* * * * *', lastRunAt: null, nextRunAt: NOW, status: 'next' },
  ], NOW);

  assert.deepEqual(result.map((row) => row.status), ['idle', 'queued']);
  assert.equal(result.some((row) => row.status === 'next'), false);
});

test('buildMcpServers unions only real MCP sources, scrubs, deduplicates, sorts, and does not mutate', () => {
  assert.equal(typeof catalogModule.buildMcpServers, 'function');

  const settings = {
    mcpServers: { zeta: {}, alpha: {}, [`token=${SYNTHETIC_SECRET}`]: {} },
    enabledPlugins: { 'not-an-mcp@market': true },
  };
  const claudeJsonNames = ['beta', 'alpha', 'beta'];
  const settingsBefore = structuredClone(settings);
  const namesBefore = structuredClone(claudeJsonNames);

  assert.deepEqual(
    catalogModule.buildMcpServers(settings, claudeJsonNames),
    ['alpha', 'beta', 'token=[redacted]', 'zeta'],
  );
  assert.deepEqual(settings, settingsBefore);
  assert.deepEqual(claudeJsonNames, namesBefore);
});

test('buildMcpServers ignores enabled plugins and malformed source values', () => {
  assert.equal(typeof catalogModule.buildMcpServers, 'function');

  assert.deepEqual(
    catalogModule.buildMcpServers({
      mcpServers: {},
      enabledPlugins: { 'not-an-mcp@market': true },
    }, []),
    [],
  );
  assert.deepEqual(catalogModule.buildMcpServers(null, null), []);
  assert.deepEqual(catalogModule.buildMcpServers({ mcpServers: [] }, { malformed: true }), []);
});

test('buildMcpServers skips non-string secondary names and malformed MCP records without mutation', () => {
  const extraNames = ['valid-server', null, 42, { name: 'object' }, ['nested'], '', '   '];
  const before = structuredClone(extraNames);

  assert.deepEqual(
    catalogModule.buildMcpServers({ mcpServers: ['value'] }, extraNames),
    ['valid-server'],
  );
  assert.deepEqual(extraNames, before);
  for (const malformed of [null, [], 'settings', 42, { mcpServers: 'value' }]) {
    assert.doesNotThrow(() => catalogModule.buildMcpServers(malformed, []));
    assert.deepEqual(catalogModule.buildMcpServers(malformed, []), []);
  }
});

test('discoverProjectCatalog uses frozen DTOs and the existing safe builders', () => {
  assert.equal(typeof catalogModule.discoverProjectCatalog, 'function');

  const sidecar = { 'project-fixture': { model: 'sonnet', effort: 'high' } };
  const sidecarBefore = structuredClone(sidecar);
  const result = catalogModule.discoverProjectCatalog(PROJECT_FIXTURE_ROOT, sidecar);

  assert.deepEqual(Object.keys(result), ['skills', 'agents']);
  assert.equal(result.skills.length, 1);
  assert.equal(result.agents.length, 1);

  const [skill] = result.skills;
  assert.deepEqual(Object.keys(skill), SKILL_KEYS);
  assert.equal(skill.name, 'project-fixture');
  assert.equal(skill.scope, 'project');
  assert.equal(skill.description, 'Project fixture token=[redacted]');
  assert.equal(skill.argumentHint, 'contact [email]');
  assert.deepEqual(skill.allowedTools, ['Read', 'token=[redacted]']);
  assert.equal(skill.userInvokable, false);
  assert.equal(skill.disableModelInvocation, true);
  assert.equal(skill.model, 'sonnet');
  assert.equal(skill.effort, 'high');
  assert.equal(skill.provider, 'claude');
  assert.equal(path.isAbsolute(skill.path), false);
  assert.equal(skill.path.endsWith('/.claude/skills/project-fixture/SKILL.md'), true);

  const [agent] = result.agents;
  assert.deepEqual(Object.keys(agent), AGENT_KEYS);
  assert.equal(agent.name, 'project-fixture');
  assert.equal(agent.description, 'Project agent token=[redacted]');
  assert.equal(agent.model, 'sonnet');
  assert.deepEqual(agent.tools, ['Read', 'token=[redacted]']);
  assert.equal(agent.memory, '~/.claude/agent-memory');
  assert.equal(agent.provider, 'claude');
  assert.equal(Object.hasOwn(agent, 'scope'), false);
  assert.equal(path.isAbsolute(agent.path), false);
  assert.deepEqual(sidecar, sidecarBefore);
});

test('discoverProjectCatalog degrades missing and malformed catalog directories to empty', () => {
  assert.equal(typeof catalogModule.discoverProjectCatalog, 'function');

  const malformedRoot = fs.mkdtempSync(path.join(isolatedHome, 'malformed-project-'));
  fs.mkdirSync(path.join(malformedRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(malformedRoot, '.claude', 'skills'), 'not a directory', 'utf8');
  fs.writeFileSync(path.join(malformedRoot, '.claude', 'agents'), 'not a directory', 'utf8');

  assert.deepEqual(
    catalogModule.discoverProjectCatalog(path.join(isolatedHome, 'missing-project'), {}),
    { skills: [], agents: [] },
  );
  assert.deepEqual(catalogModule.discoverProjectCatalog(malformedRoot, {}), { skills: [], agents: [] });
  assert.deepEqual(catalogModule.discoverProjectCatalog(null, {}), { skills: [], agents: [] });
});

test('catalog keeps same-name Claude and Codex skill DTOs separate', (t) => {
  const root = fs.mkdtempSync(path.join(isolatedHome, 'provider-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudePath = path.join(root, 'claude-review', 'SKILL.md');
  const codexPath = path.join(root, 'codex-review', 'SKILL.md');
  for (const [file, description] of [[claudePath, 'Claude review'], [codexPath, 'Codex review']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: review\ndescription: ${description}\n---\n`, 'utf8');
  }

  const sidecar = {
    'claude:review': { model: 'opus', effort: 'high' },
    'codex:review': { model: 'gpt-5.6-sol', effort: 'xhigh' },
  };
  const claude = catalogModule.buildSkill(claudePath, 'review', 'user', sidecar, 'claude');
  const codex = catalogModule.buildSkill(codexPath, 'review', 'user', sidecar, 'codex');
  const catalogEntries = catalogModule.dedupeCatalogEntries([[claude, codex]]);

  assert.deepEqual(catalogEntries.map((entry) => ({
    name: entry.name, provider: entry.provider, model: entry.model, effort: entry.effort,
  })), [
    { name: 'review', provider: 'claude', model: 'opus', effort: 'high' },
    { name: 'review', provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
  ]);
});

test('PATCH catalog skill uses selected provider and defaults omitted provider to Claude', async () => {
  const tree = makeCatalogTree('provider-patch-route');
  const skills = [
    { name: 'review', provider: 'claude' },
    { name: 'review', provider: 'codex' },
  ];
  const catalog = { skills, agents: [], routines: [], mcpServers: [] };

  await withCatalogConfig(configFor(tree), async () => {
    const app = express();
    app.use('/api', createCatalogRouter({ catalogLoader: async () => catalog }));
    await withHttpServer(app, async (port) => {
      const codex = await requestJson(port, '/api/catalog/skill/review?provider=codex', {
        model: 'gpt-5.6-sol', effort: 'xhigh',
      });
      assert.equal(codex.status, 200);
      assert.equal(codex.body.provider, 'codex');

      const explicitClaude = await requestJson(port, '/api/catalog/skill/review?provider=claude', {
        model: 'opus',
      });
      assert.equal(explicitClaude.status, 200);
      assert.equal(explicitClaude.body.provider, 'claude');

      const implicitClaude = await requestJson(port, '/api/catalog/skill/review', { effort: 'high' });
      assert.equal(implicitClaude.status, 200);
      assert.equal(implicitClaude.body.provider, 'claude');
    });

    const persisted = JSON.parse(fs.readFileSync(tree.sidecarPath, 'utf8'));
    assert.deepEqual(persisted['codex:review'], { model: 'gpt-5.6-sol', effort: 'xhigh' });
    assert.deepEqual(persisted['claude:review'], { model: 'opus', effort: 'high' });
    assert.equal(Object.hasOwn(persisted, 'review'), false);

    const claudeOnly = express();
    claudeOnly.use('/api', createCatalogRouter({
      catalogLoader: async () => ({ ...catalog, skills: [skills[0]] }),
    }));
    await withHttpServer(claudeOnly, async (port) => {
      const denied = await requestJson(port, '/api/catalog/skill/review?provider=codex', {
        model: 'gpt-5.6-sol',
      });
      assert.equal(denied.status, 404);
      assert.deepEqual(JSON.parse(fs.readFileSync(tree.sidecarPath, 'utf8')), persisted);
    });
  });
});

test('PATCH catalog skill contains private sidecar failures while preserving safe validation errors', async () => {
  const privatePath = '/Users/private/operator/sidecar.json';
  const catalog = {
    skills: [{ name: 'review', provider: 'claude' }],
    agents: [], routines: [], mcpServers: [], applications: [],
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const app = express();
    app.use('/api', createCatalogRouter({
      catalogLoader: async () => catalog,
      sidecarWriter() { throw new Error(`write failed at ${privatePath}`); },
    }));
    await withHttpServer(app, async (port) => {
      const failedWrite = await requestJson(port, '/api/catalog/skill/review', { model: 'opus' });
      assert.equal(failedWrite.status, 500);
      assert.deepEqual(failedWrite.body, {
        error: 'skill settings update failed',
        code: 'SKILL_SETTINGS_WRITE_FAILED',
      });
      assert.equal(JSON.stringify(failedWrite.body).includes(privatePath), false);

      const invalidModel = await requestJson(port, '/api/catalog/skill/review', {
        model: '/Users/private/not-a-model',
      });
      assert.equal(invalidModel.status, 400);
      assert.deepEqual(invalidModel.body, { error: 'invalid model' });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(JSON.stringify(warnings).includes(privatePath), false);
});

test('buildCatalog no longer promotes an unscheduled routine to next', async () => {
  const tree = makeCatalogTree('honest-routine');
  const routineDir = path.join(tree.scheduledDir, 'unscheduled');
  fs.mkdirSync(routineDir, { recursive: true });
  fs.writeFileSync(path.join(routineDir, 'config.json'), JSON.stringify({ name: 'Unscheduled' }), 'utf8');
  fs.writeFileSync(tree.settingsPath, '{}', 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    const catalog = await catalogModule.getCatalog();
    assert.equal(catalog.routines.length, 1);
    assert.equal(catalog.routines[0].status, 'idle');
  });
});

test('buildCatalog does not expose an enabled plugin as an MCP server', async () => {
  const tree = makeCatalogTree('honest-mcp');
  fs.writeFileSync(tree.settingsPath, JSON.stringify({
    enabledPlugins: { 'not-an-mcp@market': true },
  }), 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    const catalog = await catalogModule.getCatalog();
    assert.deepEqual(catalog.mcpServers, []);
  });
});

test('buildCatalog unions MCP names from synthetic settings and claude.json sources', async () => {
  const tree = makeCatalogTree('real-mcp-sources');
  fs.writeFileSync(tree.settingsPath, JSON.stringify({
    mcpServers: { 'settings-server': {} },
    enabledPlugins: { 'not-an-mcp@market': true },
  }), 'utf8');
  fs.writeFileSync(path.join(tree.root, '.claude.json'), JSON.stringify({
    mcpServers: {
      'claude-json-server': {},
      'settings-server': {},
    },
  }), 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    const catalog = await catalogModule.getCatalog();
    assert.deepEqual(catalog.mcpServers, ['claude-json-server', 'settings-server']);
  });
});

test('buildCatalog degrades malformed settings containers without fabricating MCP names', async () => {
  const tree = makeCatalogTree('malformed-mcp-containers');
  const localSettingsPath = path.join(tree.claudeDir, 'settings.local.json');
  const claudeJsonPath = path.join(tree.root, '.claude.json');
  const numericPluginInstall = path.join(tree.root, 'numeric-plugin');
  const numericPluginSkillDir = path.join(numericPluginInstall, 'skills', 'fabricated-plugin');
  fs.mkdirSync(numericPluginSkillDir, { recursive: true });
  fs.writeFileSync(path.join(numericPluginSkillDir, 'SKILL.md'), [
    '---',
    'name: fabricated-plugin',
    'description: Must stay disabled',
    '---',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(tree.pluginsDir, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      0: [{
        installPath: numericPluginInstall,
        installedAt: '2026-08-21T00:00:00.000Z',
      }],
    },
  }), 'utf8');
  const cases = [
    { label: 'base MCP array', base: { mcpServers: ['value'] }, local: {} },
    { label: 'local MCP string', base: {}, local: { mcpServers: 'nested' } },
    { label: 'enabled plugin array', base: { enabledPlugins: [true] }, local: {} },
    { label: 'array roots', base: ['value'], local: ['nested'] },
    { label: 'string roots', base: 'value', local: 'nested' },
    { label: 'null roots', base: null, local: null },
    { label: 'Claude JSON MCP array', base: {}, local: {}, claude: { mcpServers: ['nested'] } },
  ];

  await withCatalogConfig(configFor(tree), async () => {
    for (const entry of cases) {
      fs.writeFileSync(tree.settingsPath, JSON.stringify(entry.base), 'utf8');
      fs.writeFileSync(localSettingsPath, JSON.stringify(entry.local), 'utf8');
      if (entry.claude === undefined) fs.rmSync(claudeJsonPath, { force: true });
      else fs.writeFileSync(claudeJsonPath, JSON.stringify(entry.claude), 'utf8');
      catalogModule.invalidateCatalog();

      const catalog = await catalogModule.getCatalog();
      assert.deepEqual(catalog.mcpServers, [], entry.label);
      assert.deepEqual(catalog.skills, [], entry.label);
      for (const fabricated of ['0', '42', 'nested', '[object Object]']) {
        assert.equal(catalog.mcpServers.includes(fabricated), false, entry.label);
      }
    }
  });
});

test('buildCatalog integrates project entries with project-over-plugin and user-over-project precedence', async () => {
  const tree = makeCatalogTree('project-precedence');
  const pluginInstall = path.join(tree.root, 'plugin-install');
  const pluginSkillDir = path.join(pluginInstall, 'skills', 'duplicate');
  fs.mkdirSync(pluginSkillDir, { recursive: true });
  fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), [
    '---',
    'name: project-fixture',
    'description: Plugin loser',
    '---',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(tree.pluginsDir, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'fixture-plugin@market': [{
        installPath: pluginInstall,
        installedAt: '2026-08-21T00:00:00.000Z',
      }],
    },
  }), 'utf8');
  fs.writeFileSync(tree.settingsPath, JSON.stringify({
    enabledPlugins: { 'fixture-plugin@market': true },
  }), 'utf8');

  await withCatalogConfig(configFor(tree, PROJECT_FIXTURE_ROOT), async () => {
    const projectCatalog = await catalogModule.getCatalog();
    const projectSkills = projectCatalog.skills.filter((entry) => entry.name === 'project-fixture');
    const projectAgents = projectCatalog.agents.filter((entry) => entry.name === 'project-fixture');
    assert.equal(projectSkills.length, 1);
    assert.equal(projectSkills[0].scope, 'project');
    assert.equal(projectSkills[0].description, 'Project fixture token=[redacted]');
    assert.equal(projectAgents.length, 1);
    assert.equal(projectAgents[0].description, 'Project agent token=[redacted]');

    const userSkillDir = path.join(tree.skillsDir, 'user-winner');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), [
      '---',
      'name: project-fixture',
      'description: User winner',
      '---',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(tree.agentsDir, 'user-winner.md'), [
      '---',
      'name: project-fixture',
      'description: User agent winner',
      '---',
      '',
    ].join('\n'), 'utf8');
    catalogModule.invalidateCatalog();

    const userCatalog = await catalogModule.getCatalog();
    const userSkills = userCatalog.skills.filter((entry) => entry.name === 'project-fixture');
    const userAgents = userCatalog.agents.filter((entry) => entry.name === 'project-fixture');
    assert.equal(userSkills.length, 1);
    assert.equal(userSkills[0].scope, 'user');
    assert.equal(userSkills[0].description, 'User winner');
    assert.equal(userAgents.length, 1);
    assert.equal(userAgents[0].description, 'User agent winner');
  });
});

test('same-tier redaction collisions choose the same raw-path winner regardless of manifest order', async () => {
  const tree = makeCatalogTree('plugin-redaction-collision');
  const plugins = {
    alpha: {
      key: 'alpha-plugin@market',
      installPath: path.join(tree.root, 'collision-sources', 'Users', 'alpha', 'identical-tail'),
      description: 'Alpha winner',
    },
    zeta: {
      key: 'zeta-plugin@market',
      installPath: path.join(tree.root, 'collision-sources', 'Users', 'zeta', 'identical-tail'),
      description: 'Zeta loser',
    },
  };

  for (const [rawUser, plugin] of Object.entries(plugins)) {
    const skillDir = path.join(plugin.installPath, 'skills', 'same-bundle');
    fs.mkdirSync(skillDir, { recursive: true });
    plugin.skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(plugin.skillPath, [
      '---',
      `name: /Users/${rawUser}/same-name`,
      `description: ${plugin.description}`,
      '---',
      '',
    ].join('\n'), 'utf8');
  }
  const alphaDto = catalogModule.buildSkill(plugins.alpha.skillPath, 'alpha', 'plugin', {});
  const zetaDto = catalogModule.buildSkill(plugins.zeta.skillPath, 'zeta', 'plugin', {});
  assert.equal(alphaDto.name, zetaDto.name);
  assert.equal(alphaDto.path, zetaDto.path);
  assert.notEqual(alphaDto.description, zetaDto.description);
  assert.deepEqual(Object.keys(alphaDto), SKILL_KEYS);
  assert.deepEqual(Object.keys(zetaDto), SKILL_KEYS);
  fs.writeFileSync(tree.settingsPath, JSON.stringify({
    enabledPlugins: {
      [plugins.alpha.key]: true,
      [plugins.zeta.key]: true,
    },
  }), 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    const winners = [];
    for (const order of [['zeta', 'alpha'], ['alpha', 'zeta']]) {
      const manifestPlugins = {};
      for (const id of order) {
        const plugin = plugins[id];
        manifestPlugins[plugin.key] = [{
          installPath: plugin.installPath,
          installedAt: '2026-08-21T00:00:00.000Z',
        }];
      }
      fs.writeFileSync(path.join(tree.pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: manifestPlugins,
      }), 'utf8');
      catalogModule.invalidateCatalog();

      const catalog = await catalogModule.getCatalog();
      const collisions = catalog.skills.filter((entry) => entry.name === '~/same-name');
      assert.equal(collisions.length, 1);
      winners.push(collisions[0].description);
    }

    assert.deepEqual(winners, ['Alpha winner', 'Alpha winner']);
  });
});

test('plugin symlink aliases choose the same latest lexical candidate across manifest and version order', async () => {
  const tree = makeCatalogTree('plugin-symlink-identity');
  const canonicalSkillDir = path.join(tree.root, 'canonical-unnamed-skill');
  fs.mkdirSync(canonicalSkillDir, { recursive: true });
  fs.writeFileSync(path.join(canonicalSkillDir, 'SKILL.md'), [
    '---',
    'description: Shared unnamed skill',
    '---',
    '',
  ].join('\n'), 'utf8');

  const makeAliasInstall = (dirName, aliasName) => {
    const installPath = path.join(tree.root, 'plugin-installs', dirName);
    const skillsDir = path.join(installPath, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(canonicalSkillDir, path.join(skillsDir, aliasName), 'dir');
    return { installPath };
  };

  const alphaA = makeAliasInstall('alpha-a-new', 'alpha-winning-alias');
  const alphaZ = makeAliasInstall('alpha-z-new', 'alpha-losing-version-alias');
  const alphaOld = makeAliasInstall('alpha-old', 'alpha-old-alias');
  const zetaNew = makeAliasInstall('zeta-new', 'zeta-alias');
  const zetaOld = makeAliasInstall('zeta-old', 'zeta-old-alias');
  const newest = '2026-08-21T12:00:00.000Z';
  const older = '2026-01-01T00:00:00.000Z';
  const alphaVersions = [
    { ...alphaZ, lastUpdated: newest },
    { ...alphaA, lastUpdated: newest },
    { ...alphaOld, lastUpdated: older },
  ];
  const zetaVersions = [
    { ...zetaOld, installedAt: older },
    { ...zetaNew, installedAt: newest },
  ];
  const pluginKeys = {
    alpha: 'alpha-symlink@market',
    zeta: 'zeta-symlink@market',
  };
  fs.writeFileSync(tree.settingsPath, JSON.stringify({
    enabledPlugins: {
      [pluginKeys.alpha]: true,
      [pluginKeys.zeta]: true,
    },
  }), 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    const winners = [];
    const orders = [
      {
        keys: ['zeta', 'alpha'],
        versions: { alpha: alphaVersions, zeta: zetaVersions },
      },
      {
        keys: ['alpha', 'zeta'],
        versions: { alpha: [...alphaVersions].reverse(), zeta: [...zetaVersions].reverse() },
      },
    ];

    for (const order of orders) {
      const manifestPlugins = {};
      for (const id of order.keys) manifestPlugins[pluginKeys[id]] = order.versions[id];
      fs.writeFileSync(path.join(tree.pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: manifestPlugins,
      }), 'utf8');
      catalogModule.invalidateCatalog();

      const catalog = await catalogModule.getCatalog();
      assert.equal(catalog.skills.length, 1);
      const [winner] = catalog.skills;
      assert.deepEqual(Object.keys(winner), SKILL_KEYS);
      assert.equal(winner.path.includes(isolatedHome), false);
      winners.push({
        name: winner.name,
        lexicalPathWon: winner.path.endsWith('/alpha-a-new/skills/alpha-winning-alias/SKILL.md'),
      });
    }

    assert.deepEqual(winners, [
      { name: 'alpha-winning-alias', lexicalPathWon: true },
      { name: 'alpha-winning-alias', lexicalPathWon: true },
    ]);
  });
});

test('buildCatalog degrades malformed settings and claude.json sources to an empty catalog', async () => {
  const tree = makeCatalogTree('malformed-sources');
  fs.writeFileSync(tree.settingsPath, '{ malformed settings', 'utf8');
  fs.writeFileSync(path.join(tree.root, '.claude.json'), '{ malformed claude json', 'utf8');

  await withCatalogConfig(configFor(tree), async () => {
    assert.deepEqual(await catalogModule.getCatalog(), {
      skills: [],
      agents: [],
      routines: [],
      mcpServers: [],
      applications: [],
    });
  });
});

test('buildCatalog discovers confined Codex skills, automations, and provider-aware Applications', async (t) => {
  const tree = makeCatalogTree('codex-provider');
  const paths = codexPaths(tree.root);
  const claudeReview = path.join(tree.skillsDir, 'review');
  const codexReview = path.join(paths.skillsDir, 'review');
  const codexSystemReview = path.join(paths.skillsDir, '.system', 'system-review');
  const outsideSkill = path.join(tree.root, 'outside-codex-skill');
  const automationDir = path.join(paths.automationsDir, 'morning');
  const deniedSkillTarget = path.join(paths.skillsDir, 'sessions', 'hidden');
  const deniedSkillFileTarget = path.join(paths.skillsDir, 'backing', 'auth.json');
  const skillFileAlias = path.join(paths.skillsDir, 'file-alias');
  const deniedAutomationTarget = path.join(paths.automationsDir, 'backing', 'cache', 'task.toml');
  const automationAlias = path.join(paths.automationsDir, 'automation-alias');
  for (const dir of [claudeReview, codexReview, codexSystemReview, outsideSkill, automationDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(claudeReview, 'SKILL.md'),
    '---\nname: review\ndescription: Claude review\n---\n', 'utf8');
  fs.writeFileSync(path.join(codexReview, 'SKILL.md'),
    '---\nname: review\ndescription: Codex review\n---\n', 'utf8');
  fs.writeFileSync(path.join(codexSystemReview, 'SKILL.md'),
    '---\nname: system-review\ndescription: Codex system review\n---\n', 'utf8');
  fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'),
    '---\nname: escaped\ndescription: Must stay outside\n---\n', 'utf8');
  fs.symlinkSync(outsideSkill, path.join(paths.skillsDir, 'escaped'), 'dir');
  fs.mkdirSync(deniedSkillTarget, { recursive: true });
  fs.writeFileSync(path.join(deniedSkillTarget, 'SKILL.md'),
    '---\nname: denied-dir-alias\ndescription: Must stay denied\n---\n', 'utf8');
  fs.symlinkSync(deniedSkillTarget, path.join(paths.skillsDir, 'skill-dir-alias'), 'dir');
  fs.mkdirSync(path.dirname(deniedSkillFileTarget), { recursive: true });
  fs.mkdirSync(skillFileAlias, { recursive: true });
  fs.writeFileSync(deniedSkillFileTarget,
    '---\nname: denied-file-alias\ndescription: Must stay denied\n---\n', 'utf8');
  fs.symlinkSync(deniedSkillFileTarget, path.join(skillFileAlias, 'SKILL.md'), 'file');
  fs.writeFileSync(path.join(automationDir, 'automation.toml'), [
    'id = "morning"', 'name = "Morning"', 'rrule = "FREQ=DAILY"',
    'prompt = "must-not-escape"', 'cwds = ["/Users/private"]',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.dirname(deniedAutomationTarget), { recursive: true });
  fs.mkdirSync(automationAlias, { recursive: true });
  fs.writeFileSync(deniedAutomationTarget, [
    'id = "denied-automation-alias"', 'name = "Denied automation alias"',
    'rrule = "FREQ=DAILY"',
  ].join('\n'), 'utf8');
  fs.symlinkSync(deniedAutomationTarget, path.join(automationAlias, 'automation.toml'), 'file');
  fs.writeFileSync(tree.settingsPath, JSON.stringify({ mcpServers: { docs: {} } }), 'utf8');

  const nestedForbidden = [
    path.join(paths.root, 'rules', 'team', 'sessions', 'event.jsonl'),
    path.join(codexReview, 'private', 'auth.json'),
    path.join(paths.root, 'memories', 'note', 'archive', 'history.jsonl'),
    path.join(automationDir, 'cache', 'state_5.sqlite-wal'),
    path.join(paths.root, 'rules', 'team', 'browser', 'state.json'),
    path.join(codexReview, 'computer-use', 'state.json'),
    path.join(paths.root, 'memories', 'note', 'generated_images', 'frame.png'),
    path.join(automationDir, 'process_manager', 'state.json'),
    path.join(paths.root, 'rules', 'team', 'shell_snapshots', 'snapshot.txt'),
    path.join(paths.root, 'memories', 'note', 'log', 'latest.txt'),
    path.join(codexReview, 'vendor_imports', 'module.md'),
  ];
  for (const file of nestedForbidden) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'nested-secret-token', 'utf8');
  }
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  await withCatalogConfig(configFor(tree), async () => {
    const catalog = await catalogModule.buildCatalog({
      metadataLoader: async () => ({
        applications: [
          { id: 'codex:mcp:docs', name: 'docs', provider: 'codex', kind: 'mcp', version: null },
        ],
        mcpNames: ['docs'],
        fingerprint: 'fixture',
      }),
    });

    assert.deepEqual(catalog.skills.map((skill) => skillIdentity(skill.provider, skill.name)), [
      'claude:review', 'codex:review', 'codex:system-review',
    ]);
    assert.equal(catalog.skills.some((skill) => skill.name === 'escaped'), false);
    assert.equal(catalog.skills.some((skill) => skill.name === 'denied-dir-alias'), false);
    assert.equal(catalog.skills.some((skill) => skill.name === 'denied-file-alias'), false);
    assert.deepEqual(catalog.routines.filter((row) => row.provider === 'codex'), [{
      id: 'codex:morning', name: 'Morning', schedule: 'FREQ=DAILY', runner: 'desktop',
      lastRunAt: null, nextRunAt: null, status: 'idle', provider: 'codex',
    }]);
    assert.equal(catalog.routines.some((row) => row.id === 'codex:denied-automation-alias'), false);
    assert.deepEqual(catalog.mcpServers, ['docs']);
    assert.deepEqual(catalog.applications.map((row) => row.id), [
      'claude:mcp:docs', 'codex:mcp:docs',
    ]);
    const serializedCatalog = JSON.stringify(catalog);
    for (const forbidden of [
      'browser', 'computer-use', 'generated_images', 'process_manager',
      'shell_snapshots', 'log', 'vendor_imports', 'nested-secret-token',
      'must-not-escape', '/Users/private',
    ]) assert.equal(serializedCatalog.includes(forbidden), false, forbidden);
  });
});

const CATALOG_A = {
  skills: [], agents: [], routines: [], mcpServers: [], applications: [], marker: 'a',
};

test('getCatalog awaits one shared async build and catches rejection before caching', async () => {
  catalogModule.invalidateCatalog();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const build = async () => {
    builds += 1;
    await gate;
    return CATALOG_A;
  };
  const first = catalogModule.getCatalog({ build });
  const second = catalogModule.getCatalog({ build });
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(builds, 1);
  assert.strictEqual(left, CATALOG_A);
  assert.strictEqual(right, CATALOG_A);
  assert.equal(typeof left.then, 'undefined');

  catalogModule.invalidateCatalog();
  const originalWarn = console.warn;
  console.warn = () => {};
  let fallback;
  try {
    fallback = await catalogModule.getCatalog({ build: async () => { throw new Error('metadata failed'); } });
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(fallback, CATALOG_A);
});

test('getCatalog preserves invalidation that arrives during an async build', async () => {
  catalogModule.invalidateCatalog();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const first = catalogModule.getCatalog({ build: async () => {
    builds += 1;
    await gate;
    return { ...CATALOG_A, marker: 'during' };
  } });
  catalogModule.invalidateCatalog();
  release();
  await first;
  const second = await catalogModule.getCatalog({ build: async () => {
    builds += 1;
    return { ...CATALOG_A, marker: 'after' };
  } });
  assert.equal(builds, 2);
  assert.equal(second.marker, 'after');
});

test('Codex catalog roots invalidate once and denied nested paths are ignored', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-catalog-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => catalogModule.stopCatalogWatch());
  const paths = codexPaths(home);
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  fs.mkdirSync(paths.automationsDir, { recursive: true });

  const handlers = new Map();
  const events = [];
  let watched = [];
  let options = null;
  let scheduled = null;
  const fakeWatcher = {
    on(type, handler) { handlers.set(type, handler); return this; },
    close() {},
  };
  catalogModule.startCatalogWatch({
    home,
    repoRoot: null,
    watch(roots, nextOptions) { watched = roots; options = nextOptions; return fakeWatcher; },
    emitEvent(type, payload) { events.push({ type, payload }); },
    setTimer(fn) { scheduled = fn; return { unref() {} }; },
    clearTimer() { scheduled = null; },
  });

  assert.deepEqual(watched.filter((root) => root.startsWith(paths.root)), [
    paths.skillsDir, paths.automationsDir,
  ]);
  assert.equal(watched.includes(paths.root), false);
  assert.equal(options.depth, 3);
  assert.equal(options.ignored(path.join(paths.skillsDir, 'review', 'sessions', 'x')), true);

  catalogModule.invalidateCatalog();
  await catalogModule.getCatalog({ build: async () => CATALOG_A });
  handlers.get('add')(path.join(paths.skillsDir, '.system', 'review', 'SKILL.md'));
  handlers.get('change')(path.join(paths.automationsDir, 'morning', 'automation.toml'));
  handlers.get('change')(path.join(paths.skillsDir, 'review', 'sessions', 'x'));
  let rebuilds = 0;
  await catalogModule.getCatalog({ build: async () => { rebuilds += 1; return { ...CATALOG_A, marker: 'b' }; } });
  assert.equal(rebuilds, 1);
  assert.equal(typeof scheduled, 'function');
  scheduled();
  assert.deepEqual(events, [{ type: 'catalog.invalidated', payload: { reason: 'fs' } }]);
});

test('catalog watcher emits one fixed warning per watcher after repeated errors', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-catalog-watch-error-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => catalogModule.stopCatalogWatch());
  const paths = codexPaths(home);
  fs.mkdirSync(paths.skillsDir, { recursive: true });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const start = () => {
    const handlers = new Map();
    const fakeWatcher = {
      on(type, handler) { handlers.set(type, handler); return this; },
      close() {},
    };
    catalogModule.startCatalogWatch({
      home,
      repoRoot: null,
      watch() { return fakeWatcher; },
    });
    return handlers;
  };

  try {
    const first = start();
    first.get('error')(new Error('/Users/private/first-watcher-error'));
    first.get('error')(new Error('/Users/private/repeated-watcher-error'));
    assert.deepEqual(warnings, ['[claudeos:catalog] watcher error']);

    catalogModule.stopCatalogWatch();
    const second = start();
    second.get('error')(new Error('/Users/private/new-watcher-error'));
    assert.deepEqual(warnings, [
      '[claudeos:catalog] watcher error',
      '[claudeos:catalog] watcher error',
    ]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(JSON.stringify(warnings).includes('/Users/private'), false);
});

test('catalog watcher includes existing project catalog directories without creating missing ones', async () => {
  const tree = makeCatalogTree('project-watch');
  const missingSkills = path.join(tree.root, 'missing-user-skills');
  const missingAgents = path.join(tree.root, 'missing-user-agents');
  const missingCommands = path.join(tree.root, 'missing-user-commands');
  const missingRoutines = path.join(tree.root, 'missing-routines');
  const originalWatch = chokidar.watch;
  const originalWarn = console.warn;
  let watchedPaths = null;

  chokidar.watch = (paths) => {
    watchedPaths = Array.isArray(paths) ? [...paths] : [paths];
    const fake = {
      on() { return fake; },
      close() {},
    };
    return fake;
  };
  console.warn = () => {};

  try {
    await withCatalogConfig({
      REPO_ROOT: PROJECT_FIXTURE_ROOT,
      SKILLS_DIR: missingSkills,
      AGENTS_DIR: missingAgents,
      COMMANDS_DIR: missingCommands,
      SCHEDULED_DIR: missingRoutines,
    }, async () => {
      catalogModule.startCatalogWatch();
      assert.ok(watchedPaths);
      assert.deepEqual(watchedPaths.sort(), [
        path.join(PROJECT_FIXTURE_ROOT, '.claude', 'agents'),
        path.join(PROJECT_FIXTURE_ROOT, '.claude', 'skills'),
      ].sort());
      assert.equal(fs.existsSync(missingSkills), false);
      assert.equal(fs.existsSync(missingAgents), false);
      assert.equal(fs.existsSync(missingCommands), false);
      assert.equal(fs.existsSync(missingRoutines), false);
    });
  } finally {
    catalogModule.stopCatalogWatch();
    chokidar.watch = originalWatch;
    console.warn = originalWarn;
  }
});
