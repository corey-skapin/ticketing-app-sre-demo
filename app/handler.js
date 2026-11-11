'use strict';

const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { authorizePayment } = require('./payments');
const defaultRelease = require('./release');

const ORDER_TOTAL_CENTS = 16800;

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, {
  body: readFileSync(join(__dirname, 'public', file)), type,
}]));

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function createOrderId() {
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}

// There is no inventory service behind the page, so a reservation always succeeds.
async function defaultReserveTickets() {
  return { reserved: true };
}

function createHandler({
  telemetry, reserveTickets = defaultReserveTickets, release = defaultRelease,
  env = process.env, fetchImpl,
} = {}) {
  const releaseProperties = { releaseSha: release.sha, appVersion: release.version };

  function track(method, data) {
    try {
      telemetry?.[method](data);
    } catch {
      // Telemetry availability must never affect checkout or reveal SDK errors.
    }
  }

  function trackCheckout(started, success, resultCode = success ? '200' : '500',
    outcome = success ? 'reserved' : 'failed') {
    track('trackRequest', {
      name: 'POST /checkout',
      url: 'http://localhost/checkout', // Never trust Host/query parameters in telemetry.
      duration: performance.now() - started,
      resultCode,
      success,
      // AI 3.16.0 omits http.method for named requests; the exporter needs it for HTTP status mapping.
      properties: {
        simulated: 'true', outcome, 'http.method': 'POST',
        ...releaseProperties,
      },
    });
  }

  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Release-Sha', release.sha);
    response.setHeader('X-App-Version', release.version);
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://images.unsplash.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    request.resume(); // No endpoint reads request bodies.

    // Compare raw paths, without URL normalization or filesystem interpolation.
    const path = (request.url || '').split('?')[0];
    const asset = assets.get(path);
    const allowedMethod = path === '/checkout' ? 'POST' : 'GET';
    if (!asset && path !== '/healthz' && path !== '/checkout') {
      return json(response, 404, { error: 'Not found' });
    }
    if (request.method !== allowedMethod) {
      response.setHeader('Allow', allowedMethod);
      return json(response, 405, { error: 'Method not allowed' });
    }
    if (path === '/healthz') {
      return json(response, 200, { status: 'healthy', version: release.version, release: release.sha });
    }
    if (asset) {
      response.writeHead(200, { 'Content-Type': asset.type });
      return response.end(asset.body);
    }

    const started = performance.now();
    if (!env.PAYMENT_GATEWAY_URL) {
      trackCheckout(started, false, '503', 'configuration_missing');
      return json(response, 503, {
        success: false, simulated: true,
        message: 'Checkout is temporarily unavailable due to service configuration.',
      });
    }
    const orderId = createOrderId();
    try {
      await authorizePayment({ env, orderId, amountCents: ORDER_TOTAL_CENTS, fetchImpl });
      await reserveTickets({ orderId });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      track('trackException', {
        exception: failure,
        properties: { ...releaseProperties, operation: 'POST /checkout' },
      });
      trackCheckout(started, false);
      // The log line carries the message only; the stack goes to telemetry.
      console.error(JSON.stringify({
        event: 'checkout-failed', release: release.sha, message: failure.message,
      }));
      return json(response, 500, {
        success: false, simulated: true,
        message: 'Simulated checkout failed. Please try again shortly.',
      });
    }
    trackCheckout(started, true);
    return json(response, 200, {
      success: true, simulated: true, orderId,
      message: 'Simulated checkout succeeded; no purchase was made.',
    });
  };
}

module.exports = { createHandler };
