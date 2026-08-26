import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeArgs } from '../server/lib/run-adapters/claude.js';
import { buildCodexArgs } from '../server/lib/run-adapters/codex.js';

import {
  buildRunRequest,
  createRunUiState,
  reduceRunUiState,
  safeRunError,
  skillKey,
} from '../public/js/run-state.js';

const originalDocument = globalThis.document;
const originalWarn = console.warn;
globalThis.document = { getElementById: () => null };
console.warn = () => {};
const dashboardModule = await import('../public/js/views/dashboard.js');
const {
  applicationViewModel,
  dashboardShellMarkup,
  mountDashboardControls,
  normalizeDashboardCatalog,
  reduceRunRailAction,
  sendRunRequest,
  skillCardMarkup,
  skillCardSelector,
  stageRoutesMarkup,
} = dashboardModule;
console.warn = originalWarn;
if (originalDocument === undefined) delete globalThis.document;
else globalThis.document = originalDocument;

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID_V7 = '019c9a3e-1234-7abc-8def-123456789abc';

function reduceManyRuns(state, actions) {
  return actions.reduce((current, action) => reduceRunUiState(current, action), state);
}

function fixtureRuns(total) {
  const activeFrom = Math.max(0, total - 3);
  const actions = [];
  for (let index = 0; index < total; index += 1) {
    const runId = `run-${String(index).padStart(2, '0')}`;
    actions.push({
      type: 'started',
      run: {
        runId, provider: index % 2 ? 'codex' : 'claude', skillName: null,
        label: `Run ${index}`, state: 'running', ok: null, sessionId: null,
        startedAt: index, endedAt: null, errorCode: null, errorMessage: null,
      },
    });
    if (index < activeFrom) {
      actions.push({
        type: 'done', runId, ok: true, sessionId: null, endedAt: 100 + index,
        errorCode: null,
      });
    }
  }
  return actions;
}

function reduceTerminalFailure(errorCode, runId) {
  let state = createRunUiState();
  state = reduceRunUiState(state, { type: 'started', run: {
    runId, provider: 'codex', skillName: null, label: 'Codex run',
    state: 'running', ok: null, sessionId: null, startedAt: 1, endedAt: null,
    errorCode: null, errorMessage: null,
  } });
  state = reduceRunUiState(state, {
    type: 'done', runId, ok: false, sessionId: null, endedAt: 2,
    errorCode, result: 'PRIVATE RAW RESULT',
  });
  return state.runs.get(runId);
}

test('same-name provider skills never collide', () => {
  assert.notEqual(skillKey('claude', 'review'), skillKey('codex', 'review'));
});

test('Continue and Cancel are explicit state transitions', () => {
  let state = createRunUiState();
  state = reduceRunUiState(state, { type: 'continue', provider: 'codex', sessionId: UUID });
  assert.deepEqual(state.resumeContext, { provider: 'codex', sessionId: UUID });
  assert.equal(state.selectedProvider, 'codex');
  assert.deepEqual(buildRunRequest({
    prompt: 'next',
    provider: state.resumeContext.provider,
    resumeSessionId: state.resumeContext.sessionId,
  }), {
    prompt: 'next', provider: 'codex', resumeSessionId: UUID,
  });
  state = reduceRunUiState(state, { type: 'cancel-resume' });
  assert.equal(state.resumeContext, null);
});

test('run rail keeps three active plus five newest completions independently', () => {
  const state = reduceManyRuns(createRunUiState(), fixtureRuns(12));
  assert.equal([...state.runs.values()].filter((run) => run.state === 'running').length, 3);
  assert.equal([...state.runs.values()].filter((run) => run.state !== 'running').length, 5);
  assert.deepEqual([...state.runs.keys()], [
    'run-11', 'run-10', 'run-09', 'run-08', 'run-07', 'run-06', 'run-05', 'run-04',
  ]);
});

test('unavailable CLI becomes a fixed provider-specific error and drops raw result', () => {
  let state = createRunUiState();
  state = reduceRunUiState(state, { type: 'started', run: {
    runId: 'run-cli', provider: 'codex', skillName: null, label: 'Codex run',
    state: 'running', ok: null, sessionId: null, startedAt: 1, endedAt: null,
    errorCode: null, errorMessage: null,
  } });
  state = reduceRunUiState(state, {
    type: 'done', runId: 'run-cli', ok: false, sessionId: null, endedAt: 2,
    errorCode: 'cli-unavailable', result: 'PRIVATE RAW STDERR',
  });
  const row = state.runs.get('run-cli');
  assert.equal(row.errorCode, 'cli-unavailable');
  assert.equal(row.errorMessage, 'Codex CLI not found');
  assert.equal(JSON.stringify(row).includes('PRIVATE RAW STDERR'), false);
});

test('authentication failure uses only the fixed authentication message', () => {
  const row = reduceTerminalFailure('authentication-required', 'run-auth');
  assert.equal(row.errorCode, 'authentication-required');
  assert.equal(row.errorMessage, 'Codex authentication failed');
  assert.equal(JSON.stringify(row).includes('PRIVATE RAW RESULT'), false);
});

