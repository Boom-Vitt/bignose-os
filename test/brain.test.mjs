import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAIN_ENDPOINT,
  filterItemsByCategory,
  focusedRelations,
  mountBrain,
  needsAttention,
  recentDecisions,
  searchItems,
  selectContinueItem,
  summaryCounts,
} from '../public/js/views/brain.js';

const ITEMS = Object.freeze([
  Object.freeze({ id: 'project-atlas', type: 'project', title: 'Atlas launch', summary: 'Prepare the local knowledge workspace.', project: null, status: 'active', tags: Object.freeze(['Roadmap', 'Private']), updatedAt: 700, source: Object.freeze({ provider: 'claude', path: '.claude/projects/atlas.md', modifiedAt: 700 }) }),
  Object.freeze({ id: 'task-outline', type: 'task', title: 'Outline launch notes', summary: 'Turn the plan into a short release note.', project: 'Atlas launch', status: 'active', tags: Object.freeze(['Writing']), updatedAt: 900, source: Object.freeze({ provider: 'codex', path: '.codex/tasks/outline.md', modifiedAt: 900 }) }),
  Object.freeze({ id: 'task-blocked', type: 'task', title: 'Confirm privacy review', summary: 'Waiting for the approved source list.', project: 'Atlas launch', status: 'blocked', tags: Object.freeze(['Safety']), updatedAt: 850, source: Object.freeze({ provider: 'claude', path: '.claude/tasks/privacy.md', modifiedAt: 850 }) }),
  Object.freeze({ id: 'idea-search', type: 'idea', title: 'Search by memory', summary: 'Find useful context without knowing a file name.', project: 'Second Brain', status: 'reference', tags: Object.freeze(['Discovery', 'Beginner']), updatedAt: 500, source: Object.freeze({ provider: 'codex', path: '.codex/ideas/search.md', modifiedAt: 500 }) }),
  Object.freeze({ id: 'decision-new', type: 'decision', title: 'Keep indexing local', summary: 'No derived knowledge leaves this computer.', project: 'Second Brain', status: 'done', tags: Object.freeze(['Privacy']), updatedAt: 800, source: Object.freeze({ provider: 'claude', path: '.claude/decisions/local.md', modifiedAt: 800 }) }),
  Object.freeze({ id: 'decision-old', type: 'decision', title: 'Use readable relations', summary: 'Show a label for every connection.', project: 'Second Brain', status: 'done', tags: Object.freeze(['Accessibility']), updatedAt: 400, source: Object.freeze({ provider: 'codex', path: '.codex/decisions/relations.md', modifiedAt: 400 }) }),
  Object.freeze({ id: 'person-boom', type: 'person', title: 'Boom', summary: 'Product owner.', project: 'Atlas launch', status: 'reference', tags: Object.freeze(['Owner']), updatedAt: 300, source: Object.freeze({ provider: 'claude', path: '.claude/people/boom.md', modifiedAt: 300 }) }),
  Object.freeze({ id: 'note-source', type: 'note', title: 'Source boundaries', summary: 'Approved Markdown roots only.', project: 'Second Brain', status: 'next', tags: Object.freeze(['Safety']), updatedAt: 650, source: Object.freeze({ provider: 'codex', path: '.codex/notes/sources.md', modifiedAt: 650 }) }),
  Object.freeze({ id: 'source-codex', type: 'source', title: 'Codex memory', summary: 'Local derived index.', project: null, status: 'reference', tags: Object.freeze(['Provider']), updatedAt: 200, source: Object.freeze({ provider: 'codex', path: '.codex/memories/MEMORY.md', modifiedAt: 200 }) }),
]);

