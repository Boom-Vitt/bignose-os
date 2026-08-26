import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { buildBrainIndex } from '../server/lib/brain-index.js';

async function withFixtureTree(files, run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'claudeos-brain-'));
  const root = path.join(parent, '.claude');
  await fs.mkdir(root, { recursive: true });
  try {
    for (const [relativePath, body] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, body, 'utf8');
    }
    return await run({ parent, root });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function itemById(payload, id) {
  return payload.items.find((item) => item.id === id);
}

async function requestRouterMany(router, requestPaths) {
  const app = express();
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return await Promise.all(requestPaths.map(async (requestPath) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`, {
        headers: { accept: 'application/json' },
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
      };
    }));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestRouter(router, requestPath = '/api/brain') {
  return (await requestRouterMany(router, [requestPath]))[0];
}

function routeItem(index, overrides = {}) {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `codex/item-${suffix}.md`,
    type: 'source',
    title: `Item ${suffix}`,
    summary: `Summary ${suffix}`,
    project: null,
    status: 'reference',
    tags: [],
    updatedAt: index,
    source: { provider: 'codex', path: `item-${suffix}.md`, modifiedAt: index },
    ...overrides,
  };
}

function routeIndex(items, relations = [], builtAt = 123) {
  return {
    schema: 1,
    builtAt,
    summary: {
      items: items.length,
      projects: items.filter((item) => item.type === 'project').length,
      people: items.filter((item) => item.type === 'person').length,
      ideas: items.filter((item) => item.type === 'idea').length,
      decisions: items.filter((item) => item.type === 'decision').length,
      tasks: items.filter((item) => item.type === 'task').length,
      notes: items.filter((item) => item.type === 'note').length,
      sources: items.filter((item) => item.type === 'source').length,
      needsAttention: items.filter((item) => item.status === 'next' || item.status === 'blocked').length,
    },
    items,
    relations,
  };
}

test('extracts normalized document fields, bounded prose, and source provenance', async () => {
  const longParagraph = `First ${'bounded words '.repeat(30)}tail.`;
  await withFixtureTree({
    'projects/alpha.md': [
      '---',
      'type: PROJECT',
      'project: Alpha workspace',
      'status: ACTIVE',
      'tags: [Launch, launch, "  Product  ", "x" ]',
      '---',
      '# Alpha Brain',
      '',
      longParagraph,
      '',
      'A later paragraph must not be selected.',
    ].join('\n'),
  }, async ({ root }) => {
    const payload = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 1_700_000_000_000,
    });

    assert.equal(payload.schema, 1);
    assert.equal(payload.builtAt, 1_700_000_000_000);
    assert.deepEqual(payload.summary, {
      items: 1,
      projects: 1,
      people: 0,
      ideas: 0,
      decisions: 0,
      tasks: 0,
      notes: 0,
      sources: 0,
      needsAttention: 0,
    });
    const item = itemById(payload, 'claude/projects/alpha.md');
    assert.ok(item);
    assert.deepEqual({
      id: item.id,
      type: item.type,
      title: item.title,
      project: item.project,
      status: item.status,
      tags: item.tags,
      source: item.source,
    }, {
      id: 'claude/projects/alpha.md',
      type: 'project',
      title: 'Alpha Brain',
      project: 'Alpha workspace',
      status: 'active',
      tags: ['launch', 'product', 'x'],
      source: {
        provider: 'claude',
        path: 'projects/alpha.md',
        modifiedAt: item.updatedAt,
      },
    });
    assert.equal(item.summary.length, 240);
    assert.equal(item.summary, longParagraph.slice(0, 239).trimEnd() + '…');
    assert.equal(Object.hasOwn(item, 'body'), false);
  });
});

test('extracts checked and unchecked tasks with deterministic literal fields', async () => {
  await withFixtureTree({
    'projects/alpha.md': [
      '---',
      'type: project',
      'project: Alpha',
      'status: active',
      'tags: [Launch]',
      '---',
      '# Alpha',
      '',
      'Project overview.',
      '',
      '- [ ] Ship dashboard',
      '- [x] Archive old notes',
    ].join('\n'),
  }, async ({ root }) => {
    const payload = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 42,
    });

    assert.deepEqual(payload.items.map((item) => item.id), [
      'claude/projects/alpha.md',
      'claude/projects/alpha.md#task-1',
      'claude/projects/alpha.md#task-2',
    ]);
    assert.deepEqual(itemById(payload, 'claude/projects/alpha.md#task-1'), {
      id: 'claude/projects/alpha.md#task-1',
      type: 'task',
      title: 'Ship dashboard',
      summary: 'Task from Alpha',
      project: 'Alpha',
      status: 'next',
      tags: ['launch'],
      updatedAt: itemById(payload, 'claude/projects/alpha.md').updatedAt,
      source: {
        provider: 'claude',
        path: 'projects/alpha.md',
        modifiedAt: itemById(payload, 'claude/projects/alpha.md').updatedAt,
      },
    });
    assert.deepEqual(itemById(payload, 'claude/projects/alpha.md#task-2'), {
      id: 'claude/projects/alpha.md#task-2',
      type: 'task',
      title: 'Archive old notes',
      summary: 'Task from Alpha',
      project: 'Alpha',
      status: 'done',
      tags: ['launch'],
      updatedAt: itemById(payload, 'claude/projects/alpha.md').updatedAt,
      source: {
        provider: 'claude',
        path: 'projects/alpha.md',
        modifiedAt: itemById(payload, 'claude/projects/alpha.md').updatedAt,
      },
    });
    assert.deepEqual(payload.relations, [
      {
        id: 'claude/projects/alpha.md#task-1->claude/projects/alpha.md:belongs-to',
        from: 'claude/projects/alpha.md#task-1',
        to: 'claude/projects/alpha.md',
        type: 'belongs-to',
        label: 'Belongs to Alpha',
        evidence: 'declared',
        confidence: 1,
      },
      {
        id: 'claude/projects/alpha.md#task-2->claude/projects/alpha.md:belongs-to',
        from: 'claude/projects/alpha.md#task-2',
        to: 'claude/projects/alpha.md',
        type: 'belongs-to',
        label: 'Belongs to Alpha',
        evidence: 'declared',
        confidence: 1,
      },
    ]);
    assert.deepEqual(payload.summary, {
      items: 3,
      projects: 1,
      people: 0,
      ideas: 0,
      decisions: 0,
      tasks: 2,
      notes: 0,
      sources: 0,
      needsAttention: 1,
    });
  });
});

test('resolves Markdown and wiki links into stable labeled relations', async () => {
  await withFixtureTree({
    'projects/alpha.md': [
      '# Alpha',
      '',
      'See [Tooling](../decisions/tooling.md) and [[../people/rae|Rae]].',
    ].join('\n'),
    'decisions/tooling.md': '# Tooling decision\n\nUse local tools.\n',
    'people/rae.md': '# Rae\n\nProject collaborator.\n',
  }, async ({ root }) => {
    const first = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 100,
    });
    const second = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 200,
    });

    assert.deepEqual(first.items.map((item) => item.id), [
      'claude/decisions/tooling.md',
      'claude/people/rae.md',
      'claude/projects/alpha.md',
    ]);
    assert.deepEqual(first.relations, [
      {
        id: 'claude/projects/alpha.md->claude/decisions/tooling.md:mentions',
        from: 'claude/projects/alpha.md',
        to: 'claude/decisions/tooling.md',
        type: 'mentions',
        label: 'Mentions Tooling decision',
        evidence: 'explicit-link',
        confidence: 1,
      },
      {
        id: 'claude/projects/alpha.md->claude/people/rae.md:mentions',
        from: 'claude/projects/alpha.md',
        to: 'claude/people/rae.md',
        type: 'mentions',
        label: 'Mentions Rae',
        evidence: 'explicit-link',
        confidence: 1,
      },
    ]);
    assert.deepEqual(second.items.map((item) => item.id), first.items.map((item) => item.id));
    assert.deepEqual(second.relations.map((relation) => relation.id), first.relations.map((relation) => relation.id));
  });
});

test('ignores symlinks and files whose canonical path escapes the approved root', async () => {
  await withFixtureTree({
    'safe.md': '# Safe\n\nApproved content.\n',
    'escape.md': '# Escape\n\nMust be rejected by canonical containment.\n',
  }, async ({ parent, root }) => {
    const outside = path.join(parent, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'leak.md'), '# Leak\n\nSymlink secret.\n', 'utf8');
    await fs.symlink(outside, path.join(root, 'outside-link'));

    const payload = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      realpath: async (candidate) => {
        if (path.basename(candidate) === 'escape.md') return path.join(outside, 'escape.md');
        return fs.realpath(candidate);
      },
      now: () => 7,
    });

    assert.deepEqual(payload.items.map((item) => item.id), ['claude/safe.md']);
    assert.equal(JSON.stringify(payload).includes('Symlink secret'), false);
    assert.equal(JSON.stringify(payload).includes('Must be rejected'), false);
  });
});

test('rejects approved directory and Markdown-file roots that are themselves symlinks', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'claudeos-brain-root-link-'));
  try {
    const outsideDirectory = path.join(parent, 'outside-directory');
    const outsideFile = path.join(parent, 'outside-file.md');
    const approvedDirectory = path.join(parent, '.claude');
    const approvedFile = path.join(parent, 'approved.md');
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(
      path.join(outsideDirectory, 'directory-secret.md'),
      '# Directory secret\n\nPRIVATE_DIRECTORY_ROOT_CONTENT\n',
      'utf8',
    );
    await fs.writeFile(outsideFile, '# File secret\n\nPRIVATE_FILE_ROOT_CONTENT\n', 'utf8');
    await fs.symlink(outsideDirectory, approvedDirectory);
    await fs.symlink(outsideFile, approvedFile);
    const checkedRoots = [];

    const payload = await buildBrainIndex({
      sources: [
        { provider: 'claude', root: approvedDirectory },
        { provider: 'codex', root: approvedFile },
      ],
      lstat: async (candidate) => {
        checkedRoots.push(candidate);
        return fs.lstat(candidate);
      },
      now: () => 7_001,
    });

    assert.deepEqual(payload.items, []);
    assert.deepEqual(payload.relations, []);
    assert.equal(JSON.stringify(payload).includes('PRIVATE_'), false);
    assert.deepEqual(checkedRoots.sort(), [approvedDirectory, approvedFile].sort());
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('skips unreadable, malformed, and over-256-KiB Markdown before reading oversized content', async () => {
  const hugeMarker = 'OVERSIZED_PRIVATE_MARKER';
  await withFixtureTree({
    'huge.md': `# Huge\n\n${hugeMarker}${'x'.repeat(256 * 1024)}\n`,
    'malformed.md': '---\ntype: project\n# Missing closing fence\nSECRET_MALFORMED_MARKER\n',
    'unreadable.md': '# Unreadable\n\nSECRET_UNREADABLE_MARKER\n',
  }, async ({ root }) => {
    const readPaths = [];
    const payload = await buildBrainIndex({
      sources: [
        { provider: 'claude', root },
        { provider: 'codex', root: path.join(root, 'missing') },
      ],
      readFile: async (candidate, encoding) => {
        readPaths.push(candidate);
        if (path.basename(candidate) === 'unreadable.md') throw new Error('permission denied');
        return fs.readFile(candidate, encoding);
      },
      now: () => 8,
    });

    assert.deepEqual(readPaths.map((candidate) => path.basename(candidate)).sort(), [
      'malformed.md',
      'unreadable.md',
    ]);
    assert.deepEqual(payload, {
      schema: 1,
      builtAt: 8,
      summary: {
        items: 0,
        projects: 0,
        people: 0,
        ideas: 0,
        decisions: 0,
        tasks: 0,
        notes: 0,
        sources: 0,
        needsAttention: 0,
      },
      items: [],
      relations: [],
    });
    assert.equal(JSON.stringify(payload).includes(hugeMarker), false);
  });
});