test('expired resume request creates a bounded local failure row', () => {
  const state = reduceRunUiState(createRunUiState(), {
    type: 'request-failed', runId: `request:${UUID}`, provider: 'codex',
    skillName: null, label: 'Continue Codex', at: 10,
    errorCode: 'session-expired', result: 'server body must not be stored',
  });
  assert.deepEqual(state.runs.get(`request:${UUID}`), {
    runId: `request:${UUID}`, provider: 'codex', skillName: null,
    label: 'Continue Codex', state: 'error', ok: false, sessionId: null,
    startedAt: 10, endedAt: 10, errorCode: 'session-expired',
    errorMessage: 'Codex session could not be resumed',
  });
});

test('generic nonzero failure and unknown codes collapse to Run failed', () => {
  const generic = reduceTerminalFailure('run-failed', 'run-nonzero');
  const unknown = reduceTerminalFailure('future-raw-code', 'run-unknown');
  assert.deepEqual([generic.errorCode, generic.errorMessage], ['run-failed', 'Run failed']);
  assert.deepEqual([unknown.errorCode, unknown.errorMessage], ['run-failed', 'Run failed']);
  assert.equal(JSON.stringify([generic, unknown]).includes('PRIVATE RAW RESULT'), false);
});

test('reducers return a new Map, exact bounded rows, and never retain extra input fields', () => {
  const initial = createRunUiState('codex');
  const next = reduceRunUiState(initial, { type: 'started', run: {
    runId: 'run-exact', provider: 'codex', skillName: 'review',
    label: 'x'.repeat(120), state: 'spoofed', ok: true, sessionId: UUID,
    startedAt: 4, endedAt: 9, errorCode: 'run-failed', errorMessage: 'PRIVATE',
    prompt: 'SECRET PROMPT', transcript: 'SECRET TRANSCRIPT', stderr: 'SECRET STDERR',
  } });

  assert.notEqual(next.runs, initial.runs);
  assert.equal(initial.runs.size, 0);
  assert.deepEqual(next.runs.get('run-exact'), {
    runId: 'run-exact', provider: 'codex', skillName: 'review', label: 'x'.repeat(80),
    state: 'running', ok: null, sessionId: null, startedAt: 4, endedAt: null,
    errorCode: null, errorMessage: null,
  });
  assert.equal(JSON.stringify(next).includes('SECRET'), false);
});

test('safe errors are fixed, bounded, and provider-specific only where applicable', () => {
  assert.deepEqual(safeRunError('claude', 'cli-unavailable'), {
    errorCode: 'cli-unavailable', errorMessage: 'Claude CLI not found',
  });
  assert.deepEqual(safeRunError('codex', 'future-code'), {
    errorCode: 'run-failed', errorMessage: 'Run failed',
  });
  for (const provider of ['claude', 'codex']) {
    for (const code of [
      'cli-unavailable', 'authentication-required', 'session-expired', 'run-failed', 'unknown', null,
    ]) {
      const safe = safeRunError(provider, code);
      assert.ok(safe.errorMessage.length <= 80);
    }
  }
});

test('buildRunRequest omits null resume state and exposes only the request allowlist', () => {
  const input = {
    prompt: 'new task', provider: 'claude', resumeSessionId: null,
    transcript: 'PRIVATE', result: 'PRIVATE', error: 'PRIVATE',
  };
  assert.deepEqual(buildRunRequest(input), { prompt: 'new task', provider: 'claude' });
  assert.deepEqual(input, {
    prompt: 'new task', provider: 'claude', resumeSessionId: null,
    transcript: 'PRIVATE', result: 'PRIVATE', error: 'PRIVATE',
  });
});

test('dismiss and unknown actions cannot mutate prior state', () => {
  const started = reduceManyRuns(createRunUiState(), fixtureRuns(1));
  const ignored = reduceRunUiState(started, { type: 'future-action', prompt: 'PRIVATE' });
  const dismissed = reduceRunUiState(started, { type: 'dismiss', runId: 'run-00' });

  assert.equal(ignored, started);
  assert.equal(started.runs.size, 1);
  assert.notEqual(dismissed.runs, started.runs);
  assert.equal(dismissed.runs.size, 0);
});

test('Applications retain provider and kind while legacy MCP fallback is Claude-owned', () => {
  const applications = Object.freeze([
    Object.freeze({ id: 'claude:mcp:docs', name: 'docs', provider: 'claude', kind: 'mcp', version: null }),
    Object.freeze({ id: 'codex:plugin:tools', name: 'tools', provider: 'codex', kind: 'plugin', version: '1.2.3' }),
  ]);

  assert.deepEqual(applicationViewModel({ applications, mcpServers: ['legacy-ignored'] }), applications);
  assert.deepEqual(applicationViewModel({ mcpServers: ['legacy'] }), [{
    id: 'claude:mcp:legacy', name: 'legacy', provider: 'claude', kind: 'mcp', version: null,
  }]);
  assert.deepEqual(applicationViewModel({ applications: [], mcpServers: ['legacy-ignored'] }), []);
  for (const malformed of [null, { name: 'wrong-shape' }, 'wrong-shape']) {
    const catalog = { applications: malformed, mcpServers: ['must-not-be-fabricated-as-claude'] };
    assert.deepEqual(applicationViewModel(catalog), []);
    const normalized = normalizeDashboardCatalog(catalog);
    assert.equal(Object.hasOwn(normalized, 'applications'), true);
    assert.deepEqual(normalized.applications, []);
    assert.deepEqual(applicationViewModel(normalized), []);
  }
  const absent = normalizeDashboardCatalog({ mcpServers: ['legacy'] });
  assert.equal(Object.hasOwn(absent, 'applications'), false);
  assert.equal(applicationViewModel(absent)[0].provider, 'claude');
});

