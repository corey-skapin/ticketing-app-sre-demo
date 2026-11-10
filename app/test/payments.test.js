'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorizePayment } = require('../payments');

const env = { PAYMENT_GATEWAY_URL: 'https://payments.example.test' };
const order = { orderId: 'A1B2C3D4', amountCents: 16800 };

test('authorizePayment posts the order to the gateway and returns its answer', async (t) => {
  const timeout = t.mock.method(AbortSignal, 'timeout');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ authorized: true, reference: 'auth-1' }) };
  };
  const answer = await authorizePayment({ env, ...order, fetchImpl });
  assert.deepEqual(answer, { authorized: true, reference: 'auth-1' });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), 'https://payments.example.test/v1/authorize');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), order);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[3000]]);
});

test('authorizePayment throws with the status when the gateway does not answer 2xx', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(authorizePayment({ env, ...order, fetchImpl }), {
    message: 'Payment gateway returned 502',
  });
});

test('authorizePayment throws when the gateway URL is missing, before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  await assert.rejects(authorizePayment({ env: {}, ...order, fetchImpl }), {
    message: 'PAYMENT_GATEWAY_URL is not configured',
  });
  assert.equal(calls, 0);
});

test('authorizePayment rejects with the network error when the gateway cannot be reached', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(authorizePayment({ env, ...order, fetchImpl }), TypeError);
});
