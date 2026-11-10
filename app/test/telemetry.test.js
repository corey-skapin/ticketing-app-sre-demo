'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { Socket } = require('node:net');
const { createHandler } = require('../handler');
const { createTelemetry } = require('../telemetry');

const key = 'test-instrumentation-key';
const connectionString = `InstrumentationKey=${key};IngestionEndpoint=https://example.invalid/`;
const gateway = {
  env: { PAYMENT_GATEWAY_URL: 'https://payments.example.test' },
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ authorized: true }) }),
};

function offlineTelemetry(t) {
  const sdk = require('applicationinsights');
  const sdkRequire = createRequire(require.resolve('applicationinsights'));
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
    sdkRequire('@opentelemetry/sdk-trace-base');
  const { LoggerProvider, InMemoryLogRecordExporter, SimpleLogRecordProcessor } =
    sdkRequire('@opentelemetry/sdk-logs');
  // Exercise the installed exporter's real wire-envelope conversion, without
  // constructing Azure exporters (which initialize senders and background work).
  const exporterUtils = join(
    dirname(sdkRequire.resolve('@azure/monitor-opentelemetry-exporter')), 'utils');
  const { readableSpanToEnvelope } = require(join(exporterUtils, 'spanUtils.js'));
  const { logToEnvelope } = require(join(exporterUtils, 'logUtils.js'));
  const { LogApi } = require(join(dirname(require.resolve('applicationinsights')), 'shim', 'logsApi.js'));
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  t.after(() => provider.shutdown());
  t.after(() => loggerProvider.shutdown());
  const connect = t.mock.method(Socket.prototype, 'connect', () => {
    assert.fail('Offline telemetry tests must not open sockets');
  });
  t.after(() => assert.equal(connect.mock.callCount(), 0));
  // Replace only initialization and the tracer and logger behind trackRequest,
  // trackException and trackEvent, which run unchanged against real, locally
  // scoped OTel spans and log records.
  t.mock.method(sdk.TelemetryClient.prototype, 'initialize', function () {
    this._isInitialized = true;
  });
  t.mock.method(sdk.TelemetryClient.prototype, '_getTracerInstance',
    () => provider.getTracer('ApplicationInsightsTracer'));
  const client = createTelemetry(connectionString, sdk);
  client._logApi = new LogApi(loggerProvider.getLogger('ApplicationInsightsLogger'));
  return {
    client,
    async envelopes() {
      await provider.forceFlush();
      await loggerProvider.forceFlush();
      const envelopes = [
        ...exporter.getFinishedSpans().map((span) => readableSpanToEnvelope(span, key)),
        ...logExporter.getFinishedLogRecords().map((log) => logToEnvelope(log, key)),
      ];
      exporter.reset();
      logExporter.reset();
      return envelopes;
    },
  };
}

test('missing connection string does not initialize the SDK', () => {
  assert.equal(createTelemetry(undefined, {}), undefined);
});

test('manual-only SDK configuration disables sampling and automatic sensitive collection before initialization', () => {
  let initialized = false;
  class TelemetryClient {
    constructor(connectionString) {
      assert.equal(connectionString, 'test-connection-string');
      this.config = {};
    }
    initialize() {
      initialized = true;
      assert.equal(this.config.samplingPercentage, 100);
      assert.equal(this.config.noDiagnosticChannel, true);
      for (const setting of [
        'enableAutoCollectRequests', 'enableAutoCollectDependencies',
        'enableAutoCollectExceptions', 'enableAutoCollectConsole',
        'enableAutoCollectExternalLoggers', 'enableSendLiveMetrics',
        'enableUseDiskRetryCaching', 'enableWebInstrumentation',
      ]) assert.equal(this.config[setting], false, setting);
    }
  }
  createTelemetry('test-connection-string', { TelemetryClient });
  assert.equal(initialized, true);
});

test('installed SDK maps configuration to unsampled manual-only instrumentation without network initialization', () => {
  const sdk = require('applicationinsights');
  const original = sdk.TelemetryClient.prototype.initialize;
  sdk.TelemetryClient.prototype.initialize = function () {};
  try {
    const client = createTelemetry(connectionString, sdk);
    const options = client.config.parseConfig();
    assert.equal(options.samplingRatio, 1);
    for (const [name, instrumentation] of Object.entries(options.instrumentationOptions)) {
      assert.equal(instrumentation.enabled, false, name);
    }
    assert.equal(options.enableAutoCollectExceptions, false);
    assert.equal(options.enableLiveMetrics, false);
    assert.equal(options.azureMonitorExporterOptions.disableOfflineStorage, true);
  } finally {
    sdk.TelemetryClient.prototype.initialize = original;
  }
});