test('redacts all returned strings, bounds tags, and never serializes raw content fields', async () => {
  const apiKey = `sk-${'A'.repeat(24)}`;
  const email = 'private.owner@example.com';
  const homePath = '/Users/private-owner/SecretProject';
  const tags = [email, ...Array.from({ length: 13 }, (_, index) => `Tag-${index}-${'z'.repeat(50)}`)];
  await withFixtureTree({
    'private.md': [
      '---',
      'type: note',
      `project: ${homePath}`,
      'status: reference',
      `tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
      '---',
      `# Credential ${apiKey}`,
      '',
      `Contact ${email}; API_KEY=${apiKey}`,
      '',
      `- [ ] Notify ${email}`,
    ].join('\n'),
  }, async ({ root }) => {
    const payload = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 9,
    });
    const serialized = JSON.stringify(payload);

    for (const forbidden of [apiKey, email, 'private-owner', homePath]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    for (const item of payload.items) {
      assert.equal(item.tags.length <= 12, true);
      assert.equal(item.tags.every((tag) => tag.length <= 40), true);
      for (const forbiddenKey of ['body', 'raw', 'content', 'rawContent']) {
        assert.equal(Object.hasOwn(item, forbiddenKey), false);
      }
    }
    assert.match(serialized, /\[redacted\]|\[email\]/);
  });
});

