'use strict';

/* End-to-end smoke test: boots the real server, drives it over HTTP + ws. */

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

/** @typedef {import('../src/protocol').ReadyMessage} ReadyMessage */
/** @typedef {import('../src/protocol').ServerMessage} ServerMessage */
/** @typedef {{ url: string, file: string, type: string }} ManifestFile */
/** @typedef {{ url: string, colorScheme: string }} ManifestImage */
/** @typedef {{ title: string, version: string, description: string, main: string, icons?: ManifestImage[] }} ManifestEntry */
/** @typedef {{ base: string, entries: ManifestEntry[], files: ManifestFile[] }} Manifest */

const TOKEN = 'test-token-abc';
const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'server.js');
const DIST = path.join(ROOT, 'dist');

let passed = 0;
/** @param {string} name */
function ok(name) {
  passed++;
  process.stdout.write(`  ok  ${name}\n`);
}

/**
 * Every file under `dir`, as posix-style relative paths.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

/**
 * @param {string[]} [extraArgs]
 * @param {Record<string, string>} [env] extra environment for the child
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number }>}
 */
function startServer(extraArgs = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ENTRY, '--port', '0', '--host', '127.0.0.1',
      '--token', TOKEN, '--shell', '/bin/bash',
      ...extraArgs,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });

    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    child.stdout?.on('data', (/** @type {Buffer} */ buf) => {
      out += buf.toString();
      const match = out.match(/listening on [\d.]+:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

/**
 * @param {number} port
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
function get(port, pathname, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { headers, redirect: 'manual' });
}

/**
 * Opens a websocket and resolves once the shell has echoed `expect`.
 * @param {number} port
 * @param {{ id?: string, expect: string, send?: string, base?: string }} opts
 * @returns {Promise<{ ready: ReadyMessage, output: string }>}
 */
function session(port, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(`ws://127.0.0.1:${port}${opts.base ?? '/'}ws`);
    url.searchParams.set('token', TOKEN);
    url.searchParams.set('cols', '100');
    url.searchParams.set('rows', '30');
    if (opts.id) url.searchParams.set('id', opts.id);

    const ws = new WebSocket(url);
    /** @type {ReadyMessage | null} */
    let ready = null;
    let output = '';

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for ${JSON.stringify(opts.expect)}; saw: ${JSON.stringify(output.slice(-400))}`));
    }, 15_000);

    ws.on('message', (/** @type {Buffer} */ data, /** @type {boolean} */ isBinary) => {
      if (isBinary) {
        output += data.toString('utf8');
        if (output.includes(opts.expect) && ready) {
          clearTimeout(timer);
          ws.close();
          resolve({ ready, output });
        }
        return;
      }
      /** @type {ServerMessage} */
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        ready = msg;
        if (opts.send) {
          setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: opts.send })), 300);
        }
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Opens a websocket and resolves with its `ready` message. With `close` set it
 * also sends the close request a console sends when it goes away, and waits
 * for the server to hang up on it.
 * @param {number} port
 * @param {{ id?: string, close?: boolean }} [opts]
 * @returns {Promise<ReadyMessage>}
 */
function attach(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`ws://127.0.0.1:${port}/ws`);
    url.searchParams.set('token', TOKEN);
    url.searchParams.set('cols', '80');
    url.searchParams.set('rows', '24');
    if (opts.id) url.searchParams.set('id', opts.id);

    const ws = new WebSocket(url);
    /** @type {ReadyMessage | null} */
    let ready = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for ready'));
    }, 15_000);

    ws.on('message', (/** @type {Buffer} */ data, /** @type {boolean} */ isBinary) => {
      if (isBinary || ready) return;
      /** @type {ServerMessage} */
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'ready') return;
      ready = msg;
      if (!opts.close) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
        return;
      }
      ws.send(JSON.stringify({ type: 'close' }));
    });
    // The server hanging up is what tells us the shell is really gone.
    ws.on('close', () => {
      if (!opts.close) return;
      clearTimeout(timer);
      if (ready) resolve(ready);
      else reject(new Error('socket closed before ready'));
    });
    ws.on('error', (/** @type {Error} */ err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  const { child, port } = await startServer();
  process.stdout.write(`server on port ${port}\n`);
  try {
    assert.equal((await get(port, '/')).status, 401);
    ok('rejects requests with no token');

    assert.equal((await get(port, '/', { cookie: 'webconsole_token=wrong' })).status, 401);
    ok('rejects a wrong token');

    const redirect = await get(port, `/index.html?token=${TOKEN}`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/', 'should land on the clean path');
    assert.match(redirect.headers.get('set-cookie') ?? '', /webconsole_token=.*HttpOnly/);
    ok('/index.html?token= trades the token for an HttpOnly cookie');

    assert.equal((await get(port, `/index.html?token=${TOKEN}x`)).status, 401);
    ok('/index.html with a bad token is still refused');

    const cookie = `webconsole_token=${TOKEN}`;

    const page = await get(port, '/', { cookie });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>webconsole<\/title>/);
    assert.match(html, /<script[^>]+src="\/[^"\/]+\.js"/, 'expected the Vite-built bundle beside index.html');
    ok('serves the Vite-built client to an authenticated request');

    const manifest = /** @type {Manifest} */ (
      await (await get(port, '/manifest.json', { cookie })).json()
    );
    assert.equal(manifest.base, '/');
    const [entry, ...rest] = manifest.entries;
    assert.ok(entry, 'the manifest should carry a catalog entry');
    assert.deepEqual(rest, [], 'the console is one app, so one entry');
    assert.ok(entry.title && entry.description, 'the entry should name and describe the app');
    assert.equal(entry.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    assert.equal(entry.main, manifest.base, 'the app opens at its base');
    assert.ok(
      entry.icons?.every((icon) => manifest.files.some((file) => file.url === icon.url)),
      'every icon should be a file the manifest publishes',
    );
    const document = manifest.files.find((file) => file.file === 'index.html');
    assert.equal(document?.url, manifest.base, 'the entry document belongs at the base itself');
    assert.ok(
      manifest.files.some((file) => file.type === 'text/javascript' && html.includes(file.url)),
      'the served HTML should reference the script the manifest lists',
    );
    ok('publishes a manifest.json with a catalog entry and the document at the base');

    for (const file of manifest.files) {
      /** @type {string} */
      const wantUrl = file.file === 'index.html' ? manifest.base : manifest.base + file.file;
      assert.equal(file.url, wantUrl, `wrong url for ${file.file}`);
      const served = await get(port, file.url, { cookie });
      assert.equal(served.status, 200, `${file.url} should be served`);
      assert.ok(
        (served.headers.get('content-type') ?? '').startsWith(file.type),
        `${file.file} served as ${served.headers.get('content-type')}, manifest says ${file.type}`,
      );
    }
    ok('every manifest entry is served at its url with the declared type');

    assert.deepEqual(
      listFiles(DIST).filter((file) => file.includes('/')),
      [],
      'the build should be flat: no subdirectories under dist/',
    );
    ok('writes the whole bundle straight into dist/');

    const hashed = manifest.files.find((file) => file.file !== 'index.html');
    assert.ok(hashed, 'the build should emit at least one hashed file');
    const pinned = await get(port, hashed.url, { cookie });
    assert.match(pinned.headers.get('cache-control') ?? '', /immutable/, 'hashed files should be pinned');
    assert.equal(
      (await get(port, '/index.html', { cookie })).headers.get('cache-control'),
      'no-store',
      'index.html keeps its name, so it must not be pinned',
    );
    ok('pins content-hashed files and never the entry document');

    const onDisk = listFiles(DIST).filter((file) => file !== 'manifest.json').sort();
    assert.deepEqual(onDisk, manifest.files.map((file) => file.file), 'manifest should cover dist/ exactly');
    ok('dist/ contains client files and manifest.json only');

    const info = await get(port, '/api/info', { cookie });
    assert.equal(info.status, 200);
    const serverInfo = /** @type {{ shell: string, cwd: string }} */ (await info.json());
    assert.equal(serverInfo.shell, '/bin/bash');
    assert.equal(serverInfo.cwd, ROOT, 'the shell starts where the server was started');
    ok('reports server info as JSON');

    const escape = await get(port, '/%2e%2e/package.json', { cookie });
    assert.ok([403, 404].includes(escape.status), `expected 403/404, got ${escape.status}`);
    ok('refuses to serve files outside the client bundle');

    const first = await session(port, {
      send: 'echo hello-from-$((6*7))-pty\n',
      expect: 'hello-from-42-pty',
    });
    assert.equal(first.ready.resumed, false);
    ok('runs a command in a server-side PTY and streams stdout');

    const tty = await session(port, { send: 'tty; tput cols\n', expect: '100' });
    assert.match(tty.output, /\/dev\/(pts|tty)/);
    ok('the shell gets a real tty at the requested width');

    const resumed = await session(port, { id: first.ready.id, expect: 'hello-from-42-pty' });
    assert.equal(resumed.ready.resumed, true);
    assert.equal(resumed.ready.id, first.ready.id);
    ok('re-attaching replays the session scrollback');

    const doomed = await attach(port);
    assert.equal((await attach(port, { id: doomed.id })).resumed, true, 'the shell should outlive one socket');
    await attach(port, { id: doomed.id, close: true });
    assert.equal(
      (await attach(port, { id: doomed.id })).resumed, false,
      'the id of a closed session should not resume anything',
    );
    ok('a console that closes ends its shell instead of leaving it running');

    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => { ws.close(); resolve(undefined); });
        ws.on('error', reject);
      }),
      /401/,
      'unauthenticated websocket should be refused',
    );
    ok('refuses an unauthenticated websocket upgrade');
  } finally {
    child.kill('SIGTERM');
  }

  await checkNpmStyleFlags();
  await checkBaseUrlBuild();
  process.stdout.write(`\n${passed} checks passed\n`);
}

