'use strict';

const os = require('node:os');
const crypto = require('node:crypto');

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} shell
 * @property {string} cwd
 * @property {string | null} token   null when auth is disabled via --no-token
 * @property {boolean} auth
 * @property {number} maxSessions
 * @property {number} idleTimeout    seconds a detached session survives
 * @property {boolean} readOnly
 * @property {string | null} staticDir  where the built client lives
 * @property {string | null} base  mount point, overriding the built client's own
 */

/** @returns {string} */
function usage() {
  return `webconsole - browser terminal, commands execute on the server

Usage: webconsole [options]
       npm start -- [options]
       npm start --port=8080 --start-dir=/srv     (npm-style, see below)

Options:
  -p, --port <n>        Port to listen on            (default 7681, env WEBCONSOLE_PORT)
  -H, --host <addr>     Address to bind              (default 127.0.0.1, env WEBCONSOLE_HOST)
      --shell <path>    Shell to spawn               (default $SHELL or /bin/bash)
      --cwd <path>      Directory the shell starts in (default process cwd)
      --start-dir <path>  Same as --cwd; use this one in the npm-style form
      --token <str>     Fixed access token           (default: random per start)
      --access-token <str>  Same as --token; use this one in the npm-style form
      --no-token        Disable auth (DANGEROUS)
      --max-sessions <n>  Concurrent terminals       (default 10)
      --idle-timeout <s>  Keep a detached session alive this long (default 600, 0 = kill at once)
      --read-only       Ignore keyboard input, output only
      --static <dir>    Serve the built client from here (default dist/)
      --base-url <path>  Mount the API and the shell socket here instead of the
                        base the client was built for; \`npm run dev --base-url=/123\`
                        passes the same value to Vite
  -h, --help            Show this help

Flags placed before \`--\` are consumed by npm, which forwards them as npm_config_*
environment variables; those are read here too. npm keeps \`--cwd\` and \`--token\`
for itself, so the npm-style form needs --start-dir and --access-token instead.
\`--no-token\` never survives npm: use \`npm start -- --no-token\` or
WEBCONSOLE_NO_TOKEN=1.
`;
}

/**
 * `123`, `/123` and `/123/` all name the same mount, as in scripts/build.mjs.
 * @param {string} value
 * @returns {string}
 */
function normalizeBase(value) {
  return `/${value}/`.replace(/\/{2,}/g, '/');
}

/**
 * Flags before `--` never reach process.argv: `npm start --port=8080` arrives
 * as npm_config_port instead.
 * @param {string} flag
 * @returns {string | undefined}
 */
function npmConfig(flag) {
  const value = process.env[`npm_config_${flag.replace(/-/g, '_')}`];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Only the options actually present on the command line.
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    /** @returns {string} */
    const value = () => {
      const found = inline ?? argv[++i];
      if (found === undefined || found === '') throw new Error(`missing value for ${flag}`);
      return found;
    };
    switch (flag) {
      case '-p': case '--port': out.port = value(); break;
      case '-H': case '--host': out.host = value(); break;
      case '--shell': out.shell = value(); break;
      case '--cwd': case '--start-dir': out.cwd = value(); break;
      case '--token': case '--access-token': out.token = value(); break;
      case '--no-token': out.noToken = true; break;
      case '--max-sessions': out.maxSessions = value(); break;
      case '--idle-timeout': out.idleTimeout = value(); break;
      case '--read-only': out.readOnly = true; break;
      case '--static': out.staticDir = value(); break;
      case '--base-url': case '--base': out.base = value(); break;
      case '-h': case '--help': process.stdout.write(usage()); process.exit(0);
      default:
        throw new Error(`unknown option: ${flag}\n\n${usage()}`);
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {Config}
 */
function parse(argv) {
  const cli = parseArgs(argv);

  /**
   * Command line first, then the npm-style flag, then the environment.
   * @param {string} key       name in the parsed argv
   * @param {string} npmFlag   npm-style spelling, read from npm_config_*
   * @param {string} envName   WEBCONSOLE_* variable
   * @returns {string | undefined}
   */
  const text = (key, npmFlag, envName) => {
    const value = cli[key];
    if (typeof value === 'string') return value;
    return npmConfig(npmFlag) ?? (process.env[envName] || undefined);
  };

  /**
   * @param {string} key
   * @param {string} npmFlag
   * @param {string} envName
   * @returns {boolean}
   */
  const flag = (key, npmFlag, envName) =>
    cli[key] === true || npmConfig(npmFlag) === 'true' || process.env[envName] === '1';

  /** @type {Config} */
  const cfg = {
    port: Number(text('port', 'port', 'WEBCONSOLE_PORT') ?? 7681),
    host: text('host', 'host', 'WEBCONSOLE_HOST') ?? '127.0.0.1',
    shell: text('shell', 'shell', 'WEBCONSOLE_SHELL') ?? process.env.SHELL ?? '/bin/bash',
    cwd: text('cwd', 'start-dir', 'WEBCONSOLE_CWD') ?? process.cwd(),
    token: text('token', 'access-token', 'WEBCONSOLE_TOKEN') ?? null,
    auth: !flag('noToken', 'no-token', 'WEBCONSOLE_NO_TOKEN'),
    maxSessions: Number(text('maxSessions', 'max-sessions', 'WEBCONSOLE_MAX_SESSIONS') ?? 10),
    idleTimeout: Number(text('idleTimeout', 'idle-timeout', 'WEBCONSOLE_IDLE_TIMEOUT') ?? 600),
    readOnly: flag('readOnly', 'read-only', 'WEBCONSOLE_READ_ONLY'),
    staticDir: text('staticDir', 'static', 'WEBCONSOLE_STATIC') ?? null,
    base: null,
  };

  // The client is built for a base and records it in its manifest; this is for
  // dev, where Vite serves the client and nothing has been built yet.
  const base = text('base', 'base-url', 'WEBCONSOLE_BASE_URL');
  if (base !== undefined) cfg.base = normalizeBase(base);

  for (const key of ['port', 'maxSessions', 'idleTimeout']) {
    if (!Number.isFinite(cfg[/** @type {'port' | 'maxSessions' | 'idleTimeout'} */ (key)])) {
      throw new Error(`invalid --${key}: not a number`);
    }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new Error(`invalid port: ${cfg.port}`);
  }
  if (cfg.maxSessions < 1) throw new Error('--max-sessions must be at least 1');

  cfg.token = cfg.auth ? cfg.token || crypto.randomBytes(24).toString('base64url') : null;
  return cfg;
}

/**
 * The URL printed at startup. Loading `index.html` with the token attached
 * trades it for a cookie and redirects to the clean path.
 * @param {Config} cfg
 * @param {string} [mount] public path the client is served under, e.g. `/console/`
 * @returns {string}
 */
function localUrl(cfg, mount = '/') {
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? os.hostname() : cfg.host;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}${mount}`;
  return cfg.token ? `${base}index.html?token=${cfg.token}` : base;
}

module.exports = { parse, usage, localUrl };