const RELATIONS = Object.freeze([
  ...Array.from({ length: 8 }, (_, index) => Object.freeze({ id: `in-${index}`, from: index === 0 ? 'decision-new' : `incoming-${index}`, to: 'task-outline', type: 'supports', label: `Incoming reason ${index}`, evidence: index < 2 ? 'explicit-link' : 'shared-project', confidence: 1 - index / 20 })),
  ...Array.from({ length: 8 }, (_, index) => Object.freeze({ id: `out-${index}`, from: 'task-outline', to: index === 0 ? 'task-blocked' : `outgoing-${index}`, type: 'next-step', label: `Outgoing reason ${index}`, evidence: index < 2 ? 'explicit-link' : 'shared-project', confidence: 1 - index / 20 })),
  Object.freeze({ id: 'unlabeled', from: 'task-outline', to: 'idea-search', type: 'related-to', label: '   ', evidence: 'declared', confidence: 1 }),
]);

const TODAY = Object.freeze({
  continueWorking: ITEMS[1],
  recentDecisions: Object.freeze([ITEMS[4], ITEMS[5]]),
  needsAttention: Object.freeze([ITEMS[2], ITEMS[7]]),
});

const PAYLOAD = Object.freeze({
  schema: 1,
  builtAt: 1_000,
  summary: Object.freeze({ items: 9, projects: 1, people: 1, ideas: 1, decisions: 2, tasks: 2, notes: 1, sources: 1, needsAttention: 2 }),
  page: Object.freeze({ total: 9, offset: 0, limit: 100, hasMore: false }),
  today: TODAY,
  items: ITEMS,
  relations: Object.freeze([]),
});

const FOCUS_PAYLOAD = Object.freeze({
  ...PAYLOAD,
  page: Object.freeze({ total: 1, offset: 0, limit: 100, hasMore: false }),
  relations: RELATIONS,
});

test('summary counts expose every category and safely normalize malformed values', () => {
  assert.deepEqual(summaryCounts(PAYLOAD), { items: 9, projects: 1, people: 1, ideas: 1, decisions: 2, tasks: 2, notes: 1, sources: 1, needsAttention: 2 });
  assert.deepEqual(summaryCounts({ summary: { items: -2, tasks: '4', notes: NaN } }), { items: 0, projects: 0, people: 0, ideas: 0, decisions: 0, tasks: 4, notes: 0, sources: 0, needsAttention: 0 });
});

test('search is case-insensitive across title, summary, project, and tags', () => {
  assert.deepEqual(searchItems(ITEMS, 'ATLAS').map((item) => item.id), ['project-atlas', 'task-outline', 'task-blocked', 'person-boom']);
  assert.deepEqual(searchItems(ITEMS, 'beginner').map((item) => item.id), ['idea-search']);
  assert.deepEqual(searchItems(ITEMS, 'NO DERIVED').map((item) => item.id), ['decision-new']);
  assert.deepEqual(searchItems(ITEMS, '   ').map((item) => item.id), ITEMS.map((item) => item.id));
  assert.deepEqual(searchItems(null, 'atlas'), []);
});

test('category filtering accepts the seven beginner-facing plural labels', () => {
  const expected = { Projects: ['project-atlas'], People: ['person-boom'], Ideas: ['idea-search'], Decisions: ['decision-new', 'decision-old'], Tasks: ['task-outline', 'task-blocked'], Notes: ['note-source'], Sources: ['source-codex'] };
  for (const [category, ids] of Object.entries(expected)) assert.deepEqual(filterItemsByCategory(ITEMS, category).map((item) => item.id), ids, category);
  assert.deepEqual(filterItemsByCategory(ITEMS, 'All').map((item) => item.id), ITEMS.map((item) => item.id));
});

test('Continue working chooses the most recently updated active project or task', () => {
  assert.equal(selectContinueItem(ITEMS)?.id, 'task-outline');
  assert.equal(selectContinueItem([{ ...ITEMS[0], status: 'done' }]), null);
  assert.equal(selectContinueItem([null, { type: 'task', status: 'active', updatedAt: 'bad' }])?.type, 'task');
});

test('recent decisions are newest first with deterministic ties', () => {
  const tied = { ...ITEMS[5], id: 'decision-alpha', updatedAt: 800 };
  assert.deepEqual(recentDecisions([...ITEMS, tied], 3).map((item) => item.id), ['decision-alpha', 'decision-new', 'decision-old']);
  assert.deepEqual(recentDecisions(null), []);
});

