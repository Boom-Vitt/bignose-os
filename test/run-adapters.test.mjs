import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeArgs,
  createClaudeEventState,
  normalizeClaudeEvent,
} from '../server/lib/run-adapters/claude.js';
import {
  buildCodexArgs,
  createCodexEventState,
  normalizeCodexEvent,
} from '../server/lib/run-adapters/codex.js';

const UUID = 'a4f1ae04-849a-4db5-aa49-4e1de96cac8';
const RESUME_UUID = '11111111-1111-4111-8111-111111111111';
const UUID_V7 = '019c9a3e-1234-7abc-8def-123456789abc';

test('Claude argv remains the exact bounded accept-edits invocation', () => {
  assert.deepEqual(buildClaudeArgs({ runId: UUID, model: 'opus', effort: 'high' }), [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--session-id', UUID,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Bash',
    '--max-budget-usd', '5',
    '--model', 'opus', '--effort', 'high',
  ]);
});

test('Codex new run uses JSONL, stdin, workspace-write, and no bypass', () => {
  const args = buildCodexArgs({
    model: 'gpt-5.6-sol', effort: 'high', resumeSessionId: null,
    skipGitRepoCheck: true,
  });
  assert.deepEqual(args, [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    'exec', '--json', '--color', 'never',
    '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high',
    '--skip-git-repo-check', '-',
  ]);
  assert.equal(args.some((arg) => /yolo|dangerously-bypass|danger-full-access/.test(arg)), false);
});

test('Codex resume uses the captured UUID as data, then stdin', () => {
  assert.deepEqual(buildCodexArgs({ resumeSessionId: RESUME_UUID, skipGitRepoCheck: false }), [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    'exec', 'resume', '--json', RESUME_UUID, '-',
  ]);
});

test('Codex accepts canonical UUIDv7 sessions and rejects noncanonical or unsupported IDs', () => {
  assert.deepEqual(buildCodexArgs({ resumeSessionId: UUID_V7 }), [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    'exec', 'resume', '--json', UUID_V7, '-',
  ]);
  assert.deepEqual(normalizeCodexEvent(
    { type: 'thread.started', thread_id: UUID_V7 },
    createCodexEventState(),
  ), [{ type: 'session', sessionId: UUID_V7 }]);

  for (const invalid of [
    '019c9a3e-1234-0abc-8def-123456789abc',
    '019c9a3e-1234-9abc-8def-123456789abc',
    '019c9a3e12347abc8def123456789abc',
    '019c9a3e-1234-7abc-7def-123456789abc',
    '--last',
  ]) {
    assert.throws(() => buildCodexArgs({ resumeSessionId: invalid }), /valid Codex session UUID/);
    assert.deepEqual(normalizeCodexEvent(
      { type: 'thread.started', thread_id: invalid },
      createCodexEventState(),
    ), []);
  }
});

test('Claude normalizer preserves session, assistant, tool, and result behavior', () => {
  const state = createClaudeEventState();
  assert.deepEqual(normalizeClaudeEvent({
    type: 'system', subtype: 'init', session_id: UUID,
  }, state), [{ type: 'session', sessionId: UUID }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a' } },
    ] },
  }, state), [
    { type: 'delta', text: 'hello' },
    { type: 'tool', toolName: 'Read', input: '{"file_path":"/tmp/a"}' },
  ]);
  assert.deepEqual(normalizeClaudeEvent({
    type: 'result', subtype: 'success', is_error: false,
    result: 'done', usage: { input_tokens: 7 }, total_cost_usd: 0.25,
  }, state), [{
    type: 'complete', ok: true, result: 'done',
    usage: { input_tokens: 7 }, costUsd: 0.25,
  }]);
});

test('Claude tool normalization ignores accessors and executable serializer hooks', () => {
  let getterCalls = 0;
  let serializerCalls = 0;
  const input = Object.create({
    toJSON() {
      serializerCalls += 1;
      return 'forbidden-inherited-serializer';
    },
  });
  Object.defineProperties(input, {
    safe: { enumerable: true, value: 'kept' },
    getter: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'forbidden-getter';
      },
    },
    toJSON: {
      enumerable: true,
      value() {
        serializerCalls += 1;
        return 'forbidden-own-serializer';
      },
    },
  });
  const actions = normalizeClaudeEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input }] },
  }, createClaudeEventState());
  assert.equal(getterCalls, 0);
  assert.equal(serializerCalls, 0);
  assert.deepEqual(actions, [{ type: 'tool', toolName: 'Read', input: '{"safe":"kept"}' }]);
});

