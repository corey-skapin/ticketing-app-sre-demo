'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const defaultRelease = require('./release');

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

// There is no inventory service behind the page, so a reservation always succeeds.
async function defaultReserveTickets() {
  return { reserved: true };
}

function createHandler({ telemetry, reserveTickets = defaultReserveTickets, release = defaultRelease } = {}) {
  const releaseProperties = { releaseSha: release.sha, appVersion: release.version };

  function track(method, data) {
    try {
      telemetry?.[method](data);
    } catch {
      // Telemetry availability must never affect checkout or reveal SDK errors.
    }
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
    await reserveTickets();
    track('trackRequest', {
      name: 'POST /checkout',
      url: 'http://localhost/checkout', // Never trust Host/query parameters in telemetry.
      duration: performance.now() - started,
      resultCode: '200',
      success: true,
      // AI 3.16.0 omits http.method for named requests; the exporter needs it for HTTP status mapping.
      properties: { simulated: 'true', outcome: 'reserved', 'http.method': 'POST', ...releaseProperties },
    });
    return json(response, 200, {
      success: true, simulated: true,
      message: 'Simulated checkout succeeded; no purchase was made.',
    });
  };
}

module.exports = { createHandler };
