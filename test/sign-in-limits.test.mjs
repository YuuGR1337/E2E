/**
 * Guessing the bridge's token must be slow: wrong bearer tokens and wrong
 * access keys on the sign-in page are counted per client address, and past
 * the limit the client gets 429. A forged X-Real-IP must not reset the count
 * when no trusted proxy sits in front. PW_MCP_OAUTH_REDIRECT_HOSTS limits
 * which apps may register.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createMcpHttpHandler, handleNodeRequest } from '../dist/http.js';
import { isAllowedRedirectHost } from '../dist/oauth.js';
import { createAttemptLimiter } from '../dist/utils/attempt-limiter.js';

const TOKEN = 'limits-test-access-key-0123456789';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const servers = [];

async function serve(options) {
  const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [], mcpPath: '/mcp', ...options });
  const srv = http.createServer((req, res) => {
    void handleNodeRequest(handler, req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  servers.push({ srv, handler });
  return `http://127.0.0.1:${srv.address().port}`;
}

let bearerBase;
let keyBase;
let hostsBase;

before(async () => {
  bearerBase = await serve({ maxFailedAuth: 3 });
  keyBase = await serve({ maxFailedAuth: 2 });
  hostsBase = await serve({ redirectHosts: ['claude.ai', '.chatgpt.com'] });
});

after(async () => {
  for (const { srv, handler } of servers) {
    await handler.close().catch(() => undefined);
    await new Promise((resolve) => srv.close(resolve));
  }
});

function call(base, token, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function register(base, redirectUris = [REDIRECT]) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris }),
  });
  return { res, body: await res.json() };
}

function signIn(base, clientId, accessKey) {
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_key: accessKey,
  });
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
}

test('the limiter counts failures in a sliding window', () => {
  let clock = 1000;
  const limiter = createAttemptLimiter({ max: 2, windowSeconds: 60, now: () => clock });
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 0);
  clock += 10;
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 50);
  assert.equal(limiter.retryAfter('b'), 0, 'other clients are not affected');
  clock += 51;
  assert.equal(limiter.retryAfter('a'), 0, 'the oldest failure aged out');
});

test('a request with no credentials is not counted as a guess', async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call(bearerBase, '')).status, 401);
  }
  assert.equal((await call(bearerBase, TOKEN)).status, 200);
});

test('wrong bearer tokens lead to 429, even for the right token', async () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(bearerBase, `wrong-${i}`)).status, 401);
  }
  const limited = await call(bearerBase, TOKEN);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('a forged X-Real-IP does not reset the count without a trusted proxy', async () => {
  const res = await call(bearerBase, TOKEN, { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' });
  assert.equal(res.status, 429);
});

test('wrong access keys on the sign-in page lead to a 429 page', async () => {
  const { body: client } = await register(keyBase);
  assert.equal((await signIn(keyBase, client.client_id, 'nope-1')).status, 401);
  assert.equal((await signIn(keyBase, client.client_id, 'nope-2')).status, 401);
  const limited = await signIn(keyBase, client.client_id, TOKEN);
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /Too many attempts/);
});

test('redirect hosts limit which apps may register', async () => {
  assert.equal((await register(hostsBase)).res.status, 201);
  assert.equal((await register(hostsBase, ['https://app.chatgpt.com/cb'])).res.status, 201);
  assert.equal((await register(hostsBase, ['http://localhost:3000/cb'])).res.status, 201);
  const refused = await register(hostsBase, ['https://evil.example/cb']);
  assert.equal(refused.res.status, 400);
  assert.equal(refused.body.error, 'invalid_redirect_uri');
});

test('redirect host matching is exact or by subdomain suffix', () => {
  assert.equal(isAllowedRedirectHost('https://claude.ai/x', []), true);
  assert.equal(isAllowedRedirectHost('https://claude.ai/x', ['claude.ai']), true);
  assert.equal(isAllowedRedirectHost('https://evilclaude.ai/x', ['claude.ai']), false);
  assert.equal(isAllowedRedirectHost('https://a.chatgpt.com/x', ['.chatgpt.com']), true);
  assert.equal(isAllowedRedirectHost('https://chatgpt.com.evil.io/x', ['.chatgpt.com']), false);
});