/**
 * `npm start --start-dir=/srv` is swallowed by npm and handed to the script as
 * npm_config_start_dir; the server has to read those as well as real arguments.
 */
async function checkNpmStyleFlags() {
  const dir = fs.realpathSync(os.tmpdir());
  const cookie = `webconsole_token=${TOKEN}`;

  {
    const { child, port } = await startServer([], {
      npm_config_start_dir: dir,
      npm_config_read_only: 'true',
      npm_config_max_sessions: '3',
    });
    try {
      const info = /** @type {{ cwd: string, readOnly: boolean, maxSessions: number }} */ (
        await (await get(port, '/api/info', { cookie })).json()
      );
      assert.equal(info.cwd, dir, 'npm_config_start_dir should set the shell directory');
      assert.equal(info.readOnly, true, 'npm_config_read_only should be honoured');
      assert.equal(info.maxSessions, 3, 'npm_config_max_sessions should be honoured');
      ok('npm-style flags (npm start --start-dir=… --read-only) reach the server');
    } finally {
      child.kill('SIGTERM');
    }
  }

  {
    // `npm run dev --base-url=/123` reaches the server this way, and has to
    // move the API and the socket even though dist/ was built for `/`.
    const { child, port } = await startServer([], { npm_config_base_url: '123' });
    try {
      assert.equal((await get(port, '/123/api/info', { cookie })).status, 200);
      assert.equal((await get(port, '/api/info', { cookie })).status, 404, 'nothing is left at the root');
      const ws = await session(port, { base: '/123/', expect: 'mounted-elsewhere' , send: 'echo mounted-elsewhere\n' });
      assert.equal(ws.ready.resumed, false);
      ok('--base-url moves the API and the shell socket, whatever dist/ was built for');
    } finally {
      child.kill('SIGTERM');
    }
  }

  {
    const { child, port } = await startServer(['--cwd', ROOT], { npm_config_start_dir: dir });
    try {
      const info = /** @type {{ cwd: string }} */ (
        await (await get(port, '/api/info', { cookie })).json()
      );
      assert.equal(info.cwd, ROOT, 'a real argument should beat the npm_config fallback');
      ok('a --cwd argument wins over the npm-style form');
    } finally {
      child.kill('SIGTERM');
    }
  }

  {
    const { child, port } = await startServer(['--cwd=' + dir]);
    try {
      const info = /** @type {{ cwd: string }} */ (
        await (await get(port, '/api/info', { cookie })).json()
      );
      assert.equal(info.cwd, dir, '--flag=value should parse');
      ok('accepts --flag=value as well as --flag value');
    } finally {
      child.kill('SIGTERM');
    }
  }
}