test('default dashboard identifies both local stores and exposes no execution UI', () => {
  const markup = dashboardShellMarkup();

  assert.match(markup, /LOCAL FILES ONLY · NO API KEY REQUIRED/);
  assert.match(markup, /\.claude \+ \.codex/);
  assert.match(markup, /data-tool="search"/);
  assert.match(markup, /data-tool="graph"/);
  assert.doesNotMatch(markup, /data-tool="cmd"|New run|Execution provider|run-rail|Run status/);
  assert.doesNotMatch(markup, /cmdbar|resume-context|data-run-action|provider-auth/);
});

test('dashboard shell exposes one Routed Instrument header contract across all panels', () => {
  const markup = dashboardShellMarkup();

  assert.equal((markup.match(/instrument-head/g) || []).length, 5);
  assert.match(markup, /signal-rail/);
  assert.match(markup, /data-panel="apps"/);
  assert.match(markup, /data-panel="routines"/);
});

test('skill cards expose provider routing ticks without replacing provider text', () => {
  const markup = skillCardMarkup({ name: 'review', provider: 'codex', description: 'Review' });

  assert.match(markup, /data-provider="codex"/);
  assert.match(markup, /provider-tick/);
  assert.match(markup, />Codex</);
});

test('stage route SVG uses elbow polylines and no straight line elements', () => {
  const markup = stageRoutesMarkup([
    { r: 180, a: -0.7 }, { r: 180, a: 0.7 }, { r: 120, a: 0 },
  ], 44);

  assert.match(markup, /class="stage-routes"/);
  assert.equal((markup.match(/<polyline/g) || []).length, 3);
  assert.doesNotMatch(markup, /<line\b/);
});

test('same-name skill cards remain provider-labelled local structure without execution controls', () => {
  const claude = skillCardMarkup({
    name: 'review', provider: 'claude', description: 'Claude review', model: 'sonnet', effort: 'max',
  });
  const codex = skillCardMarkup({
    name: 'review', provider: 'codex', description: 'Codex review', model: 'gpt-5.6-codex', effort: 'high',
  });

  assert.match(claude, /data-provider="claude" data-skill="review"/);
  assert.match(codex, /data-provider="codex" data-skill="review"/);
  assert.match(claude, />Claude<\/span>/);
  assert.match(codex, />Codex<\/span>/);
  assert.match(claude, /LOCAL SKILL/);
  assert.match(codex, /LOCAL SKILL/);
  assert.doesNotMatch(`${claude}${codex}`, /<button|<input|<select|data-act=|data-field=/);
  assert.doesNotMatch(claude, /sonnet|max/);
  assert.doesNotMatch(codex, /gpt-5\.6-codex|high/);
});

test('card selectors escape and address both provider and name', () => {
  const calls = [];
  const css = { escape(value) { calls.push(value); return `safe-${value}`; } };

  assert.equal(
    skillCardSelector('codex', 'review/name', css),
    '.skill-card[data-provider="safe-codex"][data-skill="safe-review/name"]',
  );
  assert.deepEqual(calls, ['codex', 'review/name']);
});

test('run request response allowlists success and non-2xx failure fields', async () => {
  const hostileFailure = async () => ({
    ok: false,
    async json() {
      return {
        errorCode: 'session-expired',
        error: '/Users/private/.codex/session secret',
        result: 'PRIVATE RESULT',
      };
    },
  });
  const hostileSuccess = async () => ({
    ok: true,
    async json() {
      return {
        runId: 'run-safe', sessionId: UUID,
        prompt: 'PRIVATE PROMPT', transcript: 'PRIVATE TRANSCRIPT', result: 'PRIVATE RESULT',
      };
    },
  });

  assert.deepEqual(await sendRunRequest(
    buildRunRequest({ prompt: 'continue', provider: 'codex', resumeSessionId: UUID }),
    hostileFailure,
  ), { ok: false, errorCode: 'session-expired' });
  assert.deepEqual(await sendRunRequest(
    buildRunRequest({ prompt: 'run', provider: 'codex' }),
    hostileSuccess,
  ), { ok: true, runId: 'run-safe', sessionId: UUID });
});

test('run request transport and malformed responses collapse to bounded generic failure', async () => {
  assert.deepEqual(await sendRunRequest(
    { prompt: 'x', provider: 'claude' },
    async () => { throw new Error('/private/raw failure'); },
  ), { ok: false, errorCode: 'run-failed' });
  assert.deepEqual(await sendRunRequest(
    { prompt: 'x', provider: 'claude' },
    async () => ({ ok: false, async json() { throw new Error('raw body'); } }),
  ), { ok: false, errorCode: 'run-failed' });
});

