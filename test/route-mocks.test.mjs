import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePageState, describeRouteHits, resolveRouteMocks } from '../dist/tools/shared.js';

test('resolveRouteMocks turns mocks into fulfil, abort and delay specs', () => {
  const [json, error, abort, slow] = resolveRouteMocks([
    { url: '**/api/cart', json: { items: [] } },
    { url: '**/api/pay', method: 'post', status: 500, body: 'boom' },
    { url: '**/analytics/**', abort: true },
    { url: '**/api/search*', delayMs: 2_000 },
  ]);
  assert.deepEqual(json, { url: '**/api/cart', label: '**/api/cart → 200 JSON', method: undefined, status: 200, body: '{"items":[]}', contentType: 'application/json', headers: undefined, abort: undefined, delayMs: undefined });
  assert.equal(error.method, 'POST');
  assert.equal(error.label, 'POST **/api/pay → 500');
  assert.equal(abort.abort, true);
  assert.equal(abort.status, undefined);
  assert.equal(slow.status, undefined, 'a delay alone passes the real request through');
  assert.equal(slow.label, '**/api/search* passed through after 2000ms');
});

test('resolveRouteMocks rejects contradictory or unsafe mocks', () => {
  assert.throws(() => resolveRouteMocks([{ url: '**', json: {}, body: 'x' }]), /json or body, not both/);
  assert.throws(() => resolveRouteMocks([{ url: '**', abort: true, status: 500 }]), /abort cannot be combined/);
  assert.throws(() => resolveRouteMocks([{ url: '**', method: 'GET /x' }]), /not an HTTP method/);
  assert.throws(() => resolveRouteMocks([{ url: '**', status: 200, headers: { 'x-a': 'one\r\nset-cookie: a=b' } }]), /Invalid/);
  assert.throws(() => resolveRouteMocks([{ url: '**', json: 'x'.repeat(200_001) }]), /under 200000 characters/);
});

test('describeRouteHits flags mocks that never matched', () => {
  const state = { routes: resolveRouteMocks([{ url: '**/api/cart', status: 500 }, { url: '**/api/nope', abort: true }]) };
  assert.match(describePageState(state, '/root'), /2 mocked route\(s\)/);
  const lines = describeRouteHits(state, [2, 0]);
  assert.equal(lines[0], '- `**/api/cart → 500`: matched 2 requests');
  assert.match(lines[1], /^- ⚠️ `\*\*\/api\/nope aborted`: matched \*\*no\*\* request/);
  assert.deepEqual(describeRouteHits({}, undefined), []);
});