test('Needs attention shows blocked work before next work and keeps each group newest first', () => {
  assert.deepEqual(needsAttention(ITEMS, 4).map((item) => item.id), ['task-blocked', 'note-source']);
  assert.deepEqual(needsAttention([{ ...ITEMS[0], status: 'unknown' }]), []);
});

test('focused relations return no more than six labeled incoming and six labeled outgoing rows', () => {
  const result = focusedRelations(ITEMS, RELATIONS, 'task-outline');
  assert.equal(result.incoming.length, 6);
  assert.equal(result.outgoing.length, 6);
  assert.equal([...result.incoming, ...result.outgoing].every((row) => row.label.trim()), true);
  assert.equal(result.incoming[0].direction, 'incoming');
  assert.equal(result.outgoing[0].direction, 'outgoing');
  assert.equal(result.incoming[0].relatedItem?.id, 'decision-new');
  assert.equal(result.outgoing[0].relatedItem?.id, 'task-blocked');
  assert.deepEqual(focusedRelations(null, null, 'missing'), { incoming: [], outgoing: [] });
});

class FakeElement {
  constructor(tag, ownerDocument = null) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = ownerDocument; this.parentElement = null; this.childNodes = [];
    this.attributes = new Map(); this.dataset = {}; this.className = ''; this.hidden = false; this.disabled = false; this.tabIndex = -1; this.value = ''; this.type = '';
    this._listeners = new Map(); this._textContent = '';
    this.classList = {
      add: (...names) => { const current = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach((name) => current.add(name)); this.className = [...current].join(' '); },
      remove: (...names) => { const rejected = new Set(names); this.className = this.className.split(/\s+/).filter((name) => name && !rejected.has(name)).join(' '); },
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const next = force === undefined ? !this.classList.contains(name) : Boolean(force); if (next) this.classList.add(name); else this.classList.remove(name); return next; },
    };
  }
  get children() { return this.childNodes; }
  set textContent(value) { this._textContent = value == null ? '' : String(value); this.childNodes = []; }
  get textContent() { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this._textContent; }
  append(...children) { for (const child of children) { if (!child || typeof child !== 'object') continue; child.parentElement = this; this.childNodes.push(child); } }
  replaceChildren(...children) { this.childNodes.forEach((child) => { child.parentElement = null; }); this.childNodes = []; this._textContent = ''; this.append(...children); }
  setAttribute(name, value) { const key = String(name); const stringValue = String(value); this.attributes.set(key, stringValue); if (key === 'id') this.id = stringValue; if (key === 'tabindex') this.tabIndex = Number(stringValue); if (key.startsWith('data-')) { const dataKey = key.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()); this.dataset[dataKey] = stringValue; } }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, handler) { let handlers = this._listeners.get(type); if (!handlers) { handlers = new Set(); this._listeners.set(type, handlers); } handlers.add(handler); }
  removeEventListener(type, handler) { this._listeners.get(type)?.delete(handler); }
  dispatchEvent(event) { const currentEvent = event && typeof event === 'object' ? event : { type: String(event) }; if (!currentEvent.target) currentEvent.target = this; if (!currentEvent.preventDefault) currentEvent.preventDefault = () => { currentEvent.defaultPrevented = true; }; for (let current = this; current; current = current.parentElement) { currentEvent.currentTarget = current; for (const handler of [...(current._listeners.get(currentEvent.type) || [])]) handler(currentEvent); if (currentEvent.cancelBubble) break; } return !currentEvent.defaultPrevented; }
  matches(selector) { const tagAndClass = /^([a-z]+)?(?:\.([\w-]+))?$/i.exec(selector); if (tagAndClass) { const [, tag, className] = tagAndClass; return (!tag || this.tagName === tag.toUpperCase()) && (!className || this.classList.contains(className)); } const attribute = /^([a-z]+)?\[([\w-]+)(?:="([^"]*)")?\]$/i.exec(selector); if (attribute) { const [, tag, name, expected] = attribute; const actual = name === 'type' ? this.type : this.getAttribute(name); return (!tag || this.tagName === tag.toUpperCase()) && actual != null && (expected == null || actual === expected); } return false; }
  closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) { const found = []; for (const child of this.childNodes) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

function makeFakeDocument() { const document = new FakeElement('#document'); document.ownerDocument = document; document.activeElement = null; document.createElement = (tag) => new FakeElement(tag, document); document.createDocumentFragment = () => new FakeElement('#fragment', document); return document; }
function response(payload) { return { ok: true, async json() { return payload; } }; }
async function settle() { for (let index = 0; index < 4; index += 1) await Promise.resolve(); }

function pagePayload(items, { total = items.length, offset = 0, limit = 100, hasMore = false } = {}) {
  return {
    ...PAYLOAD,
    summary: { ...PAYLOAD.summary, items: total },
    page: { total, offset, limit, hasMore },
    items,
    relations: [],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function timerHarness() {
  let queued = null;
  return {
    set(handler) { queued = handler; return 1; },
    clear() { queued = null; },
    flush() { const handler = queued; queued = null; handler?.(); },
    pending() { return Boolean(queued); },
  };
}

test('default view explains the product, exposes seven categories, and draws no global graph', async () => {
  assert.equal(BRAIN_ENDPOINT, '/api/brain');
  const document = makeFakeDocument(); const root = document.createElement('main'); const calls = []; let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const mounted = mountBrain(root, { fetchApi(path) { calls.push(path); if (path.startsWith('/api/brain?focus=')) return Promise.resolve(response(FOCUS_PAYLOAD)); return pending; } });
  assert.match(root.textContent, /Loading your local knowledge/i);
  assert.equal(root.querySelector('[role="status"]')?.getAttribute('aria-live'), 'polite');
  resolveFetch(response(PAYLOAD)); await settle();
  assert.deepEqual(calls, ['/api/brain?limit=100&offset=0']);
  assert.match(root.textContent, /Find what you knew\. Continue what matters\./);
  assert.equal(root.querySelector('input[type="search"]')?.getAttribute('placeholder'), 'Search projects, decisions, tasks, people, and notes…');
  assert.match(root.textContent, /Continue working/); assert.match(root.textContent, /Recent decisions/); assert.match(root.textContent, /Needs attention/);
  assert.equal(root.querySelectorAll('button[data-category]').length, 7); assert.equal(root.querySelectorAll('canvas').length, 0); assert.equal(root.querySelectorAll('.brain-relation-row').length, 0);
  assert.equal(root.querySelectorAll('button[data-category]').find((button) => button.dataset.category === 'People')?.textContent, 'People 1');
  root.querySelectorAll('button[data-open-item]').find((button) => button.dataset.openItem === 'task-outline').dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(calls.at(-1), '/api/brain?focus=task-outline');
  const relationRows = root.querySelectorAll('.brain-relation-row');
  assert.equal(relationRows.length, 12);
  assert.equal(relationRows.every((row) => /Toward selected|From selected/.test(row.textContent)), true);
  mounted.destroy(); assert.equal(root.childNodes.length, 0);
});

test('Today renders the global projection even when those items are outside the bounded result page', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main');
  const payload = pagePayload([ITEMS[8]], { total: 101, hasMore: true });
  const mounted = mountBrain(root, { fetchApi: async () => response(payload) });
  await settle();

  assert.deepEqual(
    root.querySelector('.brain-today-grid').querySelectorAll('button[data-open-item]')
      .map((button) => button.dataset.openItem),
    ['task-outline', 'decision-new', 'decision-old', 'task-blocked', 'note-source'],
  );
  assert.equal(root.querySelectorAll('button[data-item-id]')[0]?.dataset.itemId, 'source-codex');
  mounted.destroy();
});

test('Today uses safe empty fallbacks instead of deriving from the bounded result page', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main');
  const payload = {
    ...pagePayload([ITEMS[1], ITEMS[4], ITEMS[2]]),
    today: { continueWorking: null, recentDecisions: null, needsAttention: 'invalid' },
  };
  const mounted = mountBrain(root, { fetchApi: async () => response(payload) });
  await settle();

  const today = root.querySelector('.brain-today-grid');
  assert.equal(today.querySelectorAll('button[data-open-item]').length, 0);
  assert.match(today.textContent, /No active project or task is waiting/);
  assert.match(today.textContent, /No decisions have been indexed yet/);
  assert.match(today.textContent, /Nothing is blocked or queued next/);
  mounted.destroy();
});

test('debounced search requests a bounded page and keeps the original input focused', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main'); const calls = []; const timers = timerHarness();
  const mounted = mountBrain(root, {
    fetchApi: async (path) => { calls.push(path); return response(path.includes('q=beginner') ? pagePayload([ITEMS[3]]) : PAYLOAD); },
    setTimer: (handler) => timers.set(handler), clearTimer: () => timers.clear(),
  });
  await settle();
  const search = root.querySelector('input[type="search"]'); search.focus(); search.value = 'beginner'; search.dispatchEvent({ type: 'input' });
  assert.equal(timers.pending(), true); assert.equal(calls.length, 1);
  timers.flush(); await settle();
  assert.equal(calls.at(-1), '/api/brain?q=beginner&limit=100&offset=0');
  assert.deepEqual(root.querySelectorAll('button[data-item-id]').map((button) => button.dataset.itemId), ['idea-search']);
  assert.equal(root.querySelector('input[type="search"]'), search);
  assert.equal(document.activeElement, search);
  mounted.destroy();
});

