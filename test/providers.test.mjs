import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  isDeniedCodexRelativePath, normalizeProvider, skillIdentity, resolveCodexBin,
  validateSkillPatch, readSkillOverride,
} from '../server/lib/providers.js';

test('provider defaults to Claude and rejects unknown values', () => {
  assert.equal(normalizeProvider(undefined), 'claude');
  assert.equal(normalizeProvider('CODEX'), 'codex');
  assert.throws(() => normalizeProvider('auto'), /provider must be claude or codex/);
});

test('Codex binary resolution honors an explicit invalid override without fallback', () => {
  const executable = path.join(path.sep, 'tools', 'codex');
  const isExecutable = (candidate) => candidate === executable;
  assert.equal(resolveCodexBin({
    override: path.join(path.sep, 'missing', 'codex'),
    pathValue: path.dirname(executable), isExecutable,
  }), null);
  assert.equal(resolveCodexBin({
    override: '', pathValue: path.dirname(executable), isExecutable,
  }), executable);
});

test('Codex denylist applies to a forbidden segment at any depth', () => {
  assert.equal(isDeniedCodexRelativePath('.system/review/SKILL.md'), false);
  for (const relative of [
    'review/sessions/deep/event.jsonl',
    'review/private/auth.json',
    'review/nested/credentials/credential.json',
    'review/nested/secrets.json',
    'review/nested/tokens.json',
    'morning/archive/history.jsonl',
    'morning/archive/histories/run.jsonl',
    'morning/archive/transcripts/run.jsonl',
    'notes/deep/state_5.sqlite-wal',
    'rules/safe/worktrees/escape.md',
    'rules/deep/browser/state.json',
    'skills/review/computer-use/state.json',
    'memories/note/generated_images/frame.png',
    'automations/morning/process_manager/state.json',
    'rules/deep/shell_snapshots/snapshot.txt',
    'memories/note/log/latest.txt',
    'skills/review/vendor_imports/module.md',
  ]) assert.equal(isDeniedCodexRelativePath(relative), true, relative);
});

test('provider-specific skill settings are deterministic', () => {
  assert.equal(skillIdentity('codex', 'review'), 'codex:review');
  assert.deepEqual(validateSkillPatch('claude', { model: 'opus', effort: 'max' }), {
    model: 'opus', effort: 'max',
  });
  assert.deepEqual(validateSkillPatch('codex', { model: 'gpt-5.6-sol', effort: 'xhigh' }), {
    model: 'gpt-5.6-sol', effort: 'xhigh',
  });
  assert.throws(() => validateSkillPatch('codex', { model: 'bad model;rm', effort: 'high' }), /invalid model/);
  assert.throws(() => validateSkillPatch('codex', { effort: 'max' }), /invalid effort/);
});

test('Claude reads legacy sidecar keys and Codex never does', () => {
  const store = {
    review: { model: 'opus', effort: 'high' },
    'codex:review': { model: 'gpt-5.6-sol', effort: 'xhigh' },
  };
  assert.equal(readSkillOverride(store, 'claude', 'review').model, 'opus');
  assert.equal(readSkillOverride(store, 'codex', 'review').model, 'gpt-5.6-sol');
  assert.equal(readSkillOverride({ review: store.review }, 'codex', 'review'), null);
});