test('Claude root and nested array tool inputs never invoke inherited array serializer hooks', () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let hookCalls = 0;
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() {
      hookCalls += 1;
      throw new Error('forbidden inherited array serializer');
    },
  });

  const deepest = Object.freeze(['two']);
  const nestedObject = Object.freeze({ deep: deepest });
  const innerArray = Object.freeze(['one', nestedObject]);
  const rootArray = Object.freeze([{ items: innerArray }, ['leaf']]);
  const nestedArray = Object.freeze([{ value: 'kept' }, ['nested-leaf']]);
  const nestedInput = Object.freeze({ rows: nestedArray, safe: 'yes' });

  try {
    const rootActions = normalizeClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'RootArray', input: rootArray }] },
    }, createClaudeEventState());
    const nestedActions = normalizeClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'NestedArray', input: nestedInput }] },
    }, createClaudeEventState());

    assert.equal(hookCalls, 0);
    assert.equal(
      rootActions[0].input,
      '[{"items":["one",{"deep":["two"]}]},["leaf"]]',
    );
    assert.equal(
      nestedActions[0].input,
      '{"rows":[{"value":"kept"},["nested-leaf"]],"safe":"yes"}',
    );
    assert.strictEqual(rootArray[0].items, innerArray);
    assert.strictEqual(innerArray[1], nestedObject);
    assert.strictEqual(nestedObject.deep, deepest);
    assert.strictEqual(nestedInput.rows, nestedArray);
    assert.equal(rootArray.length, 2);
    assert.equal(nestedArray.length, 2);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous);
    else delete Array.prototype.toJSON;
  }
});

test('normalizes Codex session, message, tools, and usage deterministically', () => {
  const state = createCodexEventState();
  assert.deepEqual(normalizeCodexEvent({ type: 'thread.started', thread_id: RESUME_UUID }, state), [
    { type: 'session', sessionId: RESUME_UUID },
  ]);
  assert.deepEqual(normalizeCodexEvent({ type: 'turn.started' }, state), []);
  assert.deepEqual(normalizeCodexEvent({ type: 'item.completed', item: {
    id: 'item_1', type: 'agent_message', text: 'done', raw: 'forbidden-message-raw',
  } }, state), [{ type: 'delta', text: 'done' }]);
  assert.deepEqual(normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'command_execution', command: 'printf ok', status: 'completed', exit_code: 0,
    aggregated_output: 'must not escape', stderr: 'forbidden-command-stderr',
  } }, state), [{
    type: 'tool', toolName: 'Command',
    input: JSON.stringify({ command: 'printf ok', status: 'completed', exitCode: 0 }),
  }]);
  const action = normalizeCodexEvent({ type: 'turn.completed', usage: {
    input_tokens: 10, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2,
    cache_write_input_tokens: 999, forbidden_usage: 'must not escape',
  } }, state);
  assert.deepEqual(action, [{ type: 'complete', ok: true, result: 'done', usage: {
    input_tokens: 10, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2,
  }, costUsd: null }]);
  assert.equal(JSON.stringify(action).includes('cache_write_input_tokens'), false);
  assert.equal(JSON.stringify(action).includes('forbidden_usage'), false);
});

test('Codex file changes retain at most twenty bounded path-kind pairs and no diff', () => {
  const state = createCodexEventState();
  const changes = Array.from({ length: 25 }, (_, index) => ({
    path: `/Users/private/${index}-${'x'.repeat(300)}`,
    kind: `update-${'y'.repeat(100)}`,
    diff: `forbidden-diff-${index}`,
  }));
  const actions = normalizeCodexEvent({
    type: 'item.completed', item: { type: 'file_change', changes, diff: 'top-level-diff' },
  }, state);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'File change');
  const input = JSON.parse(actions[0].input);
  assert.equal(input.changes.length, 20);
  assert.deepEqual(Object.keys(input.changes[0]), ['path', 'kind']);
  assert.ok(input.changes.every(({ path, kind }) => path.length <= 240 && kind.length <= 80));
  assert.equal(JSON.stringify(actions).includes('forbidden-diff'), false);
});

test('Codex MCP calls retain a sanitized name and status only', () => {
  const actions = normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'docs/private', tool: 'lookup secret', status: 'completed',
    arguments: { token: 'forbidden-mcp-argument' }, result: 'forbidden-mcp-result',
  } }, createCodexEventState());
  assert.deepEqual(actions, [{
    type: 'tool', toolName: 'MCP:docs-private/lookup-secret',
    input: JSON.stringify({ status: 'completed' }),
  }]);
  assert.equal(JSON.stringify(actions).includes('forbidden-mcp'), false);
});

test('Codex web search retains only a query capped at two hundred characters', () => {
  const query = `safe-${'q'.repeat(250)}`;
  const actions = normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'web_search', query, results: ['forbidden-search-result'],
  } }, createCodexEventState());
  assert.equal(actions[0].toolName, 'Web search');
  const input = JSON.parse(actions[0].input);
  assert.equal(input.query, query.slice(0, 200));
  assert.equal(JSON.stringify(actions).includes('forbidden-search-result'), false);
});

