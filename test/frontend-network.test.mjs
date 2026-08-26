import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchLocalApi,
  isLocalApiPath,
} from '../public/js/local-api.js';
import { EVENTS_ENDPOINT } from '../public/js/sse.js';

test('frontend transport accepts relative local API paths and rejects external URLs before fetch', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  };

  for (const path of [
    'https://api.example.invalid/data',
    'http://127.0.0.1:9999/api/catalog',
    '//example.invalid/api/catalog',
    'data:text/plain,private',
    '/outside-api',
    '/api/../outside-api',
    '/api/%2e%2e/outside-api',
  ]) {
    assert.equal(isLocalApiPath(path), false);
    await assert.rejects(fetchLocalApi(path, {}, fetchImpl), /relative local API path required/);
  }
  assert.equal(calls.length, 0);

  const response = await fetchLocalApi('/api/catalog?provider=codex', {
    headers: { accept: 'application/json' },
  }, fetchImpl);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{
    path: '/api/catalog?provider=codex',
    options: { headers: { accept: 'application/json' } },
  }]);
});

test('normal EventSource endpoint is same-origin relative', () => {
  assert.equal(EVENTS_ENDPOINT, '/api/events');
  assert.equal(isLocalApiPath(EVENTS_ENDPOINT), true);
});