/** Builds the client for a sub-path and checks the server mounts itself there. */
async function checkBaseUrlBuild() {
  const base = '/console/';

  const { normalizeBase } = await import('../scripts/build.mjs');
  for (const spelling of ['console', '/console', 'console/', '/console/', '//console//']) {
    assert.equal(normalizeBase(spelling), base, `--base-url=${spelling} should mean ${base}`);
  }
  assert.equal(normalizeBase('https://cdn.example.com/app'), 'https://cdn.example.com/app/');
  ok('--base-url accepts every spelling of the same path');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webconsole-base-'));
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build.mjs'), '--base-url', 'console', '--out-dir', outDir,
  ], { cwd: ROOT, stdio: 'ignore' });

  const manifest = /** @type {Manifest} */ (
    JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
  );
  assert.equal(manifest.base, base, '--base-url console should normalise to /console/');
  assert.ok(manifest.files.every((file) => file.url.startsWith(base)), 'every url should carry the base');
  ok('--base-url builds the client for a sub-path');

  // `npm run build --base-url=console` is swallowed by npm and handed to the
  // script as an environment variable instead of an argument.
  const viaNpm = fs.mkdtempSync(path.join(os.tmpdir(), 'webconsole-npm-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, npm_config_base_url: 'console', npm_config_out_dir: viaNpm },
    });
    const fromEnv = /** @type {Manifest} */ (
      JSON.parse(fs.readFileSync(path.join(viaNpm, 'manifest.json'), 'utf8'))
    );
    assert.equal(fromEnv.base, base);
    assert.deepEqual(fromEnv.files.map((file) => file.url), manifest.files.map((file) => file.url));
    ok('npm-style `npm run build --base-url=console` reaches the build');
  } finally {
    fs.rmSync(viaNpm, { recursive: true, force: true });
  }

  const { child, port } = await startServer(['--static', outDir]);
  const cookie = `webconsole_token=${TOKEN}`;
  try {
    const root = await get(port, '/', { cookie });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), base);
    ok('redirects / to the mounted base');

    const page = await get(port, base, { cookie });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(
      manifest.files.some((file) => file.type === 'text/javascript' && html.includes(file.url)),
      'the page should load its script from under the base',
    );
    const asset = manifest.files.find((file) => file.type === 'text/javascript');
    assert.ok(asset, 'the sub-path build should emit a script');
    assert.equal(
      (await get(port, `/${asset.file}`, { cookie })).status,
      404,
      'nothing is served at the root',
    );
    ok('serves the sub-path build and its assets under the base');

    const info = await get(port, `${base}api/info`, { cookie });
    assert.equal(info.status, 200);
    const auth = await get(port, `${base}index.html?token=${TOKEN}`);
    assert.equal(auth.status, 302);
    assert.equal(auth.headers.get('location'), base, 'should land on the base, not on index.html');
    assert.match(auth.headers.get('set-cookie') ?? '', new RegExp(`Path=${base}`));
    ok('takes the token at <base>/index.html and scopes the cookie to the base');

    const shell = await session(port, { base, send: 'echo based-pty\n', expect: 'based-pty' });
    assert.equal(shell.ready.resumed, false);
    ok('runs a PTY over the websocket mounted under the base');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((/** @type {Error} */ err) => {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