test('Codex plans retain only bounded step and status pairs', () => {
  const steps = Array.from({ length: 25 }, (_, index) => ({
    step: `Step ${index} ${'s'.repeat(250)}`,
    status: `pending-${'t'.repeat(100)}`,
    notes: `forbidden-plan-note-${index}`,
  }));
  const actions = normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'plan', steps, explanation: 'forbidden-plan-explanation',
  } }, createCodexEventState());
  assert.equal(actions[0].toolName, 'Plan');
  const input = JSON.parse(actions[0].input);
  assert.equal(input.steps.length, 20);
  assert.deepEqual(Object.keys(input.steps[0]), ['step', 'status']);
  assert.ok(input.steps.every(({ step, status }) => step.length <= 200 && status.length <= 40));
  assert.equal(JSON.stringify(actions).includes('forbidden-plan'), false);
});

test('Codex tool summaries never invoke inherited object or array serializer hooks', () => {
  const previousObject = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const previousArray = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let objectHookCalls = 0;
  let arrayHookCalls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() {
      objectHookCalls += 1;
      return this;
    },
  });
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() {
      arrayHookCalls += 1;
      return this;
    },
  });

  try {
    const state = createCodexEventState();
    const command = normalizeCodexEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'printf ok', status: 'completed', exit_code: 0,
    } }, state);
    const files = normalizeCodexEvent({ type: 'item.completed', item: {
      type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }],
    } }, state);
    const mcp = normalizeCodexEvent({ type: 'item.completed', item: {
      type: 'mcp_tool_call', server: 'docs', tool: 'lookup', status: 'completed',
    } }, state);
    const search = normalizeCodexEvent({ type: 'item.completed', item: {
      type: 'web_search', query: 'safe query',
    } }, state);
    const plan = normalizeCodexEvent({ type: 'item.completed', item: {
      type: 'plan', steps: [{ step: 'Do it', status: 'pending' }],
    } }, state);

    assert.equal(objectHookCalls, 0);
    assert.equal(arrayHookCalls, 0);
    assert.equal(command[0].input, '{"command":"printf ok","status":"completed","exitCode":0}');
    assert.equal(files[0].input, '{"changes":[{"path":"a.js","kind":"update"}]}');
    assert.equal(mcp[0].input, '{"status":"completed"}');
    assert.equal(search[0].input, '{"query":"safe query"}');
    assert.equal(plan[0].input, '{"steps":[{"step":"Do it","status":"pending"}]}');
  } finally {
    if (previousArray) Object.defineProperty(Array.prototype, 'toJSON', previousArray);
    else delete Array.prototype.toJSON;
    if (previousObject) Object.defineProperty(Object.prototype, 'toJSON', previousObject);
    else delete Object.prototype.toJSON;
  }
});

test('Codex reasoning, unknown item types, unknown events, and turn start emit nothing', () => {
  const state = createCodexEventState();
  assert.deepEqual(normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'reasoning', text: 'forbidden-reasoning',
  } }, state), []);
  assert.deepEqual(normalizeCodexEvent({ type: 'item.completed', item: {
    type: 'future_item', raw: 'forbidden-future-raw',
  } }, state), []);
  assert.deepEqual(normalizeCodexEvent({ type: 'future.event', raw: 'forbidden-event-raw' }, state), []);
  assert.deepEqual(normalizeCodexEvent({ type: 'turn.started', raw: 'forbidden-turn-raw' }, state), []);
});

test('Codex failures use only fixed safe classifications', () => {
  const failed = normalizeCodexEvent({
    type: 'turn.failed', error: { message: 'raw private failure must not escape' },
  }, createCodexEventState());
  assert.deepEqual(failed, [{
    type: 'fail', ok: false, result: 'Codex run failed', usage: null,
    costUsd: null, errorCode: 'run-failed',
  }]);

  for (const error of [
    { type: 'error', message: 'Please run codex login; authentication required', detail: 'secret' },
    { type: 'error', error: { message: '401 unauthorized invalid refresh token', raw: 'secret' } },
  ]) {
    const actions = normalizeCodexEvent(error, createCodexEventState());
    assert.deepEqual(actions, [{
      type: 'fail', ok: false, result: 'Codex authentication failed', usage: null,
      costUsd: null, errorCode: 'authentication-required',
    }]);
    assert.equal(JSON.stringify(actions).includes('secret'), false);
  }

  assert.deepEqual(normalizeCodexEvent({
    type: 'error', message: 'other private detail', diagnostic: 'forbidden-error-diagnostic',
  }, createCodexEventState()), [{
    type: 'fail', ok: false, result: 'Codex run failed', usage: null,
    costUsd: null, errorCode: 'run-failed',
  }]);
});

test('Codex usage accepts only non-negative integer fields and maps all else to null', () => {
  const state = createCodexEventState();
  const actions = normalizeCodexEvent({ type: 'turn.completed', usage: {
    input_tokens: -1,
    cached_input_tokens: 1.5,
    output_tokens: '4',
    reasoning_output_tokens: 0,
    cache_write_input_tokens: 8,
  } }, state);
  assert.deepEqual(actions, [{
    type: 'complete', ok: true, result: '', usage: {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: 0,
    }, costUsd: null,
  }]);
  assert.deepEqual(Object.keys(actions[0].usage), [
    'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens',
  ]);
});