test('prefers explicit links and otherwise relates items that declare the same project', async () => {
  await withFixtureTree({
    'alpha.md': [
      '---',
      'type: note',
      'project: Launch',
      '---',
      '# Alpha note',
      '',
      'See [[Beta decision]].',
    ].join('\n'),
    'beta.md': [
      '---',
      'type: decision',
      'project: Launch',
      '---',
      '# Beta decision',
      '',
      'Choose the local implementation.',
    ].join('\n'),
    'gamma.md': [
      '---',
      'type: idea',
      'project: Launch',
      '---',
      '# Gamma idea',
      '',
      'An adjacent option.',
    ].join('\n'),
  }, async ({ root }) => {
    const payload = await buildBrainIndex({
      sources: [{ provider: 'claude', root }],
      now: () => 10,
    });

    assert.deepEqual(payload.relations, [
      {
        id: 'claude/alpha.md->claude/beta.md:mentions',
        from: 'claude/alpha.md',
        to: 'claude/beta.md',
        type: 'mentions',
        label: 'Mentions Beta decision',
        evidence: 'explicit-link',
        confidence: 1,
      },
      {
        id: 'claude/alpha.md->claude/gamma.md:related-to',
        from: 'claude/alpha.md',
        to: 'claude/gamma.md',
        type: 'related-to',
        label: 'Shares project Launch',
        evidence: 'shared-project',
        confidence: 0.75,
      },
      {
        id: 'claude/beta.md->claude/gamma.md:related-to',
        from: 'claude/beta.md',
        to: 'claude/gamma.md',
        type: 'related-to',
        label: 'Shares project Launch',
        evidence: 'shared-project',
        confidence: 0.75,
      },
    ]);
  });
});