test('three concurrent rows stay independent and Continue binds only the selected row UUID', () => {
  const secondUuid = '22222222-2222-4222-8222-222222222222';
  let state = createRunUiState();
  for (const [runId, provider, startedAt] of [
    ['claude-one', 'claude', 1],
    ['codex-one', 'codex', 2],
    ['codex-two', 'codex', 3],
  ]) {
    state = reduceRunUiState(state, { type: 'started', run: {
      runId, provider, skillName: 'review', label: `${provider} review`,
      state: 'running', ok: null, sessionId: null, startedAt, endedAt: null,
      errorCode: null, errorMessage: null,
    } });
  }
  state = reduceRunUiState(state, {
    type: 'done', runId: 'codex-one', ok: true, sessionId: UUID, endedAt: 4, errorCode: null,
  });
  state = reduceRunUiState(state, {
    type: 'done', runId: 'codex-two', ok: true, sessionId: secondUuid, endedAt: 5, errorCode: null,
  });

  const continued = reduceRunRailAction(state, 'codex-two', 'continue');
  assert.deepEqual(continued.resumeContext, { provider: 'codex', sessionId: secondUuid });
  assert.equal(continued.runs.get('codex-one').sessionId, UUID);
  assert.equal(continued.runs.get('codex-two').sessionId, secondUuid);
  assert.equal(continued.runs.get('claude-one').state, 'running');

  const dismissed = reduceRunRailAction(continued, 'codex-one', 'dismiss');
  assert.equal(dismissed.runs.has('codex-one'), false);
  assert.equal(dismissed.runs.has('codex-two'), true);
  assert.deepEqual(dismissed.resumeContext, { provider: 'codex', sessionId: secondUuid });
});

class ControlElement {
  constructor(tag, ownerDocument = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.placeholder = '';
    this._textContent = '';
    this._listeners = new Map();
    this.classList = {
      contains: (name) => this.className.split(/\s+/).filter(Boolean).includes(name),
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(' ');
      },
      remove: (...names) => {
        const removed = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(' ');
      },
    };
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this.childNodes = [];
  }

  get textContent() {
    return this.childNodes.length
      ? this.childNodes.map((child) => child.textContent).join('')
      : this._textContent;
  }

  append(...children) {
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (child.tagName === '#FRAGMENT') {
        this.append(...child.childNodes);
        continue;
      }
      child.parentElement = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this._textContent = '';
    this.append(...children);
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }

  addEventListener(type, handler) {
    let handlers = this._listeners.get(type);
    if (!handlers) { handlers = new Set(); this._listeners.set(type, handlers); }
    handlers.add(handler);
  }

  removeEventListener(type, handler) { this._listeners.get(type)?.delete(handler); }

  dispatchEvent(event) {
    const ev = event && typeof event === 'object' ? event : { type: String(event) };
    if (!ev.target) ev.target = this;
    if (!ev.preventDefault) ev.preventDefault = () => { ev.defaultPrevented = true; };
    for (let current = this; current; current = current.parentElement) {
      ev.currentTarget = current;
      for (const handler of [...(current._listeners.get(ev.type) || [])]) handler(ev);
    }
    return !ev.defaultPrevented;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const data = selector.match(/^([a-z]+)?\[data-([a-z-]+)(?:="([^"]*)")?\]$/i);
    if (data) {
      if (data[1] && this.tagName !== data[1].toUpperCase()) return false;
      const key = data[2].replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
      if (!Object.hasOwn(this.dataset, key)) return false;
      return data[3] === undefined || this.dataset[key] === data[3];
    }
    return this.tagName === selector.toUpperCase();
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

function controlDocument() {
  const document = new ControlElement('#document');
  document.ownerDocument = document;
  document.activeElement = null;
  document.createElement = (tag) => new ControlElement(tag, document);
  document.createDocumentFragment = () => new ControlElement('#fragment', document);
  return document;
}

function appendControl(document, parent, tag, { className = '', dataset = {}, text = '' } = {}) {
  const element = document.createElement(tag);
  element.className = className;
  Object.assign(element.dataset, dataset);
  element.textContent = text;
  parent.append(element);
  return element;
}

function mountRunControlFixture(initialState = createRunUiState()) {
  const document = controlDocument();
  const providerSwitch = document.createElement('div');
  appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'claude' }, text: 'Claude',
  });
  appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'codex' }, text: 'Codex',
  });
  const resume = document.createElement('div');
  const resumeLabel = appendControl(document, resume, 'span');
  appendControl(document, resume, 'button', {
    dataset: { action: 'cancel-resume' }, text: 'Cancel',
  });
  const runrail = document.createElement('section');
  const cmdbar = document.createElement('form');
  appendControl(document, cmdbar, 'input', { className: 'cmdbar-input' });
  const deck = document.createElement('div');
  const controls = mountDashboardControls({
    initialState,
    elements: { providerSwitch, resume, resumeLabel, runrail, cmdbar, deck },
  });
  return { controls, runrail };
}