test('pinned SDK reproduces response code zero for named requests without an HTTP method', async (t) => {
  assert.equal(require('applicationinsights/package.json').version, '3.16.0');
  const telemetry = offlineTelemetry(t);
  for (const [resultCode, success] of [['200', true], ['500', false]]) {
    telemetry.client.trackRequest({
      name: 'POST /checkout', url: 'http://localhost/checkout',
      duration: 1, resultCode, success,
      properties: { simulated: 'true' },
    });
    const [envelope] = await telemetry.envelopes();
    assert.equal(envelope.data.baseType, 'RequestData');
    assert.equal(envelope.data.baseData.name, 'POST /checkout');
    assert.equal(envelope.data.baseData.responseCode, '0');
    assert.equal(envelope.data.baseData.success, success);
  }
});

test('checkout emits a sanitized 200 request envelope through the installed SDK and exporter', async (t) => {
  const telemetry = offlineTelemetry(t);
  const secret = 'checkout-secret-never-export';
  const handler = createHandler({
    ...gateway,
    telemetry: telemetry.client,
    release: { version: '9.8.7', sha: 'abc1234' },
  });
  const response = {
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler({
    method: 'POST', url: `/checkout?token=${secret}`,
    headers: { host: `${secret}.example.test`, authorization: `Bearer ${secret}` },
    resume() {},
  }, response);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  const envelopes = await telemetry.envelopes();
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].data.baseType, 'RequestData');
  const request = envelopes[0].data.baseData;
  assert.equal(request.name, 'POST /checkout');
  assert.equal(request.responseCode, '200');
  assert.equal(request.success, true);
  assert.equal(request.url, 'http://localhost/checkout');
  assert.deepEqual(request.properties, {
    simulated: 'true', outcome: 'reserved', releaseSha: 'abc1234', appVersion: '9.8.7',
  });
  assert.equal(JSON.stringify(envelopes).includes(secret), false);
});

test('a failed checkout emits a 500 request and an exception through the installed SDK and exporter', async (t) => {
  t.mock.method(console, 'error', () => {});
  const telemetry = offlineTelemetry(t);
  const secret = 'checkout-secret-never-export';
  const handler = createHandler({
    ...gateway,
    telemetry: telemetry.client,
    release: { version: '9.8.7', sha: 'abc1234' },
    reserveTickets: async () => { throw new Error('reservation backend unavailable'); },
  });
  const response = {
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler({
    method: 'POST', url: `/checkout?token=${secret}`,
    headers: { host: `${secret}.example.test`, authorization: `Bearer ${secret}` },
    resume() {},
  }, response);
  assert.equal(response.status, 500);
  assert.equal(response.body.success, false);
  const envelopes = await telemetry.envelopes();
  assert.equal(envelopes.length, 2);
  const request = envelopes.find((item) => item.data.baseType === 'RequestData').data.baseData;
  assert.equal(request.name, 'POST /checkout');
  assert.equal(request.responseCode, '500');
  assert.equal(request.success, false);
  assert.equal(request.url, 'http://localhost/checkout');
  assert.deepEqual(request.properties, {
    simulated: 'true', outcome: 'failed', releaseSha: 'abc1234', appVersion: '9.8.7',
  });
  const exception = envelopes.find((item) => item.data.baseType === 'ExceptionData').data.baseData;
  assert.equal(exception.exceptions[0].message, 'reservation backend unavailable');
  assert.match(exception.exceptions[0].parsedStack[0].fileName, /telemetry\.test\.js$/);
  assert.deepEqual(exception.properties, {
    releaseSha: 'abc1234', appVersion: '9.8.7', operation: 'POST /checkout',
  });
  assert.equal(JSON.stringify(envelopes).includes(secret), false);
});

test('the release start event keeps its release properties through the installed SDK and exporter', async (t) => {
  const telemetry = offlineTelemetry(t);
  telemetry.client.trackEvent({
    name: 'ReleaseStarted',
    properties: { releaseSha: 'abc1234', appVersion: '9.8.7' },
  });
  const envelopes = await telemetry.envelopes();
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].data.baseType, 'EventData');
  assert.equal(envelopes[0].data.baseData.name, 'ReleaseStarted');
  assert.deepEqual(envelopes[0].data.baseData.properties, {
    releaseSha: 'abc1234', appVersion: '9.8.7',
  });
});