test('brain route returns the successful index as exact JSON', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const item = {
      id: 'codex/notes/route.md',
      type: 'note',
      title: 'Route note',
      summary: 'Safe derived summary.',
      project: null,
      status: 'reference',
      tags: ['route'],
      updatedAt: 120,
      source: { provider: 'codex', path: 'notes/route.md', modifiedAt: 120 },
  };
  const fullIndex = routeIndex([item]);
  const expected = {
    ...fullIndex,
    page: { total: 1, offset: 0, limit: 100, hasMore: false },
    today: { continueWorking: null, recentDecisions: [], needsAttention: [] },
  };

  const response = await requestRouter(createBrainRouter({ indexLoader: async () => fullIndex }));

  assert.equal(response.status, 200);
  assert.match(response.contentType, /^application\/json\b/);
  assert.deepEqual(JSON.parse(response.text), expected);
  assert.doesNotMatch(response.text, /<!doctype|<html/i);
});

test('brain route degrades loader failures to fixed empty JSON without exception details', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const privateError = '/Users/private-owner/secrets/index.md failed';
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await requestRouter(createBrainRouter({
      indexLoader: async () => { throw new Error(privateError); },
    }));

    assert.equal(response.status, 200);
    assert.match(response.contentType, /^application\/json\b/);
    assert.deepEqual(JSON.parse(response.text), {
      schema: 1,
      builtAt: 0,
      summary: {
        items: 0,
        projects: 0,
        people: 0,
        ideas: 0,
        decisions: 0,
        tasks: 0,
        notes: 0,
        sources: 0,
        needsAttention: 0,
      },
      page: { total: 0, offset: 0, limit: 100, hasMore: false },
      today: { continueWorking: null, recentDecisions: [], needsAttention: [] },
      items: [],
      relations: [],
      unavailable: true,
    });
    assert.equal(response.text.includes(privateError), false);
    assert.doesNotMatch(response.text, /<!doctype|<html/i);
  } finally {
    console.warn = originalWarn;
  }
});

