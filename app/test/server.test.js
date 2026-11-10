'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Runs the real startup file against module doubles: no sockets and no SDK.
function startServer({ env = {}, modules = {} } = {}) {
  const state = { handlerOptions: undefined, listen: undefined, logs: [], required: [] };
  const server = {
    listen(port, host, callback) {
      state.listen = { port, host };
      callback();
    },
  };
  const doubles = {
    './telemetry': { createTelemetry() { return undefined; } },
    './handler': {
      createHandler(options) {
        state.handlerOptions = options;
        return function handler() {};
      },
    },
    'node:http': { createServer(handler) { state.handler = handler; return server; } },
    ...modules,
  };
  runInNewContext(readFileSync(join(__dirname, '../server.js'), 'utf8'), {
    process: { env },
    console: {
      info: (...args) => state.logs.push(['info', ...args]),
      warn: (...args) => state.logs.push(['warn', ...args]),
    },
    require(name) {
      assert.ok(Object.hasOwn(doubles, name), `Unexpected startup dependency: ${name}`);
      state.required.push(name);
      return doubles[name];
    },
  });
  return { state, server };
}

test('server listens on all interfaces on the default port and needs no telemetry', () => {
  const { state } = startServer();
  assert.deepEqual(state.listen, { port: 8080, host: '0.0.0.0' });
  assert.equal(state.handlerOptions.telemetry, undefined);
  assert.equal(state.required.includes('applicationinsights'), false);
  assert.equal(typeof state.handler, 'function');
});

test('server listens on the configured port', () => {
  const { state } = startServer({ env: { PORT: '3100' } });
  assert.equal(state.listen.port, 3100);
});

test('server applies conservative HTTP timeouts', () => {
  const { server } = startServer();
  assert.equal(server.requestTimeout, 10000);
  assert.equal(server.headersTimeout, 10000);
  assert.equal(server.keepAliveTimeout, 5000);
});

test('telemetry is created from the connection string and handed to the handler', () => {
  const sdk = { name: 'sdk-double' };
  const telemetry = { name: 'telemetry-double' };
  const calls = [];
  const { state } = startServer({
    env: { APPLICATIONINSIGHTS_CONNECTION_STRING: 'connection-string-double' },
    modules: {
      applicationinsights: sdk,
      './telemetry': { createTelemetry: (...args) => { calls.push(args); return telemetry; } },
    },
  });
  assert.deepEqual(calls, [['connection-string-double', sdk]]);
  assert.equal(state.handlerOptions.telemetry, telemetry);
});

test('a telemetry failure at startup does not stop the server', () => {
  const { state } = startServer({
    env: { APPLICATIONINSIGHTS_CONNECTION_STRING: 'connection-string-double' },
    modules: {
      applicationinsights: {},
      './telemetry': { createTelemetry() { throw new Error('sdk-unavailable'); } },
    },
  });
  assert.equal(state.listen.port, 8080);
  assert.equal(state.handlerOptions.telemetry, undefined);
  assert.equal(state.logs.some(([level]) => level === 'warn'), true);
  assert.equal(JSON.stringify(state.logs).includes('sdk-unavailable'), false);
});
