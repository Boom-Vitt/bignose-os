// Claude-specific argv construction and stream event interpretation.
// Process lifecycle, redaction, transcript storage, and SSE publication remain
// owned by runner.js.

function ownValue(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(object, key) {
  const value = ownValue(object, key);
  return typeof value === 'string' ? value : null;
}

function cloneJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value !== 'object' || depth > 20 || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = [];
    Object.setPrototypeOf(out, null);
    for (let index = 0; index < value.length; index += 1) {
      const cloned = cloneJsonValue(ownValue(value, String(index)), seen, depth + 1);
      out[index] = cloned === undefined ? null : cloned;
    }
    return out;
  }
  const out = Object.create(null);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    const cloned = cloneJsonValue(descriptor.value, seen, depth + 1);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

function stringifyToolInput(value) {
  try {
    const json = JSON.stringify(cloneJsonValue(value));
    return typeof json === 'string' ? json : 'null';
  } catch {
    return '"[unserializable input]"';
  }
}

function looksLikeAuthenticationFailure(value) {
  return /(?:auth(?:entication|orization)?|login|log in|api key|401|unauthorized|invalid refresh token)/i
    .test(String(value ?? '').slice(0, 2000));
}

/** Build the exact bounded argv for the Claude CLI. The prompt uses stdin. */
export function buildClaudeArgs({ runId, model, effort } = {}) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', String(runId ?? ''),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Bash',
    '--max-budget-usd', '5',
  ];
  if (typeof model === 'string' && model) args.push('--model', model);
  if (typeof effort === 'string' && effort) args.push('--effort', effort);
  return args;
}

export function createClaudeEventState() {
  return { sessionId: null };
}

/** Translate one parsed Claude stream-json message into bounded action kinds. */
export function normalizeClaudeEvent(message, state = createClaudeEventState()) {
  if (!message || typeof message !== 'object') return [];
  const actions = [];
  const type = ownString(message, 'type');
  const subtype = ownString(message, 'subtype');
  const sessionId = ownString(message, 'session_id');
  if (sessionId) {
    const isInit = type === 'system' && subtype === 'init';
    if (!state.sessionId || isInit) {
      state.sessionId = sessionId;
      actions.push({ type: 'session', sessionId });
    }
  }

  if (type === 'assistant') {
    const assistantMessage = ownValue(message, 'message');
    const content = ownValue(assistantMessage, 'content');
    if (!Array.isArray(content)) return actions;
    for (let index = 0; index < content.length; index += 1) {
      const block = ownValue(content, String(index));
      const blockType = ownString(block, 'type');
      if (blockType === 'text') {
        const text = ownString(block, 'text');
        if (text) actions.push({ type: 'delta', text });
      } else if (blockType === 'tool_use') {
        const name = ownString(block, 'name');
        actions.push({
          type: 'tool',
          toolName: name || 'unknown',
          input: stringifyToolInput(ownValue(block, 'input') ?? null),
        });
      }
    }
    return actions;
  }

  if (type !== 'result') return actions;
  const isError = ownValue(message, 'is_error');
  const ok = typeof isError === 'boolean' ? !isError : subtype === 'success';
  const result = ownString(message, 'result') || '';
  const usage = ownValue(message, 'usage') ?? null;
  const totalCost = ownValue(message, 'total_cost_usd');
  const base = {
    type: ok ? 'complete' : 'fail',
    ok,
    result,
    usage,
    costUsd: typeof totalCost === 'number' && Number.isFinite(totalCost) ? totalCost : null,
  };
  if (!ok) {
    base.errorCode = looksLikeAuthenticationFailure(result)
      ? 'authentication-required'
      : 'run-failed';
  }
  actions.push(base);
  return actions;
}