test('brain route defaults to 100 items and returns only relations whose endpoints are on the page', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const items = Array.from({ length: 205 }, (_, index) => routeItem(index));
  const relations = [
    {
      id: 'page-visible', from: 'codex/item-000.md', to: 'codex/item-001.md',
      type: 'related-to', label: 'Visible relation', evidence: 'declared', confidence: 1,
    },
    {
      id: 'page-hidden', from: 'codex/item-000.md', to: 'codex/item-150.md',
      type: 'related-to', label: 'Hidden relation', evidence: 'declared', confidence: 1,
    },
  ];
  const response = await requestRouter(createBrainRouter({
    indexLoader: async () => routeIndex(items, relations),
  }));
  const body = JSON.parse(response.text);

  assert.deepEqual(body.page, { total: 205, offset: 0, limit: 100, hasMore: true });
  assert.equal(body.items.length, 100);
  assert.equal(body.items[0].id, 'codex/item-000.md');
  assert.equal(body.items[99].id, 'codex/item-099.md');
  assert.deepEqual(body.relations.map((relation) => relation.id), ['page-visible']);
});

test('brain route projects global Today items from the full index before pagination', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const firstPage = Array.from({ length: 100 }, (_, index) => routeItem(index));
  const activeProject = routeItem(100, {
    id: 'codex/z-active-project.md', type: 'project', status: 'active', updatedAt: 150,
  });
  const activeTask = routeItem(101, {
    id: 'codex/z-active-task.md', type: 'task', status: 'active', updatedAt: 200,
  });
  const ignoredActiveNote = routeItem(102, {
    id: 'codex/z-active-note.md', type: 'note', status: 'active', updatedAt: 999,
  });
  const ignoredDoneTask = routeItem(103, {
    id: 'codex/z-done-task.md', type: 'task', status: 'done', updatedAt: 999,
  });
  const decisionA = routeItem(104, {
    id: 'codex/z-decision-a.md', type: 'decision', updatedAt: 400,
  });
  const decisionB = routeItem(105, {
    id: 'codex/z-decision-b.md', type: 'decision', updatedAt: 400,
  });
  const decisionC = routeItem(106, {
    id: 'codex/z-decision-c.md', type: 'decision', updatedAt: 300,
  });
  const decisionD = routeItem(107, {
    id: 'codex/z-decision-d.md', type: 'decision', updatedAt: 200,
  });
  const blockedNewest = routeItem(108, {
    id: 'codex/z-blocked-newest.md', type: 'task', status: 'blocked', updatedAt: 30,
  });
  const blockedOlder = routeItem(109, {
    id: 'codex/z-blocked-older.md', type: 'task', status: 'blocked', updatedAt: 10,
  });
  const nextNewest = routeItem(110, {
    id: 'codex/z-next-newest.md', type: 'task', status: 'next', updatedAt: 100,
  });
  const nextOlder = routeItem(111, {
    id: 'codex/z-next-older.md', type: 'task', status: 'next', updatedAt: 90,
  });
  const fullItems = [
    ...firstPage,
    activeProject,
    activeTask,
    ignoredActiveNote,
    ignoredDoneTask,
    decisionA,
    decisionB,
    decisionC,
    decisionD,
    blockedNewest,
    blockedOlder,
    nextNewest,
    nextOlder,
  ];
  const response = await requestRouter(createBrainRouter({
    indexLoader: async () => routeIndex(fullItems),
  }));
  const body = JSON.parse(response.text);

  assert.equal(body.items.length, 100);
  assert.equal(body.items.some((item) => item.id.startsWith('codex/z-')), false);
  assert.deepEqual(body.today, {
    continueWorking: activeTask,
    recentDecisions: [decisionA, decisionB, decisionC],
    needsAttention: [blockedNewest, blockedOlder, nextNewest],
  });
});

test('brain route caps list limits at 200', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const items = Array.from({ length: 250 }, (_, index) => routeItem(index));
  const response = await requestRouter(
    createBrainRouter({ indexLoader: async () => routeIndex(items) }),
    '/api/brain?limit=999',
  );
  const body = JSON.parse(response.text);

  assert.deepEqual(body.page, { total: 250, offset: 0, limit: 200, hasMore: true });
  assert.equal(body.items.length, 200);
  assert.equal(body.items[199].id, 'codex/item-199.md');
});

