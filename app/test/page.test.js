'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const publicFile = (name) => readFileSync(join(__dirname, '..', 'public', name), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Runs the real page script against a minimal DOM and a stubbed fetch.
async function openPage({ health, checkout }) {
  const elements = {};
  const fetches = [];
  const document = {
    getElementById(id) {
      elements[id] ??= {
        id, textContent: '', dataset: {}, disabled: false, listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
      };
      return elements[id];
    },
  };
  runInNewContext(publicFile('app.js'), {
    document,
    window: { addEventListener() {} },
    fetch: async (url, options) => {
      fetches.push({ url, method: options?.method ?? 'GET' });
      return (url === '/healthz' ? health : checkout)();
    },
    AbortController,
    AbortSignal,
    performance,
    setTimeout,
    clearTimeout,
  });
  await flush();
  return { elements, fetches };
}

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

test('the page is CSP-safe: external script and stylesheet only', () => {
  const html = publicFile('index.html');
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  assert.deepEqual(scripts.map((tag) => /\ssrc="\/app\.js"/.test(tag)), [true]);
  assert.equal(/<script\b[^>]*>\s*[^<\s]/i.test(html), false, 'inline script');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline event handler');
  assert.equal(/<style\b|\sstyle\s*=/i.test(html), false, 'inline style');
});

test('the page has a place for the release next to the health status', () => {
  const html = publicFile('index.html');
  assert.match(html, /<p id="health"[^>]*>[^<]*<\/p><span id="release"><\/span>/);
});

test('the page shows the release read from /healthz', async () => {
  const page = await openPage({
    health: reply({ status: 'healthy', version: '9.8.7', release: 'abc1234' }),
  });
  assert.deepEqual(page.fetches, [{ url: '/healthz', method: 'GET' }]);
  assert.equal(page.elements.release.textContent, 'Release abc1234');
  assert.equal(page.elements.health.textContent, 'Tickets available');
  assert.equal(page.elements.health.dataset.state, 'success');
});

test('the page stays healthy when the health body has no release', async () => {
  const page = await openPage({
    health: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }),
  });
  assert.equal(page.elements.release.textContent, '');
  assert.equal(page.elements.health.textContent, 'Tickets available');
});

test('the page reports an unavailable service when /healthz fails', async () => {
  const page = await openPage({ health: reply({}, false) });
  assert.equal(page.elements.health.textContent, 'Ticketing unavailable');
  assert.equal(page.elements.health.dataset.state, 'failure');
  assert.equal(page.elements.release.textContent, '');
});
