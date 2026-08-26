// Codex-specific argv construction and JSONL normalization. Only explicit,
// bounded allowlisted fields can cross this module's output boundary.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];

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

function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function boundedScalar(value, max) {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function safeName(value) {
  const source = boundedString(value, 80);
  const sanitized = source.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function validUsageNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(value) {
  const out = {};
  for (const key of USAGE_KEYS) out[key] = validUsageNumber(ownValue(value, key));
  return out;
}

function hookFreeClone(value, seen = new WeakMap()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;

  if (Array.isArray(value)) {
    const out = [];
    Object.setPrototypeOf(out, null);
    seen.set(value, out);
    for (let index = 0; index < value.length; index += 1) {
      const cloned = hookFreeClone(ownValue(value, String(index)), seen);
      out[index] = cloned === undefined ? null : cloned;
    }
    return out;
  }

  const out = Object.create(null);
  seen.set(value, out);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return out;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    const cloned = hookFreeClone(descriptor.value, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

function stringifySummary(value) {
  try {
    const serialized = JSON.stringify(hookFreeClone(value));
    return typeof serialized === 'string' ? serialized : '{}';
  } catch {
    return '{}';
  }
}

function fixedFailure(errorCode) {
  return {
    type: 'fail',
    ok: false,
    result: errorCode === 'authentication-required'
      ? 'Codex authentication failed'
      : 'Codex run failed',
    usage: null,
    costUsd: null,
    errorCode,
  };
}

function errorText(message) {
  const direct = ownString(message, 'message') || '';
  const error = ownValue(message, 'error');
  const nested = typeof error === 'string' ? error : (ownString(error, 'message') || '');
  return `${direct}\n${nested}`.slice(0, 2000);
}

function isAuthenticationError(message) {
  return /(?:authentication|authorization|\bauth\b|login|log in|401|unauthorized|invalid[_ ]refresh[_ ]token|credentials?)/i
    .test(errorText(message));
}

function itemAction(item, state) {
  const itemType = ownString(item, 'type');
  if (itemType === 'agent_message') {
    const text = boundedString(ownValue(item, 'text'), 200_000);
    if (!text) return [];
    state.lastAgentMessage = text;
    return [{ type: 'delta', text }];
  }

  if (itemType === 'command_execution') {
    const command = boundedString(ownValue(item, 'command'), 300);
    const status = boundedScalar(ownValue(item, 'status'), 80);
    const exitValue = ownValue(item, 'exit_code');
    const exitCode = Number.isSafeInteger(exitValue) ? exitValue : null;
    return [{
      type: 'tool',
      toolName: 'Command',
      input: stringifySummary({ command, status, exitCode }),
    }];
  }

  if (itemType === 'file_change') {
    const source = ownValue(item, 'changes');
    const changes = [];
    if (Array.isArray(source)) {
      for (let index = 0; index < Math.min(source.length, 20); index += 1) {
        const change = ownValue(source, String(index));
        changes.push({
          path: boundedString(ownValue(change, 'path'), 240),
          kind: boundedScalar(ownValue(change, 'kind'), 80),
        });
      }
    }
    return [{
      type: 'tool',
      toolName: 'File change',
      input: stringifySummary({ changes }),
    }];
  }

  if (itemType === 'mcp_tool_call') {
    const server = safeName(ownValue(item, 'server'));
    const tool = safeName(ownValue(item, 'tool'));
    const status = boundedScalar(ownValue(item, 'status'), 80);
    return [{
      type: 'tool',
      toolName: `MCP:${server}/${tool}`,
      input: stringifySummary({ status }),
    }];
  }

  if (itemType === 'web_search') {
    return [{
      type: 'tool',
      toolName: 'Web search',
      input: stringifySummary({ query: boundedString(ownValue(item, 'query'), 200) }),
    }];
  }

  if (itemType === 'plan') {
    const source = ownValue(item, 'steps');
    const steps = [];
    if (Array.isArray(source)) {
      for (let index = 0; index < Math.min(source.length, 20); index += 1) {
        const step = ownValue(source, String(index));
        steps.push({
          step: boundedString(ownValue(step, 'step'), 200),
          status: boundedScalar(ownValue(step, 'status'), 40),
        });
      }
    }
    return [{ type: 'tool', toolName: 'Plan', input: stringifySummary({ steps }) }];
  }

  return [];
}

/** Build Codex argv. Prompts are always provided on stdin by the runner. */
export function buildCodexArgs({
  model = null,
  effort = null,
  resumeSessionId = null,
  skipGitRepoCheck = false,
} = {}) {
  const args = ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', 'exec'];
  if (resumeSessionId != null) {
    if (typeof resumeSessionId !== 'string' || !UUID.test(resumeSessionId)) {
      throw new Error('resumeSessionId must be a valid Codex session UUID');
    }
    args.push('resume', '--json', resumeSessionId, '-');
    return args;
  }
  args.push('--json', '--color', 'never');
  if (model != null) {
    if (typeof model !== 'string' || !MODEL.test(model)) throw new Error('invalid Codex model');
    args.push('--model', model);
  }
  if (effort != null) {
    if (typeof effort !== 'string' || !EFFORTS.has(effort)) throw new Error('invalid Codex effort');
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  if (skipGitRepoCheck === true) args.push('--skip-git-repo-check');
  args.push('-');
  return args;
}

export function createCodexEventState() {
  return { sessionId: null, lastAgentMessage: '' };
}

/** Translate one parsed Codex JSONL event into a closed action allowlist. */
export function normalizeCodexEvent(message, state = createCodexEventState()) {
  if (!message || typeof message !== 'object') return [];
  const type = ownString(message, 'type');
  if (type === 'thread.started') {
    const sessionId = ownString(message, 'thread_id');
    if (!sessionId || !UUID.test(sessionId)) return [];
    state.sessionId = sessionId;
    return [{ type: 'session', sessionId }];
  }
  if (type === 'item.completed') return itemAction(ownValue(message, 'item'), state);
  if (type === 'turn.completed') {
    return [{
      type: 'complete',
      ok: true,
      result: state.lastAgentMessage,
      usage: normalizeUsage(ownValue(message, 'usage')),
      costUsd: null,
    }];
  }
  if (type === 'turn.failed') return [fixedFailure('run-failed')];
  if (type === 'error') {
    return [fixedFailure(isAuthenticationError(message) ? 'authentication-required' : 'run-failed')];
  }
  return [];
}