test('brain route applies a nonnegative list offset after filtering', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const items = Array.from({ length: 10 }, (_, index) => routeItem(index));
  const response = await requestRouter(
    createBrainRouter({ indexLoader: async () => routeIndex(items) }),
    '/api/brain?limit=3&offset=4',
  );
  const body = JSON.parse(response.text);

  assert.deepEqual(body.page, { total: 10, offset: 4, limit: 3, hasMore: true });
  assert.deepEqual(body.items.map((item) => item.id), [
    'codex/item-004.md',
    'codex/item-005.md',
    'codex/item-006.md',
  ]);
});

test('brain route searches title, summary, project, and tags case-insensitively', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const items = [
    routeItem(0, { title: 'Launch plan' }),
    routeItem(1, { summary: 'Contains a hidden needle' }),
    routeItem(2, { project: 'Apollo' }),
    routeItem(3, { tags: ['Urgent'] }),
    routeItem(4),
  ];
  const router = createBrainRouter({ indexLoader: async () => routeIndex(items) });

  for (const [query, expectedId] of [
    ['launch', 'codex/item-000.md'],
    ['NEEDLE', 'codex/item-001.md'],
    ['apollo', 'codex/item-002.md'],
    ['urgent', 'codex/item-003.md'],
  ]) {
    const response = await requestRouter(router, `/api/brain?q=${query}`);
    const body = JSON.parse(response.text);
    assert.deepEqual(body.items.map((item) => item.id), [expectedId]);
    assert.equal(body.page.total, 1);
  }
});

test('brain route caps q at 120 characters before matching', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const searchable = 'x'.repeat(120);
  const item = routeItem(0, { title: searchable });
  const response = await requestRouter(
    createBrainRouter({ indexLoader: async () => routeIndex([item]) }),
    `/api/brain?q=${searchable}y`,
  );
  const body = JSON.parse(response.text);

  assert.deepEqual(body.items.map((entry) => entry.id), ['codex/item-000.md']);
  assert.equal(body.page.total, 1);
});

test('brain route filters by one knowledge item type', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const items = [
    routeItem(0, { type: 'decision' }),
    routeItem(1, { type: 'note' }),
    routeItem(2, { type: 'decision' }),
  ];
  const response = await requestRouter(
    createBrainRouter({ indexLoader: async () => routeIndex(items) }),
    '/api/brain?type=decision',
  );
  const body = JSON.parse(response.text);

  assert.deepEqual(body.items.map((item) => item.id), [
    'codex/item-000.md',
    'codex/item-002.md',
  ]);
  assert.deepEqual(body.page, { total: 2, offset: 0, limit: 100, hasMore: false });
});

test('brain focus returns the selected item, six relations per direction, and every endpoint item', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const center = routeItem(100, { id: 'codex/center.md', title: 'Center' });
  const incoming = Array.from({ length: 8 }, (_, index) => routeItem(index, {
    id: `codex/in-${String(index).padStart(2, '0')}.md`,
  }));
  const outgoing = Array.from({ length: 8 }, (_, index) => routeItem(index + 20, {
    id: `codex/out-${String(index).padStart(2, '0')}.md`,
  }));
  const unrelated = routeItem(200, { id: 'codex/unrelated.md' });
  const relations = [
    ...incoming.map((item, index) => ({
      id: `incoming-${String(index).padStart(2, '0')}`,
      from: item.id,
      to: center.id,
      type: 'mentions',
      label: `Incoming ${index}`,
      evidence: 'explicit-link',
      confidence: 1,
    })),
    ...outgoing.map((item, index) => ({
      id: `outgoing-${String(index).padStart(2, '0')}`,
      from: center.id,
      to: item.id,
      type: 'related-to',
      label: `Outgoing ${index}`,
      evidence: 'shared-project',
      confidence: 0.75,
    })),
  ];
  const response = await requestRouter(
    createBrainRouter({
      indexLoader: async () => routeIndex([center, ...incoming, ...outgoing, unrelated], relations),
    }),
    '/api/brain?focus=codex%2Fcenter.md',
  );
  const body = JSON.parse(response.text);
  const returnedIds = new Set(body.items.map((item) => item.id));

  assert.deepEqual(body.page, { total: 13, offset: 0, limit: 13, hasMore: false });
  assert.equal(body.items[0].id, 'codex/center.md');
  assert.equal(body.items.length, 13);
  assert.deepEqual(body.relations.map((relation) => relation.id), [
    'incoming-00', 'incoming-01', 'incoming-02', 'incoming-03', 'incoming-04', 'incoming-05',
    'outgoing-00', 'outgoing-01', 'outgoing-02', 'outgoing-03', 'outgoing-04', 'outgoing-05',
  ]);
  for (const relation of body.relations) {
    assert.equal(returnedIds.has(relation.from), true, relation.from);
    assert.equal(returnedIds.has(relation.to), true, relation.to);
  }
  assert.equal(returnedIds.has('codex/unrelated.md'), false);
});