test('mounted dashboard controls use clicked DOM row identity and isolate same-name provider editors', () => {
  const secondUuid = '22222222-2222-4222-8222-222222222222';
  let state = createRunUiState();
  for (const [runId, provider, label, startedAt] of [
    ['claude-active', 'claude', 'Claude /review', 1],
    ['codex-one', 'codex', 'Codex /review one', 2],
    ['codex-two', 'codex', 'Codex /review two', 3],
  ]) {
    state = reduceRunUiState(state, { type: 'started', run: {
      runId, provider, skillName: 'review', label,
      state: 'running', ok: null, sessionId: null, startedAt, endedAt: null,
      errorCode: null, errorMessage: null,
    } });
  }
  state = reduceRunUiState(state, {
    type: 'done', runId: 'codex-one', ok: true, sessionId: UUID, endedAt: 4, errorCode: null,
  });
  state = reduceRunUiState(state, {
    type: 'done', runId: 'codex-two', ok: true, sessionId: secondUuid, endedAt: 5, errorCode: null,
  });

  const document = controlDocument();
  const providerSwitch = document.createElement('div');
  const claudeButton = appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'claude' }, text: 'Claude',
  });
  const codexButton = appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'codex' }, text: 'Codex',
  });
  const resume = document.createElement('div');
  const resumeLabel = appendControl(document, resume, 'span');
  appendControl(document, resume, 'button', {
    dataset: { action: 'cancel-resume' }, text: 'Cancel',
  });
  const runrail = document.createElement('section');
  const cmdbar = document.createElement('form');
  const prompt = appendControl(document, cmdbar, 'input', { className: 'cmdbar-input' });
  const deck = document.createElement('div');

  function addSkillCard(provider) {
    const card = appendControl(document, deck, 'article', {
      className: 'skill-card', dataset: { provider, skill: 'review' },
    });
    const button = appendControl(document, card, 'button', {
      dataset: { act: 'edit' }, text: `Edit ${provider}`,
    });
    const editor = appendControl(document, card, 'div', { className: 'skill-edit' });
    editor.hidden = true;
    appendControl(document, card, 'span', { dataset: { slot: 'note' } });
    return { card, button, editor };
  }

  const claudeCard = addSkillCard('claude');
  const codexCard = addSkillCard('codex');
  const mounted = mountDashboardControls({
    initialState: state,
    elements: { providerSwitch, resume, resumeLabel, runrail, cmdbar, deck },
  });
  try {
    claudeCard.button.dispatchEvent({ type: 'click' });
    assert.equal(claudeCard.editor.hidden, false);
    assert.equal(codexCard.editor.hidden, true);

    const rowsBefore = runrail.querySelectorAll('.run-row');
    const labelsBefore = rowsBefore.map((row) => row.querySelector('.run-label').textContent);
    assert.deepEqual(labelsBefore, ['Claude /review', 'Codex /review two', 'Codex /review one']);
    const clickedRow = rowsBefore.find((row) => row.dataset.runId === 'codex-two');
    const continueButton = clickedRow.querySelector('button[data-run-action="continue"]');
    continueButton.dispatchEvent({ type: 'click' });

    assert.deepEqual(mounted.getState().resumeContext, { provider: 'codex', sessionId: secondUuid });
    assert.equal(resume.hidden, false);
    assert.equal(resumeLabel.textContent, 'Continuing Codex · 22222222');
    assert.equal(claudeButton.getAttribute('aria-pressed'), 'false');
    assert.equal(codexButton.getAttribute('aria-pressed'), 'true');
    assert.equal(claudeButton.disabled, true);
    assert.equal(codexButton.disabled, true);
    assert.equal(document.activeElement, prompt);

    const rowsAfter = runrail.querySelectorAll('.run-row');
    assert.equal(rowsAfter.length, 3);
    assert.deepEqual(
      rowsAfter.map((row) => [row.dataset.runId, row.querySelector('.run-label').textContent]),
      rowsBefore.map((row) => [row.dataset.runId, row.querySelector('.run-label').textContent]),
    );
    assert.equal(mounted.getState().runs.get('codex-one').sessionId, UUID);
    assert.equal(mounted.getState().runs.get('codex-two').sessionId, secondUuid);
    assert.equal(mounted.getState().runs.get('claude-active').state, 'running');
  } finally {
    mounted.destroy();
  }
});

test('canonical RFC UUID versions 1-8 are resumable while unsupported forms stay inert', () => {
  for (const version of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    const sessionId = `019c9a3e-1234-${version}abc-8def-123456789abc`;
    assert.deepEqual(buildRunRequest({
      prompt: 'continue', provider: 'codex', resumeSessionId: sessionId,
    }), {
      prompt: 'continue', provider: 'codex', resumeSessionId: sessionId,
    });
    const continued = reduceRunUiState(createRunUiState(), {
      type: 'continue', provider: 'codex', sessionId,
    });
    assert.deepEqual(continued.resumeContext, { provider: 'codex', sessionId });
  }

  for (const sessionId of [
    '019c9a3e-1234-0abc-8def-123456789abc',
    '019c9a3e-1234-9abc-8def-123456789abc',
    '019c9a3e-1234-7abc-7def-123456789abc',
    '019c9a3e12347abc8def123456789abc',
    '--last',
  ]) {
    assert.deepEqual(buildRunRequest({
      prompt: 'continue', provider: 'codex', resumeSessionId: sessionId,
    }), { prompt: 'continue', provider: 'codex' });
    const initial = createRunUiState('codex');
    assert.equal(reduceRunUiState(initial, {
      type: 'continue', provider: 'codex', sessionId,
    }), initial);
  }
});

