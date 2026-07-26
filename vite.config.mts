import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

import { normalizeBase } from './scripts/base-url.mjs';

/** Matches the token `npm run dev` starts the API server with. */
const DEV_TOKEN = process.env.WEBCONSOLE_TOKEN ?? 'dev';
const API_TARGET = process.env.WEBCONSOLE_DEV_TARGET ?? 'http://127.0.0.1:7681';
const DEV_PORT = Number(process.env.WEBCONSOLE_DEV_PORT ?? 5173);
/** Where the console is mounted while `npm run dev` is running. A build passes
 *  its own base in, so this is only consulted by the dev server — which npm
 *  hands the same `npm run dev --base-url=/123` flag the build understands. */
const BASE = normalizeBase(
  process.env.WEBCONSOLE_BASE_URL ?? process.env.npm_config_base_url ?? process.env.WEBCONSOLE_BASE ?? '/',
);

const MANIFEST = 'manifest.json';

/** Human-facing name of this app in a catalog of them. */
const TITLE = 'Console';

/** Content types for everything the build can emit; recorded in the manifest
 *  so the server can answer with them without a table of its own. */
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** What the manifest and the page footer say about the build. Resolved from
 *  beside this config rather than from the working directory, so it reads the
 *  same whoever starts the build. Read at build time: editing package.json
 *  changes the next build's manifest and the footer's link. */
function packageInfo(): { name: string; version: string; description: string; homepage: string } {
  const file = fileURLToPath(new URL('package.json', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const name = pkg.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${file} has no "name" field`);
  }
  return {
    name,
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
  };
}

const PKG = packageInfo();

/** The dev server serves `/` itself, so print the URL that picks up a cookie. */
function devUrlHint(): Plugin {
  return {
    name: 'webconsole:dev-url-hint',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        setTimeout(() => {
          server.config.logger.info(
            `\n  webconsole  open:  http://localhost:${DEV_PORT}${server.config.base}index.html?token=${DEV_TOKEN}\n` +
            `              api:   ${API_TARGET}\n`,
          );
        }, 50);
      });
    },
  };
}

/** Every emitted file, as posix-style paths relative to `dir`. */
function walk(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** The URL a document is served at: no `.html`, and `index.html` is the
 *  directory itself. `about.html` -> `<base>about`, `a/index.html` -> `<base>a/`. */
function documentUrl(base: string, file: string): string {
  const clean = file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
  return base + clean;
}

/**
 * Writes dist/manifest.json describing the build: which URL serves which file,
 * with which content type, plus the catalog entry a host uses to list this app.
 * Replaces Vite's own manifest, which is keyed by source path and says nothing
 * about content types.
 */
function buildManifest(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'webconsole:manifest',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir);
      const files = walk(outDir)
        .filter((file) => file !== MANIFEST)
        .sort()
        .map((file) => ({
          url: file.endsWith('.html') ? documentUrl(config.base, file) : config.base + file,
          file,
          type: mimeFor(file),
        }));

      const urlOf = (name: RegExp) => files.find((file) => name.test(file.file))?.url;
      const icon = urlOf(/^favicon.*\.svg$/);
      const light = urlOf(/^screenshot-light.*\.png$/);
      const dark = urlOf(/^screenshot-dark.*\.png$/);

      const manifest = {
        name: PKG.name,
        base: config.base,
        entries: [{
          title: TITLE,
          version: PKG.version,
          description: PKG.description,
          main: config.base,
          ...(icon ? { icons: [
            { url: icon, colorScheme: 'light' },
            { url: icon, colorScheme: 'dark' },
          ] } : {}),
          ...(light && dark ? { screenshots: [
            { url: light, colorScheme: 'light' },
            { url: dark, colorScheme: 'dark' },
          ] } : {}),
        }],
        files,
      };

      fs.writeFileSync(path.join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      config.logger.info(`  ${MANIFEST}  ${manifest.files.length} files`);
    },
  };
}

export default defineConfig({
  root: 'src',
  base: BASE,
  plugins: [devUrlHint(), buildManifest()],
  define: {
    // What the header and the footer say about this build. The homepage is
    // empty when package.json has none, and the footer then leaves the link
    // out altogether.
    __TITLE__: JSON.stringify(TITLE),
    __HOMEPAGE__: JSON.stringify(PKG.homepage),
  },
  build: {
    // dist/ holds the client bundle and nothing else — the server is plain JS
    // at the project root and is never compiled into it.
    outDir: '../dist',
    // Flat output: the hashed files sit next to index.html, no assets/ level.
    assetsDir: '',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // Everything stateful lives on the Node server; Vite only serves the shell.
    // The server mounts its routes under the same base, so proxy them there.
    proxy: {
      [`${BASE}api`]: { target: API_TARGET },
      [`${BASE}ws`]: { target: API_TARGET, ws: true },
      // index.html is Vite's to serve, except when it carries a token: that
      // request has to reach the server to come back with the cookie.
      [`${BASE}index.html`]: {
        target: API_TARGET,
        bypass: (req) => (req.url?.includes('token=') ? undefined : req.url),
      },
    },
  },
});
