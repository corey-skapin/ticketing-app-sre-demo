'use strict';

const { createTelemetry } = require('./telemetry');
const release = require('./release');

let telemetry;
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    telemetry = createTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
      require('applicationinsights'));
  } catch {
    console.warn('Telemetry initialization unavailable. The app will continue without telemetry.');
  }
}
if (telemetry) {
  try {
    telemetry.trackEvent({
      name: 'ReleaseStarted',
      properties: { releaseSha: release.sha, appVersion: release.version },
    });
  } catch {
    // Telemetry availability must never stop the app from starting.
  }
}

const { createServer } = require('node:http');
const { createHandler } = require('./handler');

const port = Number(process.env.PORT || 8080);
const server = createServer(createHandler({ telemetry }));
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(port, '0.0.0.0', () => {
  console.info(`Ticketing app ${release.version} (${release.sha}) listening on port ${port}.`);
});
