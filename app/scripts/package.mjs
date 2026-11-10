import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const files = ['app.js', 'index.html', 'styles.css'];

function releaseSha() {
  let sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA;
  if (!sha) {
    try {
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    } catch {
      throw new Error('Set RELEASE_SHA when packaging outside a git checkout.');
    }
  }
  return sha.trim().slice(0, 7);
}

// Checkouts with CRLF line endings must produce the same bytes as LF ones.
const lf = (text) => text.replace(/\r\n/g, '\n');
const normalizeLineEndings = {
  name: 'normalize-line-endings',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(?:[cm]?js|json)$/ }, async ({ path }) => ({
      contents: lf(await readFile(path, 'utf8')),
      loader: path.endsWith('.json') ? 'json' : 'js',
    }));
  },
};

const sha = releaseSha();
const bundle = await build({
  entryPoints: [join(root, 'server.js')],
  outfile: join(root, 'server.js'),
  allowOverwrite: true,
  write: false,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  // 'linked' adds the sourceMappingURL comment that --enable-source-maps follows.
  // The map keeps names and positions only; the sources live in the repository.
  sourcemap: 'linked',
  sourcesContent: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __RELEASE_SHA__: JSON.stringify(sha),
  },
  plugins: [normalizeLineEndings],
  logLevel: 'warning',
});
const output = (name) => bundle.outputFiles.find((file) => file.path.endsWith(name)).contents;

const entries = {
  'package.json': Buffer.from(`${JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    scripts: { start: 'node server.js' },
    engines: { node: '>=22' },
  }, null, 2)}\n`),
  ...Object.fromEntries(files.map((file) => [
    `public/${file}`, Buffer.from(lf(readFileSync(join(root, 'public', file), 'utf8'))),
  ])),
  'server.js': output('server.js'),
  'server.js.map': output('server.js.map'),
};

// fflate writes DOS timestamps from local-time getters, so a local-time Date
// keeps every entry's timestamp the same on every machine and time zone.
const mtime = new Date(2000, 0, 1, 12, 0, 0);
const archive = zipSync(Object.fromEntries(Object.keys(entries).sort().map((name) => [
  name, [entries[name], { level: 9, mtime }],
])));

const outDir = join(root, 'dist');
const outFile = join(outDir, `ticketing-app-v${pkg.version}.zip`);
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, archive);
console.log(`${outFile}\n  version ${pkg.version}, release ${sha}, ${archive.length} bytes, ` +
  `sha256 ${createHash('sha256').update(archive).digest('hex')}`);