test('mounted UUIDv7 run.done Continue sends the exact isolated Codex resume request', async () => {
  const state = reduceRunUiState(createRunUiState('claude'), { type: 'started', run: {
    runId: 'codex-v7', provider: 'codex', skillName: 'review', label: 'Codex /review v7',
    state: 'running', ok: null, sessionId: null, startedAt: 7, endedAt: null,
    errorCode: null, errorMessage: null,
  } });

  const document = controlDocument();
  const providerSwitch = document.createElement('div');
  const claudeButton = appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'claude' }, text: 'Claude',
  });
  const codexButton = appendControl(document, providerSwitch, 'button', {
    dataset: { provider: 'codex' }, text: 'Codex',
  });
  const resume = document.createElement('div');
  const resumeLabel = appendControl(document, resume, 'span');
  appendControl(document, resume, 'button', {
    dataset: { action: 'cancel-resume' }, text: 'Cancel',
  });
  const runrail = document.createElement('section');
  const cmdbar = document.createElement('form');
  appendControl(document, cmdbar, 'input', { className: 'cmdbar-input' });
  const deck = document.createElement('div');

  function addSkillCard(provider) {
    const card = appendControl(document, deck, 'article', {
      className: 'skill-card', dataset: { provider, skill: 'review' },
    });
    const button = appendControl(document, card, 'button', {
      dataset: { act: 'edit' }, text: `Edit ${provider}`,
    });
    const editor = appendControl(document, card, 'div', { className: 'skill-edit' });
    editor.hidden = true;
    appendControl(document, card, 'span', { dataset: { slot: 'note' } });
    return { button, editor };
  }

  const claudeCard = addSkillCard('claude');
  const codexCard = addSkillCard('codex');
  const mounted = mountDashboardControls({
    initialState: state,
    elements: { providerSwitch, resume, resumeLabel, runrail, cmdbar, deck },
  });
  try {
    assert.equal(runrail.querySelector('button[data-run-action="continue"]'), null);
    mounted.commit(reduceRunUiState(mounted.getState(), {
      type: 'done', runId: 'codex-v7', ok: true, sessionId: UUID_V7,
      endedAt: 8, errorCode: null,
    }));
    assert.equal(mounted.getState().runs.get('codex-v7').sessionId, UUID_V7);

    codexCard.button.dispatchEvent({ type: 'click' });
    assert.equal(codexCard.editor.hidden, false);
    assert.equal(claudeCard.editor.hidden, true);

    const continueButton = runrail.querySelector('button[data-run-action="continue"]');
    assert.ok(continueButton);
    continueButton.dispatchEvent({ type: 'click' });

    const resumed = mounted.getState();
    assert.deepEqual(resumed.resumeContext, { provider: 'codex', sessionId: UUID_V7 });
    assert.equal(resumed.runs.get('codex-v7').provider, 'codex');
    assert.equal(resumeLabel.textContent, 'Continuing Codex · 019c9a3e');
    assert.equal(claudeButton.getAttribute('aria-pressed'), 'false');
    assert.equal(codexButton.getAttribute('aria-pressed'), 'true');
    assert.equal(claudeButton.disabled, true);
    assert.equal(codexButton.disabled, true);
    assert.equal(claudeCard.editor.hidden, true);
    assert.equal(codexCard.editor.hidden, false);

    const request = buildRunRequest({
      prompt: 'continue safely',
      provider: resumed.selectedProvider,
      resumeSessionId: resumed.resumeContext.sessionId,
      cwd: '/untrusted/caller-must-not-override-captured-cwd',
    });
    const calls = [];
    const response = await sendRunRequest(request, async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, async json() { return { runId: 'resumed-v7', sessionId: UUID_V7 }; } };
    });
    assert.deepEqual(request, {
      prompt: 'continue safely', provider: 'codex', resumeSessionId: UUID_V7,
    });
    assert.deepEqual(calls.map(({ url, body }) => ({ url, body })), [{
      url: '/api/run',
      body: { prompt: 'continue safely', provider: 'codex', resumeSessionId: UUID_V7 },
    }]);
    assert.equal(Object.hasOwn(calls[0].body, 'cwd'), false);
    assert.deepEqual(response, { ok: true, runId: 'resumed-v7', sessionId: UUID_V7 });
  } finally {
    mounted.destroy();
  }
});

test('mounted invalid session forms render no Continue and cannot build a resume request', () => {
  const invalid = [
    '019c9a3e-1234-0abc-8def-123456789abc',
    '019c9a3e-1234-9abc-8def-123456789abc',
    '019c9a3e-1234-7abc-7def-123456789abc',
    '019c9a3e12347abc8def123456789abc',
    '--last',
  ];
  let state = createRunUiState('codex');
  invalid.forEach((sessionId, index) => {
    const runId = `invalid-${index}`;
    state = reduceRunUiState(state, { type: 'started', run: {
      runId, provider: 'codex', skillName: null, label: `Invalid session ${index}`,
      state: 'running', ok: null, sessionId: null, startedAt: index, endedAt: null,
      errorCode: null, errorMessage: null,
    } });
    state = reduceRunUiState(state, {
      type: 'done', runId, ok: true, sessionId, endedAt: 10 + index, errorCode: null,
    });
    assert.equal(state.runs.get(runId).sessionId, null);
  });

  const document = controlDocument();
  const providerSwitch = document.createElement('div');
  appendControl(document, providerSwitch, 'button', { dataset: { provider: 'claude' }, text: 'Claude' });
  appendControl(document, providerSwitch, 'button', { dataset: { provider: 'codex' }, text: 'Codex' });
  const resume = document.createElement('div');
  const resumeLabel = appendControl(document, resume, 'span');
  const runrail = document.createElement('section');
  const cmdbar = document.createElement('form');
  appendControl(document, cmdbar, 'input', { className: 'cmdbar-input' });
  const deck = document.createElement('div');
  const mounted = mountDashboardControls({
    initialState: state,
    elements: { providerSwitch, resume, resumeLabel, runrail, cmdbar, deck },
  });
  try {
    assert.equal(runrail.querySelectorAll('button[data-run-action="continue"]').length, 0);
    assert.equal(mounted.getState().resumeContext, null);
    for (const sessionId of invalid) {
      assert.deepEqual(buildRunRequest({
        prompt: 'must be new', provider: 'codex', resumeSessionId: sessionId,
      }), { prompt: 'must be new', provider: 'codex' });
    }
  } finally {
    mounted.destroy();
  }
});

