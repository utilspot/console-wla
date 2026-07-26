#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const { parse, localUrl } = require('./config');
const { SessionStore } = require('./sessions');

/** @typedef {import('./config').Config} Config */
/** @typedef {import('./sessions').Session} Session */
/** @typedef {import('ws').WebSocket} WebSocket */
/** @typedef {import('./src/protocol').ClientMessage} ClientMessage */
/** @typedef {import('./src/protocol').ServerMessage} ServerMessage */
/** @typedef {import('./src/protocol').ServerInfo} ServerInfo */

const COOKIE = 'webconsole_token';

/** @type {Config} */
let cfg;
try {
  cfg = parse(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`webconsole: ${/** @type {Error} */ (err).message}\n`);
  process.exit(2);
}

const staticDir = path.resolve(cfg.staticDir ?? path.join(__dirname, 'dist'));

/**
 * @typedef {object} Manifest
 * @property {string} base   public path the client was built for
 * @property {Map<string, string>} types  file path -> content type
 * @property {Map<string, string>} routes request path below the base -> file
 */

/**
 * The build records what it produced in manifest.json: the public path the
 * client was compiled for (`npm run build --base-url=…`) and the content type
 * of every file. Both are read back here, so the server serves the bundle
 * exactly as the build described it.
 * @param {string} dir
 * @returns {Manifest}
 */
function readManifest(dir) {
  /** @type {Manifest} */
  const empty = { base: '/', types: new Map(), routes: new Map() };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return empty; // no build yet, or a directory we did not produce
  }
  // An absolute base means the assets live on another host; we still mount at /.
  const base = typeof raw?.base === 'string' && raw.base.startsWith('/')
    ? (raw.base.endsWith('/') ? raw.base : `${raw.base}/`)
    : '/';
  /** @type {Map<string, string>} */
  const types = new Map();
  /** @type {Map<string, string>} */
  const routes = new Map();
  for (const entry of Array.isArray(raw?.files) ? raw.files : []) {
    if (typeof entry?.file !== 'string' || typeof entry?.type !== 'string') continue;
    types.set(entry.file, entry.type);
    // Where a file is published is the manifest's business, not this server's:
    // documents get clean URLs, assets hang under the entry they belong to.
    if (typeof entry.url === 'string' && entry.url.startsWith(base)) {
      routes.set(entry.url.slice(base.length), entry.file);
    }
  }
  types.set('manifest.json', 'application/json'); // the manifest never lists itself
  return { base, types, routes };
}

const manifest = readManifest(staticDir);
// An explicit --base-url wins: in dev the client comes from Vite, so there may
// be no manifest to follow, or one built for somewhere else.
const BASE = cfg.base ?? manifest.base;

/** A content hash in the filename, the way Vite writes them: `index-CmEUnyBs.js`. */
const FINGERPRINTED = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+(\.map)?$/;

/** Types that are text and therefore need an explicit charset on the wire. */
const NEEDS_CHARSET = /^text\/|^application\/json$|^image\/svg\+xml$/;

/**
 * @param {string} file  path relative to the static directory
 * @returns {string}
 */
function contentTypeFor(file) {
  const type = manifest.types.get(file) ?? 'application/octet-stream';
  return NEEDS_CHARSET.test(type) ? `${type}; charset=utf-8` : type;
}

const store = new SessionStore(cfg);

/**
 * Request path relative to the mount point, or null if it falls outside.
 * @param {string} pathname
 * @returns {string | null}
 */
