'use strict';

const { createTelemetry } = require('./telemetry');

let telemetry;
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    telemetry = createTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
      require('applicationinsights'));
  } catch {
    console.warn('Telemetry initialization unavailable. The app will continue without telemetry.');
  }
}

const { createServer } = require('node:http');
const { createHandler } = require('./handler');

const server = createServer(createHandler({ telemetry }));
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => {
  console.info('Ticketing app listening.');
});
