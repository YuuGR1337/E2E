/**
 * The token-protected bridge must also work for clients that can only do
 * OAuth (claude.ai custom connectors). This walks the flow those clients run
 * against the real Node adapter: 401 with resource metadata, discovery,
 * dynamic registration, the authorize page (access key + PKCE), the token
 * exchange, an MCP call with the issued token, and a refresh.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createMcpHttpHandler, handleNodeRequest } from '../dist/http.js';
import { isAllowedRedirectUri } from '../dist/oauth.js';

const TOKEN = 'oauth-test-access-key';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [], mcpPath: '/mcp' });
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    void handleNodeRequest(handler, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await handler.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirectUris = [REDIRECT]) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris }),
  });
  return { res, body: await res.json() };
}

function authorizeParams(clientId, challenge, extra = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
}

async function signIn(clientId, challenge, accessKey = TOKEN) {
  const form = authorizeParams(clientId, challenge, { access_key: accessKey });
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
}

async function exchange(params) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { res, body: await res.json() };
}

async function listTools(accessToken) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function fullFlow() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const redirect = await signIn(client.client_id, challenge);
  const code = new URL(redirect.headers.get('location')).searchParams.get('code');
  const { body: tokens } = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  return { client, tokens };
}

test('an unauthenticated MCP call points the client at the resource metadata', async () => {
  const res = await listTools('');
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get('www-authenticate') ?? '',
    /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test('discovery documents name the endpoints', async () => {
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [base]);

  const bare = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(bare.resource, `${base}/mcp`);

  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, base);
  assert.equal(meta.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(meta.token_endpoint, `${base}/oauth/token`);
  assert.equal(meta.registration_endpoint, `${base}/oauth/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
});

test('the rewritten Vercel form of a route resolves the same way', async () => {
  const res = await fetch(`${base}/api/mcp?oauth_route=/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).token_endpoint, `${base}/oauth/token`);
});

test('registration accepts https and loopback redirects only', async () => {
  const ok = await register();
  assert.equal(ok.res.status, 201);
  assert.ok(ok.body.client_id);
  assert.deepEqual(ok.body.redirect_uris, [REDIRECT]);

  const bad = await register(['javascript:alert(1)']);
  assert.equal(bad.res.status, 400);
  assert.equal(isAllowedRedirectUri('http://evil.test/cb'), false);
  assert.equal(isAllowedRedirectUri('http://localhost:6274/oauth/callback'), true);
});

test('the authorize page asks for the access key and names the app', async () => {
  const { body: client } = await register();
  const res = await fetch(`${base}/oauth/authorize?${authorizeParams(client.client_id, pkce().challenge)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const html = await res.text();
  assert.match(html, /name="access_key"/);
  assert.match(html, /claude\.ai/);
  assert.doesNotMatch(html, new RegExp(TOKEN));
});

test('a wrong access key is refused without a redirect', async () => {
  const { body: client } = await register();
  const res = await signIn(client.client_id, pkce().challenge, 'not-the-key');
  assert.equal(res.status, 401);
  assert.match(await res.text(), /not right/);
});

test('an unregistered redirect is refused, never followed', async () => {
  const { body: client } = await register();
  const params = authorizeParams(client.client_id, pkce().challenge, { redirect_uri: 'https://evil.test/cb' });
  const res = await fetch(`${base}/oauth/authorize?${params}`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
});

test('PKCE is required', async () => {
  const { body: client } = await register();
  const params = authorizeParams(client.client_id, pkce().challenge, { code_challenge_method: 'plain' });
  const res = await fetch(`${base}/oauth/authorize?${params}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).searchParams.get('error'), 'invalid_request');
});

test('the full flow issues a token that unlocks every tool', async () => {
  const { tokens } = await fullFlow();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const res = await listTools(tokens.access_token);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /run-test/);
});

test('the redirect carries the state back', async () => {
  const { body: client } = await register();
  const res = await signIn(client.client_id, pkce().challenge);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'xyz');
  assert.ok(location.searchParams.get('code'));
});

test('a wrong code verifier or redirect is rejected at the token endpoint', async () => {
  const { body: client } = await register();
  const { challenge } = pkce();
  const redirect = await signIn(client.client_id, challenge);
  const code = new URL(redirect.headers.get('location')).searchParams.get('code');

  const wrongVerifier = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: pkce().verifier,
  });
  assert.equal(wrongVerifier.res.status, 400);
  assert.equal(wrongVerifier.body.error, 'invalid_grant');

  const { body: other } = await register();
  const wrongClient = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: other.client_id,
    code_verifier: pkce().verifier,
  });
  assert.equal(wrongClient.body.error, 'invalid_grant');
});

test('a refresh token yields a new working access token', async () => {
  const { client, tokens } = await fullFlow();
  const { res, body } = await exchange({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  });
  assert.equal(res.status, 200);
  assert.equal((await listTools(body.access_token)).status, 200);

  const misuse = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.access_token });
  assert.equal(misuse.body.error, 'invalid_grant');
});

test('tokens signed for another key are rejected', async () => {
  const other = createMcpHttpHandler({ token: 'a-different-access-key', allowedHosts: [], mcpPath: '/mcp' });
  try {
    const { tokens } = await fullFlow();
    const res = await other.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    assert.equal(res.status, 401);
  } finally {
    await other.close().catch(() => undefined);
  }
});

test('the static bearer token still works', async () => {
  assert.equal((await listTools(TOKEN)).status, 200);
});
