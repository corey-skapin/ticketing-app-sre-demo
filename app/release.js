'use strict';

// esbuild defines these when the app is bundled; unbundled runs read the environment.
const bakedVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined;
const bakedSha = typeof __RELEASE_SHA__ === 'string' ? __RELEASE_SHA__ : undefined;

module.exports = {
  version: bakedVersion || process.env.APP_VERSION || 'dev',
  sha: bakedSha || process.env.RELEASE_SHA || 'dev',
};