test('category and paging requests replace one bounded page while restoring control focus', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main'); const calls = [];
  const projectPage = pagePayload([ITEMS[0]], { total: 101, offset: 0, hasMore: true });
  const finalPage = pagePayload([ITEMS[0]], { total: 101, offset: 100, hasMore: false });
  const mounted = mountBrain(root, { fetchApi: async (path) => { calls.push(path); if (path.includes('offset=100')) return response(finalPage); if (path.includes('type=project')) return response(projectPage); return response(PAYLOAD); } });
  await settle();
  const list = root.querySelector('.brain-result-list');
  const projects = root.querySelectorAll('button[data-category]').find((button) => button.dataset.category === 'Projects'); projects.focus(); projects.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(calls.at(-1), '/api/brain?type=project&limit=100&offset=0');
  assert.equal(document.activeElement, projects); assert.equal(root.querySelector('.brain-result-list'), list);
  const next = root.querySelector('.brain-page-next'); next.focus(); next.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(calls.at(-1), '/api/brain?type=project&limit=100&offset=100');
  assert.equal(root.querySelector('.brain-result-list'), list);
  assert.equal(document.activeElement?.parentElement, root.querySelector('.brain-pagination'));
  assert.deepEqual(root.querySelectorAll('button[data-item-id]').map((button) => button.dataset.itemId), ['project-atlas']);
  mounted.destroy();
});

