#!/usr/bin/env node

/* Wrapper around `vite build` that adds --base-url, so the client can be built
 * for a sub-path (`/console/`) instead of the site root. The chosen base is
 * recorded in dist/manifest.json, which is where the server picks it up. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

import { normalizeBase } from './base-url.mjs';

export { normalizeBase };

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage() {
  return `webconsole build - bundle the browser client into dist/

Usage: npm run build --base-url=console
       npm run build -- --base-url /console/    (equivalent)

Options:
      --base-url <path>  Public path the client is served under, e.g. /console/
                         (default /). May also be an absolute URL if the assets
                         are hosted elsewhere; the app itself then stays at /.
      --out-dir <dir>    Write the build here instead of dist/
  -h, --help             Show this help

Flags placed before \`--\` are consumed by npm, which forwards them as
npm_config_* environment variables; both spellings are read here.
`;
}

/**
 * `npm run build --base-url=console` never reaches process.argv: npm treats the
 * flag as its own config and passes it down as npm_config_base_url.
 * @param {string} name
 * @returns {string | undefined}
 */
function fromNpmConfig(name) {
  const value = process.env[`npm_config_${name}`];
  if (value === undefined || value === '') return undefined;
  const flag = `--${name.replace(/_/g, '-')}`;
  if (value === 'true' || value === 'false') {
    throw new Error(`${flag} needs a value, e.g. ${flag}=/console/`);
  }
  return value;
}

/**
 * @param {string[]} argv
 * @returns {{ base?: string, outDir?: string }}
 */
function parseArgs(argv) {
  /** @type {{ base?: string, outDir?: string }} */
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      const found = inline ?? argv[++i];
      if (found === undefined || found === '') throw new Error(`missing value for ${flag}`);
      return found;
    };
    switch (flag) {
      case '--base-url': case '--base': opts.base = value(); break;
      case '--out-dir': opts.outDir = value(); break;
      case '-h': case '--help': process.stdout.write(usage()); process.exit(0);
      default:
        throw new Error(`unknown option: ${flag}\n\n${usage()}`);
    }
  }
  return opts;
}

/**
 * Command line wins over the npm_config_* fallback.
 * @param {string[]} argv
 * @returns {{ base?: string, outDir?: string }}
 */
function resolveOptions(argv) {
  const cli = parseArgs(argv);
  const base = cli.base ?? fromNpmConfig('base_url');
  const outDir = cli.outDir ?? fromNpmConfig('out_dir');
  return {
    ...(base === undefined ? {} : { base: normalizeBase(base) }),
    ...(outDir === undefined ? {} : { outDir: path.resolve(outDir) }),
  };
}

async function main() {
  const opts = resolveOptions(process.argv.slice(2));
  await build({
    configFile: path.join(ROOT, 'vite.config.mts'),
    root: path.join(ROOT, 'src'),
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.outDir ? { build: { outDir: opts.outDir } } : {}),
  });
}

// Guarded so the test suite can import normalizeBase without running a build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((/** @type {Error} */ err) => {
    process.stderr.write(`build failed: ${err.message}\n`);
    process.exit(1);
  });
}
