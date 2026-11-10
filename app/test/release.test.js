'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// esbuild replaces __APP_VERSION__ and __RELEASE_SHA__ when it bundles the app;
// supplying them as globals reproduces that without a build.
function loadRelease({ baked = {}, env = {} } = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, '../release.js'), 'utf8'), {
    module, process: { env }, ...baked,
  });
  return { ...module.exports };
}

test('baked values win over the environment', () => {
  assert.deepEqual(loadRelease({
    baked: { __APP_VERSION__: '1.2.3', __RELEASE_SHA__: 'abc1234' },
    env: { APP_VERSION: '9.9.9', RELEASE_SHA: 'fedcba9' },
  }), { version: '1.2.3', sha: 'abc1234' });
});

test('the environment is used when nothing is baked in', () => {
  assert.deepEqual(loadRelease({
    env: { APP_VERSION: '2.0.0', RELEASE_SHA: '1234567' },
  }), { version: '2.0.0', sha: '1234567' });
});

test('unbundled runs without overrides report dev', () => {
  assert.deepEqual(loadRelease(), { version: 'dev', sha: 'dev' });
});

test('the version and the release fall back independently', () => {
  assert.deepEqual(loadRelease({
    baked: { __APP_VERSION__: '1.2.3' },
    env: { APP_VERSION: '9.9.9', RELEASE_SHA: '1234567' },
  }), { version: '1.2.3', sha: '1234567' });
  assert.deepEqual(loadRelease({
    baked: { __RELEASE_SHA__: 'abc1234' },
    env: { APP_VERSION: '2.0.0' },
  }), { version: '2.0.0', sha: 'abc1234' });
});

test('the built-in release is a version and a sha', () => {
  const { version, sha } = require('../release');
  assert.equal(typeof version, 'string');
  assert.equal(typeof sha, 'string');
  assert.ok(version.length > 0 && sha.length > 0);
});
