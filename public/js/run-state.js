// Pure, bounded dashboard run state. This module has no DOM, network, or
// storage access so raw provider output can never enter persisted UI state.

const PROVIDERS = new Set(['claude', 'codex']);
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL = 80;
const MAX_RUN_ID = 128;

const ERROR_MESSAGES = Object.freeze({
  'authentication-required': 'Codex authentication failed',
  'session-expired': 'Codex session could not be resumed',
  'run-failed': 'Run failed',
});

const ERROR_CODES = new Set([
  'cli-unavailable',
  'authentication-required',
  'session-expired',
  'run-failed',
]);

function providerOf(value) {
  return PROVIDERS.has(value) ? value : 'claude';
}

function nullableString(value, max = MAX_LABEL) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function canonicalSessionId(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function orderAndBound(runs) {
  const active = [];
  const recent = [];
  for (const row of runs.values()) {
    if (row.state === 'running') active.push(row);
    else recent.push(row);
  }
  active.sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
  recent.sort((a, b) => (
    b.endedAt - a.endedAt
    || b.startedAt - a.startedAt
    || b.runId.localeCompare(a.runId)
  ));
  return new Map([...active.slice(0, 3), ...recent.slice(0, 5)].map((row) => [row.runId, row]));
}

export function skillKey(provider, name) {
  return `${providerOf(provider)}\0${String(name ?? '')}`;
}

export function createRunUiState(selectedProvider = 'claude') {
  return {
    selectedProvider: providerOf(selectedProvider),
    resumeContext: null,
    runs: new Map(),
  };
}

export function safeRunError(provider, errorCode) {
  const code = ERROR_CODES.has(errorCode) ? errorCode : 'run-failed';
  const errorMessage = code === 'cli-unavailable'
    ? `${providerOf(provider) === 'codex' ? 'Codex' : 'Claude'} CLI not found`
    : ERROR_MESSAGES[code];
  return { errorCode: code, errorMessage };
}

export function buildRunRequest({ prompt, provider, resumeSessionId = null } = {}) {
  const selectedProvider = providerOf(provider);
  const request = { prompt, provider: selectedProvider };
  const sessionId = selectedProvider === 'codex' ? canonicalSessionId(resumeSessionId) : null;
  if (sessionId !== null) request.resumeSessionId = sessionId;
  return request;
}

function skillOverride(provider, field, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (field === 'model') {
    if (provider === 'codex') return CODEX_MODEL.test(trimmed) ? trimmed : null;
    const model = trimmed.toLowerCase();
    return CLAUDE_MODELS.has(model) ? model : null;
  }
  const effort = trimmed.toLowerCase();
  const allowed = provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  return allowed.has(effort) ? effort : null;
}

export function buildSkillRunRequest({ prompt, provider, model = null, effort = null } = {}) {
  const request = buildRunRequest({ prompt, provider });
  const modelOverride = skillOverride(request.provider, 'model', model);
  const effortOverride = skillOverride(request.provider, 'effort', effort);
  if (modelOverride !== null) request.model = modelOverride;
  if (effortOverride !== null) request.effort = effortOverride;
  return request;
}

export function safeRunDoneAction(payload, endedAt) {
  const runId = typeof payload?.runId === 'string' && payload.runId.length > 0
    && payload.runId.length <= MAX_RUN_ID
    ? payload.runId
    : null;
  if (runId === null) return null;
  const ok = payload?.ok === true;
  return {
    type: 'done',
    runId,
    ok,
    sessionId: ok ? canonicalSessionId(payload?.sessionId) : null,
    endedAt: finiteTime(endedAt),
    errorCode: ok
      ? null
      : (ERROR_CODES.has(payload?.errorCode) ? payload.errorCode : 'run-failed'),
  };
}

export function reconcileTrackedRunDone(state, trackedRow, action) {
  if (!state || !(state.runs instanceof Map) || !trackedRow || action?.type !== 'done') {
    return state;
  }
  if (state.runs.has(action.runId)) return reduceRunUiState(state, action);
  const isolatedStarted = reduceRunUiState(createRunUiState(trackedRow.provider), {
    type: 'started', run: trackedRow,
  });
  const isolatedDone = reduceRunUiState(isolatedStarted, action);
  const terminal = isolatedDone.runs.get(action.runId);
  if (!terminal || terminal.state === 'running') return state;
  const runs = new Map(state.runs);
  runs.set(terminal.runId, terminal);
  return { ...state, runs: orderAndBound(runs) };
}

export function projectTrackedRuns(state, trackedRows) {
  if (!state || !(state.runs instanceof Map) || !trackedRows?.[Symbol.iterator]) return state;
  const runs = new Map(state.runs);
  for (const trackedRow of trackedRows) {
    if (!trackedRow || trackedRow.state !== 'running' || typeof trackedRow.runId !== 'string') continue;
    const row = runningRow(trackedRow);
    runs.set(row.runId, row);
  }
  return { ...state, runs: orderAndBound(runs) };
}

function runningRow(run) {
  return {
    runId: String(run.runId),
    provider: providerOf(run.provider),
    skillName: nullableString(run.skillName),
    label: nullableString(run.label) ?? 'Run',
    state: 'running',
    ok: null,
    sessionId: null,
    startedAt: finiteTime(run.startedAt),
    endedAt: null,
    errorCode: null,
    errorMessage: null,
  };
}

function requestFailureRow(action) {
  const provider = providerOf(action.provider);
  const error = safeRunError(provider, action.errorCode);
  const at = finiteTime(action.at);
  return {
    runId: String(action.runId),
    provider,
    skillName: nullableString(action.skillName),
    label: nullableString(action.label) ?? 'Run request',
    state: 'error',
    ok: false,
    sessionId: null,
    startedAt: at,
    endedAt: at,
    errorCode: error.errorCode,
    errorMessage: error.errorMessage,
  };
}

export function reduceRunUiState(state, action) {
  if (!state || !(state.runs instanceof Map) || !action || typeof action !== 'object') return state;

  if (action.type === 'select-provider') {
    if (!PROVIDERS.has(action.provider)) return state;
    return {
      ...state,
      selectedProvider: action.provider,
      resumeContext: state.resumeContext?.provider === action.provider ? state.resumeContext : null,
    };
  }

  if (action.type === 'continue') {
    const sessionId = action.provider === 'codex' ? canonicalSessionId(action.sessionId) : null;
    if (!sessionId) return state;
    return {
      ...state,
      selectedProvider: 'codex',
      resumeContext: { provider: 'codex', sessionId },
    };
  }

  if (action.type === 'cancel-resume') {
    if (state.resumeContext === null) return state;
    return { ...state, resumeContext: null };
  }

  if (action.type === 'started') {
    if (!action.run || typeof action.run.runId !== 'string' || action.run.runId.length === 0) return state;
    const runs = new Map(state.runs);
    const row = runningRow(action.run);
    runs.set(row.runId, row);
    return { ...state, runs: orderAndBound(runs) };
  }

  if (action.type === 'done') {
    if (typeof action.runId !== 'string' || !state.runs.has(action.runId)) return state;
    const current = state.runs.get(action.runId);
    const ok = action.ok === true;
    const error = ok ? null : safeRunError(current.provider, action.errorCode);
    const runs = new Map(state.runs);
    runs.set(action.runId, {
      ...current,
      state: ok ? 'done' : 'error',
      ok,
      sessionId: ok && current.provider === 'codex' ? canonicalSessionId(action.sessionId) : null,
      endedAt: finiteTime(action.endedAt),
      errorCode: error?.errorCode ?? null,
      errorMessage: error?.errorMessage ?? null,
    });
    return { ...state, runs: orderAndBound(runs) };
  }

  if (action.type === 'request-failed') {
    if (typeof action.runId !== 'string' || !action.runId.startsWith('request:')) return state;
    const runs = new Map(state.runs);
    const row = requestFailureRow(action);
    runs.set(row.runId, row);
    return { ...state, runs: orderAndBound(runs) };
  }

  if (action.type === 'dismiss') {
    if (typeof action.runId !== 'string' || !state.runs.has(action.runId)) return state;
    const runs = new Map(state.runs);
    runs.delete(action.runId);
    return { ...state, runs: orderAndBound(runs) };
  }

  return state;
}
