'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHandler } = require('../handler');
const builtInRelease = require('../release');

const release = { version: '9.8.7', sha: 'abc1234' };
const gatewayEnv = { PAYMENT_GATEWAY_URL: 'https://payments.example.test' };

function fixture(options = {}) {
  const requests = [];
  const exceptions = [];
  const reservations = [];
  const gatewayCalls = [];
  const steps = [];
  const telemetry = {
    trackRequest: (data) => requests.push(data),
    trackException: (data) => exceptions.push(data),
  };
  const handler = createHandler({
    telemetry,
    release,
    env: gatewayEnv,
    fetchImpl: async (url, init) => {
      steps.push('authorize');
      gatewayCalls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ authorized: true }) };
    },
    reserveTickets: async (reservation) => {
      steps.push('reserve');
      reservations.push(reservation);
    },
    ...options,
  });
  return { handler, requests, exceptions, reservations, gatewayCalls, steps, telemetry };
}

const reservationFailure = new Error('reservation backend rejected order for 203.0.113.7');
const failing = (error = reservationFailure) => ({ reserveTickets: async () => { throw error; } });

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
  const body = JSON.parse(response.body);
  assert.match(body.orderId, /^[0-9A-F]{8}$/);
  assert.deepEqual(body, {
    success: true, simulated: true, orderId: body.orderId,
    message: 'Simulated checkout succeeded; no purchase was made.',
  });
  assert.equal(f.reservations.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.exceptions.length, 0);
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

test('the built-in reservation succeeds once the payment is authorised', async () => {
  const f = fixture({ reserveTickets: undefined });
  const response = await invoke(f.handler);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).success, true);
});

test('checkout authorises the order with the payment gateway before reserving it', async () => {
  const f = fixture();
  const response = await invoke(f.handler);
  assert.equal(response.status, 200);
  const { orderId } = JSON.parse(response.body);
  assert.deepEqual(f.steps, ['authorize', 'reserve']);
  assert.deepEqual(f.gatewayCalls, [{
    url: 'https://payments.example.test/v1/authorize',
    method: 'POST',
    body: { orderId, amountCents: 16800 },
  }]);
  assert.deepEqual(f.reservations, [{ orderId }]);
});

test('a gateway failure returns a 500 without details and reserves nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const response = await invoke(f.handler);
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), {
    success: false, simulated: true,
    message: 'Simulated checkout failed. Please try again shortly.',
  });
  assert.equal(response.body.includes('503'), false);
  assert.equal(f.reservations.length, 0);
  assert.equal(f.exceptions.length, 1);
  assert.equal(f.exceptions[0].exception.message, 'Payment gateway returned 503');
  assert.equal(f.requests[0].resultCode, '500');
  assert.equal((await invoke(f.handler, 'GET', '/healthz')).status, 200);
});

test('a reservation returns the first eight characters of a random UUID, uppercased', async (t) => {
  t.mock.method(crypto, 'randomUUID', () => 'a1b2c3d4-test');
  const f = fixture();
  const response = await invoke(f.handler);
  assert.equal(JSON.parse(response.body).orderId, 'A1B2C3D4');
  assert.deepEqual(f.reservations, [{ orderId: 'A1B2C3D4' }]);
});

test('every reservation gets its own order reference', async () => {
  const f = fixture();
  const orderIds = new Set();
  for (let i = 0; i < 25; i += 1) {
    const { orderId } = JSON.parse((await invoke(f.handler)).body);
    assert.match(orderId, /^[0-9A-F]{8}$/);
    orderIds.add(orderId);
  }
  assert.equal(orderIds.size, 25);
});

test('a failed reservation returns a 500 without error details and health stays available', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const f = fixture(failing());
  const response = await invoke(f.handler, 'POST', '/checkout?token=never-export');
  assert.equal(response.status, 500);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(response.body), {
    success: false, simulated: true,
    message: 'Simulated checkout failed. Please try again shortly.',
  });
  assert.equal(response.body.includes('203.0.113.7'), false);
  assert.equal(response.headers['X-Release-Sha'], 'abc1234');
  assert.equal(response.headers['X-App-Version'], '9.8.7');
  assert.equal((await invoke(f.handler, 'GET', '/healthz')).status, 200);
  assert.equal(logged.mock.callCount(), 1);
});

test('a failed reservation is tracked as an exception carrying the release', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(failing());
  await invoke(f.handler);
  assert.equal(f.exceptions.length, 1);
  assert.equal(f.exceptions[0].exception, reservationFailure);
  assert.deepEqual(f.exceptions[0].properties, {
    releaseSha: 'abc1234', appVersion: '9.8.7', operation: 'POST /checkout',
  });
});

test('a failed reservation is tracked as a failed request', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(failing());
  await invoke(f.handler);
  assert.equal(f.requests.length, 1);
  const [request] = f.requests;
  assert.equal(request.name, 'POST /checkout');
  assert.equal(request.url, 'http://localhost/checkout');
  assert.equal(request.success, false);
  assert.equal(request.resultCode, '500');
  assert.ok(request.duration >= 0);
  assert.deepEqual(request.properties, {
    simulated: 'true', outcome: 'failed', 'http.method': 'POST',
    releaseSha: 'abc1234', appVersion: '9.8.7',
  });
});

test('a failed reservation writes one log line with the message only', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(['error', line]));
  for (const method of ['log', 'info', 'warn']) {
    t.mock.method(console, method, (line) => lines.push([method, line]));
  }
  const f = fixture(failing());
  await invoke(f.handler);
  assert.equal(lines.length, 1);
  const [level, line] = lines[0];
  assert.equal(level, 'error');
  assert.deepEqual(JSON.parse(line), {
    event: 'checkout-failed', release: 'abc1234', message: reservationFailure.message,
  });
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('    at '), false);
});

test('a successful checkout neither logs nor tracks a failure', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const f = fixture();
  await invoke(f.handler);
  assert.equal(f.exceptions.length, 0);
  assert.equal(logged.mock.callCount(), 0);
});

test('thrown values that are not errors are still reported as failed checkouts', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const f = fixture(failing('gateway said no'));
  const response = await invoke(f.handler);
  assert.equal(response.status, 500);
  assert.ok(f.exceptions[0].exception instanceof Error);
  assert.equal(f.exceptions[0].exception.message, 'gateway said no');
  assert.equal(JSON.parse(lines[0]).message, 'gateway said no');
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

test('telemetry failures never change the failed or the successful response', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [options, status] of [[failing(), 500], [{}, 200]]) {
    const f = fixture(options);
    f.telemetry.trackRequest = () => { throw new Error('telemetry-unavailable'); };
    f.telemetry.trackException = () => { throw new Error('telemetry-unavailable'); };
    const response = await invoke(f.handler);
    assert.equal(response.status, status);
    assert.equal(response.body.includes('telemetry-unavailable'), false);
  }
});

test('checkout works without telemetry, even when it fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal((await invoke(fixture({ telemetry: undefined }).handler)).status, 200);
  assert.equal((await invoke(fixture({ telemetry: undefined, ...failing() }).handler)).status, 500);
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