test('mounted coordinator reconciles run.done received before POST response and bounds cleanup', async () => {
  const { controls, runrail } = mountRunControlFixture(createRunUiState('codex'));
  const coordinator = dashboardModule.createDashboardRunCoordinator({
    controls, now: () => 20, maxBuffered: 50,
  });
  const requestToken = coordinator.beginRequest();
  let resolveFetch;
  const responsePromise = sendRunRequest(
    buildRunRequest({ prompt: '/fast', provider: 'codex' }),
    () => new Promise((resolve) => { resolveFetch = resolve; }),
  );
  try {
    coordinator.handleDone({
      runId: 'fast-run', ok: false, provider: 'codex', sessionId: null,
      errorCode: 'cli-unavailable', result: 'PRIVATE SPAWN FAILURE',
    });
    assert.equal(coordinator.getBufferedCount(), 1);
    assert.equal(controls.getState().runs.size, 0);

    resolveFetch({
      ok: true,
      async json() { return { runId: 'fast-run', sessionId: 'request-placeholder' }; },
    });
    const response = await responsePromise;
    const row = coordinator.registerAcceptedRun({
      runId: response.runId,
      provider: 'codex',
      skillName: 'fast',
      label: 'Codex /fast',
      startedAt: 10,
    }, requestToken);

    assert.deepEqual(row, {
      runId: 'fast-run', provider: 'codex', skillName: 'fast', label: 'Codex /fast',
      state: 'error', ok: false, sessionId: null, startedAt: 10, endedAt: 20,
      errorCode: 'cli-unavailable', errorMessage: 'Codex CLI not found',
    });
    assert.equal(coordinator.getBufferedCount(), 0);
    assert.equal(controls.getState().runs.get('fast-run').state, 'error');
    assert.equal(runrail.querySelector('.run-status').textContent, 'Failed');
    assert.equal(runrail.textContent.includes('PRIVATE SPAWN FAILURE'), false);

    const boundedToken = coordinator.beginRequest();
    for (let index = 0; index < 100; index += 1) {
      coordinator.handleDone({
        runId: `foreign-${index}`, ok: false, errorCode: 'run-failed',
        result: `PRIVATE ${index}`,
      });
    }
    assert.equal(coordinator.getBufferedCount(), 50);
    coordinator.finishRequest(boundedToken);
    assert.equal(coordinator.getBufferedCount(), 0);
    coordinator.handleDone({ runId: 'foreign-after-post', ok: true, sessionId: UUID_V7 });
    assert.equal(coordinator.getBufferedCount(), 0);
    coordinator.destroy();
  } finally {
    coordinator.destroy();
    controls.destroy();
  }
});

test('early successful skill and command rows present Done without an error tone', () => {
  const { controls, runrail } = mountRunControlFixture(createRunUiState('codex'));
  const coordinator = dashboardModule.createDashboardRunCoordinator({
    controls, now: () => 40,
  });
  const skillToken = coordinator.beginRequest();
  const commandToken = coordinator.beginRequest();
  try {
    coordinator.handleDone({
      runId: 'fast-skill-success', ok: true, sessionId: UUID_V7,
      result: 'PRIVATE SUCCESS RESULT',
    });
    coordinator.handleDone({
      runId: 'fast-command-success', ok: true, sessionId: UUID_V7,
      result: 'PRIVATE SUCCESS RESULT',
    });
    const skillRow = coordinator.registerAcceptedRun({
      runId: 'fast-skill-success', provider: 'codex', skillName: 'review',
      label: 'Codex /review', startedAt: 30,
    }, skillToken);
    const commandRow = coordinator.registerAcceptedRun({
      runId: 'fast-command-success', provider: 'codex', skillName: null,
      label: 'Codex command', startedAt: 31,
    }, commandToken);

    const document = runrail.ownerDocument;
    const skillNote = document.createElement('span');
    const commandState = document.createElement('span');
    dashboardModule.presentRunLaunch(skillNote, skillRow, 'skill-note');
    dashboardModule.presentRunLaunch(commandState, commandRow, 'cmdbar-state');

    assert.equal(skillNote.textContent, 'Done');
    assert.equal(skillNote.className, 'skill-note');
    assert.equal(commandState.textContent, 'Done');
    assert.equal(commandState.className, 'cmdbar-state');
    assert.equal(`${skillNote.textContent}${commandState.textContent}`.includes('PRIVATE'), false);

    const failureToken = coordinator.beginRequest();
    coordinator.handleDone({
      runId: 'fast-command-failure', ok: false, errorCode: 'cli-unavailable',
      result: 'PRIVATE FAILURE RESULT',
    });
    const failureRow = coordinator.registerAcceptedRun({
      runId: 'fast-command-failure', provider: 'codex', skillName: null,
      label: 'Codex command', startedAt: 32,
    }, failureToken);
    const failureState = document.createElement('span');
    dashboardModule.presentRunLaunch(failureState, failureRow, 'cmdbar-state');
    assert.equal(failureState.textContent, 'Codex CLI not found');
    assert.equal(failureState.className, 'cmdbar-state is-bad');
    assert.equal(failureState.textContent.includes('PRIVATE'), false);
  } finally {
    coordinator.destroy();
    controls.destroy();
  }
});