test('item selection keeps the result list stable and moves focus to the loaded details heading', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main'); const focusResponse = deferred(); const calls = [];
  const mounted = mountBrain(root, { fetchApi: async (path, options) => { calls.push({ path, options }); return path.includes('focus=') ? focusResponse.promise : response(PAYLOAD); } });
  await settle();
  const list = root.querySelector('.brain-result-list'); const selected = root.querySelectorAll('button[data-item-id]')[1]; selected.focus(); selected.dispatchEvent({ type: 'click' });
  assert.equal(calls.at(-1).path, '/api/brain?focus=task-outline'); assert.equal(root.querySelector('.brain-result-list'), list); assert.equal(document.activeElement, selected);
  focusResponse.resolve(response(FOCUS_PAYLOAD)); await settle();
  const heading = root.querySelector('.brain-detail-title');
  assert.equal(root.querySelector('.brain-result-list'), list); assert.equal(root.querySelectorAll('button[data-item-id]')[1], selected);
  assert.equal(root.querySelector('.brain-content').children[0].classList.contains('brain-results'), true);
  assert.equal(root.querySelector('.brain-content').children[1].classList.contains('brain-details'), true);
  assert.equal(heading.getAttribute('tabindex'), '-1'); assert.equal(document.activeElement, heading);
  assert.equal(list.tagName, 'UL'); assert.equal(list.getAttribute('role'), null); assert.equal(selected.getAttribute('role'), null);
  assert.match(root.textContent, /CODEX/i); assert.match(root.textContent, /\.codex\/tasks\/outline\.md/);
  mounted.destroy();
});

