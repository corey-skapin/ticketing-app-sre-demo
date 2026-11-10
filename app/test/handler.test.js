'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHandler } = require('../handler');
const builtInRelease = require('../release');

const release = { version: '9.8.7', sha: 'abc1234' };

function fixture(options = {}) {
  const requests = [];
  const reservations = [];
  const telemetry = { trackRequest: (data) => requests.push(data) };
  const handler = createHandler({
    telemetry,
    release,
    reserveTickets: async () => { reservations.push('reserved'); },
    ...options,
  });
  return { handler, requests, reservations, telemetry };
}

async function invoke(handler, method = 'POST', url = '/checkout', request = {}) {
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = String(body); },
  };
  await handler({ method, url, resume() {}, ...request }, response);
  return response;
}

test('checkout reserves tickets, reports a simulated success and tracks one request', async () => {
  const f = fixture();
  const response = await invoke(f.handler);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(response.body), {
    success: true, simulated: true,
    message: 'Simulated checkout succeeded; no purchase was made.',
  });
  assert.equal(f.reservations.length, 1);
  assert.equal(f.requests.length, 1);
  const [request] = f.requests;
  assert.equal(request.name, 'POST /checkout');
  assert.equal(request.url, 'http://localhost/checkout');
  assert.equal(request.success, true);
  assert.equal(request.resultCode, '200');
  assert.ok(request.duration >= 0);
  assert.deepEqual(request.properties, {
    simulated: 'true', outcome: 'reserved', 'http.method': 'POST',
    releaseSha: 'abc1234', appVersion: '9.8.7',
  });
});

test('the built-in reservation succeeds without any configuration', async () => {
  const response = await invoke(createHandler());
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).success, true);
});

test('telemetry never receives request data', async () => {
  const f = fixture();
  const secret = 'checkout-secret-never-export';
  await invoke(f.handler, 'POST', `/checkout?token=${secret}`, {
    headers: { host: `${secret}.example.test`, authorization: `Bearer ${secret}` },
  });
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.stringify(f.requests).includes(secret), false);
});

test('request bodies are drained and never read', async () => {
  const f = fixture();
  let drained = 0;
  const resume = () => { drained += 1; };
  await invoke(f.handler, 'POST', '/checkout', { resume });
  await invoke(f.handler, 'GET', '/healthz', { resume });
  await invoke(f.handler, 'GET', '/missing', { resume });
  assert.equal(drained, 3);
});

test('health reports the running version and release', async () => {
  const f = fixture();
  const response = await invoke(f.handler, 'GET', '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    status: 'healthy', version: '9.8.7', release: 'abc1234',
  });
  assert.equal(f.reservations.length, 0);
  assert.equal(f.requests.length, 0);
});

test('every response carries the release headers, including 404 and 405', async () => {
  const f = fixture();
  for (const [method, path, status] of [
    ['GET', '/', 200], ['GET', '/app.js', 200], ['GET', '/styles.css', 200],
    ['GET', '/healthz', 200], ['POST', '/checkout', 200],
    ['GET', '/missing', 404], ['POST', '/healthz', 405], ['GET', '/checkout', 405],
  ]) {
    const response = await invoke(f.handler, method, path);
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers['X-Release-Sha'], 'abc1234', `${method} ${path}`);
    assert.equal(response.headers['X-App-Version'], '9.8.7', `${method} ${path}`);
  }
});

test('the release defaults to the one built into the app', async () => {
  const response = await invoke(createHandler(), 'GET', '/healthz');
  assert.deepEqual(JSON.parse(response.body), {
    status: 'healthy', version: builtInRelease.version, release: builtInRelease.sha,
  });
  assert.equal(response.headers['X-Release-Sha'], builtInRelease.sha);
  assert.equal(response.headers['X-App-Version'], builtInRelease.version);
});

test('telemetry errors do not change checkout responses', async () => {
  const f = fixture();
  f.telemetry.trackRequest = () => { throw new Error('telemetry-unavailable'); };
  const response = await invoke(f.handler);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).success, true);
  assert.equal(response.body.includes('telemetry-unavailable'), false);
});

test('checkout works without telemetry', async () => {
  const f = fixture({ telemetry: undefined });
  assert.equal((await invoke(f.handler)).status, 200);
});

test('static assets are served from the public folder with their content types', async () => {
  const f = fixture();
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  for (const [path, [file, type]] of Object.entries(assets)) {
    const response = await invoke(f.handler, 'GET', path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], type);
    assert.equal(response.body, readFileSync(join(__dirname, '..', 'public', file), 'utf8'));
  }
});

test('security headers are set on every response', async () => {
  const f = fixture();
  for (const [method, path] of [['GET', '/'], ['GET', '/healthz'], ['POST', '/checkout'],
    ['GET', '/missing'], ['PUT', '/checkout']]) {
    const response = await invoke(f.handler, method, path);
    assert.equal(response.headers['Cache-Control'], 'no-store', `${method} ${path}`);
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff', `${method} ${path}`);
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer', `${method} ${path}`);
    assert.match(response.headers['Content-Security-Policy'], /^default-src 'none'; script-src 'self'; /);
  }
});

test('only allowlisted paths and methods are served, including traversal rejection', async () => {
  const f = fixture();
  for (const path of ['/', '/app.js', '/styles.css', '/healthz']) {
    const get = await invoke(f.handler, 'GET', path);
    assert.equal(get.status, 200);
    assert.equal(get.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(get.headers['Content-Security-Policy'], /img-src https:\/\/images\.unsplash\.com/);
    const post = await invoke(f.handler, 'POST', path);
    assert.equal(post.status, 405);
    assert.equal(post.headers.Allow, 'GET');
  }
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await invoke(f.handler, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.Allow, 'POST');
  }
  for (const path of ['/admin', '/package.json', '/server.js', '/.env', '/../server.js', '/%2e%2e/server.js', '//healthz', '/checkout/', '/public/app.js']) {
    assert.equal((await invoke(f.handler, 'GET', path)).status, 404);
  }
  assert.equal(f.reservations.length, 0);
  assert.equal(f.requests.length, 0);
});