test('brain focus ranks explicit then declared then shared relations before the direction cap', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  const center = routeItem(100, { id: 'codex/priority-center.md', title: 'Priority center' });
  const endpoints = Array.from({ length: 8 }, (_, index) => routeItem(index, {
    id: `codex/priority-${index}.md`,
  }));
  const relations = [
    ...endpoints.slice(0, 5).map((item, index) => ({
      id: `a-shared-${index}`,
      from: item.id,
      to: center.id,
      type: 'related-to',
      label: `Shared ${index}`,
      evidence: 'shared-project',
      confidence: 1,
    })),
    {
      id: 'b-declared-low', from: endpoints[5].id, to: center.id,
      type: 'depends-on', label: 'Declared low', evidence: 'declared', confidence: 0.5,
    },
    {
      id: 'c-declared-high', from: endpoints[6].id, to: center.id,
      type: 'depends-on', label: 'Declared high', evidence: 'declared', confidence: 0.9,
    },
    {
      id: 'z-explicit', from: endpoints[7].id, to: center.id,
      type: 'mentions', label: 'Explicit link', evidence: 'explicit-link', confidence: 0.4,
    },
  ];
  const response = await requestRouter(
    createBrainRouter({ indexLoader: async () => routeIndex([center, ...endpoints], relations) }),
    '/api/brain?focus=codex%2Fpriority-center.md',
  );
  const body = JSON.parse(response.text);

  assert.deepEqual(body.relations.map((relation) => relation.id), [
    'z-explicit',
    'c-declared-high',
    'b-declared-low',
    'a-shared-0',
    'a-shared-1',
    'a-shared-2',
  ]);
  assert.equal(body.items.length, 7);
  assert.equal(body.items.some((item) => item.id === endpoints[7].id), true);
});

test('brain route reuses one full index for 30 seconds and rebuilds at expiry', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  let clock = 1_000;
  let builds = 0;
  const router = createBrainRouter({
    indexLoader: async () => routeIndex([routeItem(0)], [], ++builds),
    now: () => clock,
  });

  const first = JSON.parse((await requestRouter(router)).text);
  const filtered = JSON.parse((await requestRouter(router, '/api/brain?q=item')).text);
  clock = 30_999;
  const beforeExpiry = JSON.parse((await requestRouter(router, '/api/brain?type=source')).text);
  clock = 31_000;
  const atExpiry = JSON.parse((await requestRouter(router)).text);

  assert.equal(builds, 2);
  assert.deepEqual(
    [first.builtAt, filtered.builtAt, beforeExpiry.builtAt, atExpiry.builtAt],
    [1, 1, 1, 2],
  );
});

test('brain route coalesces concurrent full-index builds', async () => {
  const { createBrainRouter } = await import('../server/routes/brain.js');
  let builds = 0;
  let releaseBuild;
  const pendingBuild = new Promise((resolve) => { releaseBuild = resolve; });
  const router = createBrainRouter({
    indexLoader: () => {
      builds += 1;
      return pendingBuild;
    },
    now: () => 5_000,
  });

  const pendingResponses = requestRouterMany(router, [
    '/api/brain?q=item',
    '/api/brain?type=source',
  ]);
  while (builds === 0) await new Promise((resolve) => setImmediate(resolve));
  releaseBuild(routeIndex([routeItem(0)], [], 44));
  const bodies = (await pendingResponses).map((response) => JSON.parse(response.text));

  assert.equal(builds, 1);
  assert.deepEqual(bodies.map((body) => body.builtAt), [44, 44]);
});

test('route registry mounts the brain module under the API surface', async () => {
  const { mountRoutes } = await import('../server/lib/registry.js');
  const app = express();

  const result = await mountRoutes(app);

  assert.equal(result.mounted.includes('brain'), true);
  assert.equal(result.degraded.includes('brain'), false);
});