test('same-name catalog skill overrides cross only their new-run request and argv boundary', async () => {
  const catalog = {
    skills: [
      { name: 'review', provider: 'claude', model: 'opus', effort: 'max' },
      { name: 'review', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    ],
  };
  const claude = dashboardModule.buildCatalogSkillRunRequest(catalog, {
    prompt: '/review', provider: 'claude', name: 'review',
  });
  const codex = dashboardModule.buildCatalogSkillRunRequest(catalog, {
    prompt: '/review', provider: 'codex', name: 'review',
  });

  assert.deepEqual(claude, {
    prompt: '/review', provider: 'claude', model: 'opus', effort: 'max',
  });
  assert.deepEqual(codex, {
    prompt: '/review', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
  });
  assert.deepEqual(buildClaudeArgs({ runId: UUID, ...claude }), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', UUID,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Bash',
    '--max-budget-usd', '5',
    '--model', 'opus', '--effort', 'max',
  ]);
  assert.deepEqual(buildCodexArgs({ ...codex, skipGitRepoCheck: false }), [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    'exec', '--json', '--color', 'never',
    '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high', '-',
  ]);

  const posted = [];
  await sendRunRequest(codex, async (_url, options) => {
    posted.push(JSON.parse(options.body));
    return { ok: true, async json() { return { runId: 'codex-review' }; } };
  });
  assert.deepEqual(posted, [codex]);

  assert.deepEqual(buildRunRequest({
    prompt: 'generic', provider: 'codex',
    model: 'gpt-5.6-sol', effort: 'high',
  }), { prompt: 'generic', provider: 'codex' });
  assert.deepEqual(buildRunRequest({
    prompt: 'resume', provider: 'codex', resumeSessionId: UUID_V7,
    model: 'gpt-5.6-sol', effort: 'high',
  }), { prompt: 'resume', provider: 'codex', resumeSessionId: UUID_V7 });

  assert.deepEqual(dashboardModule.buildCatalogSkillRunRequest({
    skills: [
      { name: 'bad', provider: 'codex', model: 'bad model;rm', effort: 'max' },
      { name: 'bad', provider: 'claude', model: 'gpt-5.6-sol', effort: 'future' },
    ],
  }, { prompt: '/bad', provider: 'codex', name: 'bad' }), {
    prompt: '/bad', provider: 'codex',
  });
  assert.deepEqual(dashboardModule.buildCatalogSkillRunRequest({
    skills: [
      { name: 'bad', provider: 'codex', model: 'bad model;rm', effort: 'max' },
      { name: 'bad', provider: 'claude', model: 'gpt-5.6-sol', effort: 'future' },
    ],
  }, { prompt: '/bad', provider: 'claude', name: 'bad' }), {
    prompt: '/bad', provider: 'claude',
  });
});

test('four accepted runs keep hidden active tracking until every terminal event is reconciled', () => {
  const { controls, runrail } = mountRunControlFixture(createRunUiState('codex'));
  let clock = 10;
  const coordinator = dashboardModule.createDashboardRunCoordinator({
    controls, now: () => ++clock, maxBuffered: 50,
  });
  try {
    for (let index = 1; index <= 4; index += 1) {
      coordinator.registerAcceptedRun({
        runId: `accepted-${index}`,
        provider: 'codex',
        skillName: null,
        label: `Codex command ${index}`,
        startedAt: index,
      });
    }
    assert.deepEqual([...controls.getState().runs.keys()], [
      'accepted-4', 'accepted-3', 'accepted-2',
    ]);

    const fourth = coordinator.handleDone({
      runId: 'accepted-4', ok: false, sessionId: null, errorCode: 'run-failed',
      result: 'PRIVATE concurrency failure',
    });
    assert.equal(fourth.state, 'error');
    assert.equal(fourth.errorMessage, 'Run failed');
    assert.deepEqual([...controls.getState().runs.keys()], [
      'accepted-3', 'accepted-2', 'accepted-1', 'accepted-4',
    ]);

    const older = coordinator.handleDone({
      runId: 'accepted-1', ok: true, sessionId: UUID_V7, errorCode: null,
      result: 'PRIVATE success result',
    });
    assert.ok(older);
    assert.equal(older.state, 'done');
    assert.equal(older.sessionId, UUID_V7);
    assert.deepEqual([...controls.getState().runs.keys()], [
      'accepted-3', 'accepted-2', 'accepted-1', 'accepted-4',
    ]);
    assert.equal(runrail.textContent.includes('PRIVATE'), false);
    assert.equal(coordinator.getBufferedCount(), 0);
    assert.equal(coordinator.getTrackedCount(), 2);
  } finally {
    coordinator.destroy();
    controls.destroy();
  }
});