test('newer list and focus responses win even when aborted requests resolve later', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main'); const projects = deferred(); const tasks = deferred(); const focusOld = deferred(); const focusNew = deferred(); const calls = [];
  const mounted = mountBrain(root, { fetchApi(path, options) { calls.push({ path, options }); if (path.includes('type=project')) return projects.promise; if (path.includes('type=task')) return tasks.promise; if (path.includes('focus=task-outline')) return focusOld.promise; if (path.includes('focus=task-blocked')) return focusNew.promise; return Promise.resolve(response(PAYLOAD)); } });
  await settle();
  const projectCategory = root.querySelectorAll('button[data-category]').find((button) => button.dataset.category === 'Projects');
  const taskCategory = root.querySelectorAll('button[data-category]').find((button) => button.dataset.category === 'Tasks');
  projectCategory.dispatchEvent({ type: 'click' }); taskCategory.dispatchEvent({ type: 'click' });
  const projectCall = calls.find((call) => call.path.includes('type=project'));
  assert.ok(projectCall, 'category changes must request a bounded server projection');
  assert.equal(projectCall.options.signal.aborted, true);
  tasks.resolve(response(pagePayload([ITEMS[1], ITEMS[2]]))); await settle(); projects.resolve(response(pagePayload([ITEMS[0]]))); await settle();
  assert.deepEqual(root.querySelectorAll('button[data-item-id]').map((button) => button.dataset.itemId), ['task-outline', 'task-blocked']);
  const [outline, blocked] = root.querySelectorAll('button[data-item-id]');
  outline.dispatchEvent({ type: 'click' }); blocked.dispatchEvent({ type: 'click' });
  const oldCall = calls.find((call) => call.path.includes('focus=task-outline'));
  assert.equal(oldCall.options.signal.aborted, true);
  focusNew.resolve(response(FOCUS_PAYLOAD)); await settle(); focusOld.resolve(response(FOCUS_PAYLOAD)); await settle();
  assert.equal(root.querySelector('.brain-detail-title')?.textContent, 'Confirm privacy review');
  mounted.destroy();
});

test('a malformed oversized page never renders more than 100 result rows', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main');
  const oversized = Array.from({ length: 130 }, (_, index) => ({ ...ITEMS[0], id: `project-${index}`, title: `Project ${index}` }));
  const mounted = mountBrain(root, { fetchApi: async () => response(pagePayload(oversized, { total: 130, limit: 200, hasMore: false })) });
  await settle();
  assert.equal(root.querySelectorAll('button[data-item-id]').length, 100);
  mounted.destroy();
});

test('unavailable and empty states explain the next action without exposing a technical stack', async () => {
  const document = makeFakeDocument(); const root = document.createElement('main'); let attempts = 0;
  const mounted = mountBrain(root, { async fetchApi() { attempts += 1; if (attempts === 1) throw new Error('socket path /private/raw failed'); return response({ schema: 1, builtAt: 0, summary: {}, page: { total: 0, offset: 0, limit: 100, hasMore: false }, items: [], relations: [] }); } });
  await settle(); assert.match(root.textContent, /Second Brain is unavailable/i); assert.doesNotMatch(root.textContent, /socket|\/private\/raw|Error:/i);
  const retry = root.querySelectorAll('button').find((button) => button.textContent === 'Try again'); assert.ok(retry); retry.dispatchEvent({ type: 'click' }); await settle();
  assert.equal(attempts, 2); assert.match(root.textContent, /No local knowledge has been indexed yet/i); assert.match(root.textContent, /Add an approved Markdown note/i);
  mounted.destroy();
});