function relativePath(pathname) {
  if (BASE === '/') return pathname.slice(1);
  if (pathname.startsWith(BASE)) return pathname.slice(BASE.length);
  return null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {http.IncomingMessage} req
 * @returns {string | null}
 */
function cookieToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @returns {boolean}
 */
function authorized(req, url) {
  if (!cfg.auth || cfg.token === null) return true;
  const supplied = url.searchParams.get('token') ?? cookieToken(req);
  return supplied !== null && safeEqual(supplied, cfg.token);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} rel  path relative to the static directory
 */
function sendFile(res, rel) {
  fs.readFile(path.join(staticDir, rel), (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        rel === 'index.html'
          ? 'The client bundle is missing. Run `npm run build` (or `npm run dev` for the Vite dev server).\n'
          : 'not found\n',
      );
      return;
    }
    // Vite fingerprints every asset it emits (`index-CmEUnyBs.js`), so those are
    // safe to pin; index.html and manifest.json keep their names and are not.
    const immutable = FINGERPRINTED.test(rel);
    res.writeHead(200, {
      'content-type': contentTypeFor(rel),
      'content-length': body.length,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (!authorized(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('401 unauthorized - open the URL printed by the server (it carries ?token=...)\n');
    return;
  }

  const rel = relativePath(url.pathname);

  if (rel === null) {
    // `/console` (no trailing slash) and `/` both point at the mounted client.
    if (url.pathname === '/' || `${url.pathname}/` === BASE) {
      res.writeHead(302, { location: BASE });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`not found - the console is served under ${BASE}\n`);
    return;
  }

  // Trade the token in the query string for a cookie so it stops living in the
  // address bar and browser history. The entry document is the URL handed out
  // at startup (`…/index.html?token=…`); it lands on the clean base afterwards.
  if (cfg.token && url.searchParams.has('token')) {
    const entryDocument = rel === '' || rel === 'index.html';
    res.writeHead(302, {
      location: entryDocument ? BASE : url.pathname,
      'set-cookie': `${COOKIE}=${encodeURIComponent(cfg.token)}; Path=${BASE}; HttpOnly; SameSite=Strict; Max-Age=604800`,
    });
    res.end();
    return;
  }

  if (rel === 'api/info') {
    /** @type {ServerInfo} */
    const info = {
      shell: cfg.shell,
      cwd: cfg.cwd,
      readOnly: cfg.readOnly,
      maxSessions: cfg.maxSessions,
      host: os.hostname(),
    };
    sendJson(res, 200, info);
    return;
  }

  // A path the manifest publishes maps to its file; anything else is looked up
  // by name, so manifest.json and an unbuilt dist/ still answer.
  const wanted = manifest.routes.get(rel) ?? (rel === '' ? 'index.html' : rel);
  const file = path.join(staticDir, wanted);
  if (file !== staticDir && !file.startsWith(staticDir + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }
  sendFile(res, wanted);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (relativePath(url.pathname) !== 'ws' || !authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
});

/**
 * @param {WebSocket} ws
 * @param {ServerMessage} message
 */
function send(ws, message) {
  ws.send(JSON.stringify(message));
}

wss.on('connection', (
  /** @type {WebSocket & { isAlive?: boolean }} */ ws,
  /** @type {http.IncomingMessage} */ _req,
  /** @type {URL} */ url,
) => {
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;

  let session = store.get(url.searchParams.get('id'));
  const resumed = session !== undefined;

  if (!session) {
    try {
      session = store.create({ cols, rows });
    } catch (err) {
      send(ws, { type: 'error', message: /** @type {Error} */ (err).message });
      ws.close(4003, 'session limit');
      return;
    }
  }
  const active = session;

  store.attach(active, ws);
  send(ws, {
    type: 'ready',
    id: active.id,
    resumed,
    readOnly: cfg.readOnly,
    cols: active.cols,
    rows: active.rows,
  });
  if (resumed) {
    store.replay(active, ws);
    store.resize(active, cols, rows);
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (/** @type {Buffer} */ raw, /** @type {boolean} */ isBinary) => {
    if (isBinary) {
      store.write(active, raw);
      return;
    }
    /** @type {ClientMessage} */
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'input':
        store.write(active, String(msg.data ?? ''));
        break;
      case 'resize':
        store.resize(active, Math.trunc(msg.cols), Math.trunc(msg.rows));
        break;
      case 'close':
        store.destroy(active.id);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => store.detach(active, ws));
  ws.on('error', () => store.detach(active, ws));
});

// Drop half-open connections so their sessions enter the reap grace period.
const heartbeat = setInterval(() => {
  for (const client of /** @type {Set<WebSocket & { isAlive?: boolean }>} */ (wss.clients)) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30_000);
heartbeat.unref();

server.listen(cfg.port, cfg.host, () => {
  const address = server.address();
  const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address);
  process.stdout.write(`webconsole listening on ${where}\n`);
  process.stdout.write(`  shell: ${cfg.shell}   cwd: ${cfg.cwd}\n`);
  if (BASE !== '/') {
    const from = cfg.base ? '--base-url' : path.join(staticDir, 'manifest.json');
    process.stdout.write(`  mounted at ${BASE} (from ${from})\n`);
  }
  if (manifest.types.size === 0) {
    process.stdout.write(`  WARNING: no manifest.json in ${staticDir}; run \`npm run build\` first\n`);
  }
  if (!cfg.auth) {
    process.stdout.write('  WARNING: --no-token is set, anyone who can reach this port gets a shell\n');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
    process.stdout.write(`  WARNING: bound to ${cfg.host}; this port is a remote shell, put it behind TLS/a tunnel\n`);
  }
  process.stdout.write(`\n  open: ${localUrl(cfg, BASE)}\n\n`);
});

function shutdown() {
  store.destroyAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
