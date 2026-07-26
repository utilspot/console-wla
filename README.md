# webconsole

A terminal in the browser. Every keystroke goes to a real PTY on the server, so
what you get is an actual login shell — job control, colors, `top`, `vim`,
`ssh`, tab completion — not a request/response command runner.

The server is plain JavaScript and runs straight from source — no build step, no
transpiler in the request path. The client is TypeScript bundled by Vite. Both
sides share one set of websocket protocol types.

![Three consoles on one webconsole page: a colour `ls -l` filling the left half,
`top` in the upper right and `git log` / `git status` in the lower
right](docs/screenshot.png)

*One page, three shells. `Ctrl+Shift+T` split the window in half, `Ctrl+Shift+D`
split the right half again; each pane is its own PTY, sized to its share of the
screen.*

```
npm install
npm run build   # builds the client into dist/
npm start
```

The server prints the URL to open, with a one-time token in it:

```
webconsole listening on 127.0.0.1:7681
  shell: /bin/bash   cwd: /opt/work/source/webconsole

  open: http://127.0.0.1:7681/index.html?token=Xk3v...
```

## How it works

```
browser (xterm.js)  ──websocket──▶  node server  ──▶  node-pty  ──▶  /bin/bash
      keystrokes                    session store       pty          your box
      ◀── screen bytes ─────────────────────────────────────────────────
```

Nothing is executed in the browser and no command list is interpreted anywhere:
the client is a dumb screen, the shell on the server does all the work.

```
server.js       HTTP (static + auth) and the /ws upgrade handler
sessions.js     owns the PTY processes, one per terminal pane
config.js       flags and environment
src/            the browser client, bundled by Vite
  index.html
  main.ts       renders the split tree, keyboard shortcuts
  layout.ts     the split tree itself: rows, columns, sizes
  pane.ts       one xterm.js screen bound to one server session
  theme.ts      palette, kept in sync with style.css
  protocol.ts   websocket message types, used by both sides
scripts/        build.mjs   vite build wrapper, adds --base-url and --out-dir
test/           smoke.js    end-to-end suite against the running server
dist/           index.html, the hashed bundle, manifest.json   (flat, nothing else)
```

`npm run build` runs Vite only; the server is never compiled into `dist/`.
Alongside the bundle it writes a `manifest.json` describing what to serve where:

```json
{
  "description": "Build output of the webconsole browser client. …",
  "base": "/",
  "files": [
    { "url": "/index-CmEUnyBs.js", "file": "index-CmEUnyBs.js",
      "type": "text/javascript", "entry": false, "bytes": 350974 },
    { "url": "/index.html", "file": "index.html",
      "type": "text/html", "entry": true, "bytes": 1336 }
  ]
}
```

`entry` marks the document a browser loads directly; everything else is pulled in
by it and sits beside it — the build has no subdirectories. Filenames are
content-hashed, so anything fronting this build should read them from here
instead of hard-coding them, and may pin them forever.

The server reads this file at startup and serves the bundle exactly as described:
`base` decides where it mounts, and `type` becomes the `content-type` header. The
MIME table lives in [`vite.config.mts`](vite.config.mts) alone — the server has no
table of its own to drift out of sync.

### Serving under a sub-path

```
npm run build --base-url=/console
npm start
# open: http://127.0.0.1:7681/console/index.html?token=...
```

Written that way the flag is consumed by npm rather than the script, and arrives
as `npm_config_base_url`; the build reads both that and a real argument, so
`npm run build -- --base-url /console/` does the same thing. (npm warns
`Unknown cli config "--base-url"` about the first form and says it will stop
working in a future major version — the `--` form is the durable one.)

`--base-url` (`console`, `/console` and `/console/` all work) bakes the public
path into the bundle and records it as `base` in the manifest. The server reads
it back at startup and mounts everything there — the page, its assets,
`/console/index.html`, `/console/api/info` and the `/console/ws` websocket — with
`/` redirecting to the base. The client finds its own URLs through
`import.meta.env.BASE_URL`, so nothing is hard-coded on either side.

An absolute `--base-url https://cdn.example.com/app/` is also accepted, for
hosting the assets elsewhere; the app itself then still serves from `/`.
`--out-dir <dir>` writes the build somewhere other than `dist/`, which pairs with
the server's `--static`. Run `npm run build -- --help` for the list.

```
npm run build --base-url=console --out-dir=/srv/webconsole
npm start -- --static /srv/webconsole
```

The server is JS but still typechecked: it declares its types with JSDoc and
pulls the wire format from [`src/protocol.ts`](src/protocol.ts) via `import()`
types, so `npm run typecheck` catches a protocol change on both sides even though
nothing is transpiled.

## Development

```
npm run dev
```

Runs the API server under `node --watch` on :7681 and the Vite dev server on
:5173, which proxies `/api` and `/ws` (websockets included) to it, plus
`/index.html` when — and only when — it carries a token, so Vite keeps serving
the page itself with HMR. Client edits hot-reload; server edits restart the
process. Open the URL Vite prints:

```
http://localhost:5173/index.html?token=dev
```

`npm run typecheck` checks both sides: `tsconfig.json` covers the Node code with
`checkJs`, `tsconfig.client.json` the DOM code.

## Features

- **Real PTY** per pane, sized to its share of the window (`SIGWINCH` on resize).
- **Split screen, no tabs.** A second console splits the focused one in half and
  both stay on screen. Splits nest either way, to any depth:
  `Ctrl+Shift+T` splits to the right, `Ctrl+Shift+D` splits downwards,
  `Ctrl+Shift+W` closes, and `Ctrl+Shift+←/→/↑/↓` moves the focus to the nearest
  console that way. Drag any seam to rebalance the two consoles it separates,
  double-click it to even that row or column out. Closing a console gives its
  room back to its neighbours, and a row or column left holding one console
  folds away.
- **No chrome around the splits.** There is no toolbar and no titles: each pane
  has a 24px header holding a connection dot and its own `A-` `A+` and two split
  buttons, with `×` on the far right. The shell's title is the header's tooltip.
- **Nothing is stored in the browser.** No localStorage, no layout on disk: a
  page load always starts at exactly one console on a fresh session, and the
  splits and sizes live only as long as the page does.
- **Survives a dropped connection.** Sessions outlive the websocket, so a network
  blip reconnects with backoff and replays the last 256 KB of output; a detached
  session is reaped after `--idle-timeout`.
- **Copy/paste** with `Ctrl+Shift+C` / `Ctrl+Shift+V`.
- **Font size** per pane; the last size set is what the next pane in that page
  opens at, and it resets on reload.
- No CDN: xterm.js is bundled into the build, so this runs on an air-gapped host.

## Options

| Flag | Env | Default | |
|---|---|---|---|
| `-p, --port` | `WEBCONSOLE_PORT` | `7681` | |
| `-H, --host` | `WEBCONSOLE_HOST` | `127.0.0.1` | |
| `--shell` | `WEBCONSOLE_SHELL` | `$SHELL` | shell to spawn |
| `--cwd`, `--start-dir` | `WEBCONSOLE_CWD` | cwd | directory the shell starts in |
| `--token`, `--access-token` | `WEBCONSOLE_TOKEN` | random | fixed token instead of a fresh one per start |
| `--no-token` | `WEBCONSOLE_NO_TOKEN=1` | off | disable auth entirely |
| `--max-sessions` | `WEBCONSOLE_MAX_SESSIONS` | `10` | concurrent terminals |
| `--idle-timeout` | `WEBCONSOLE_IDLE_TIMEOUT` | `600` | seconds a detached session stays alive; `0` kills it immediately |
| `--read-only` | `WEBCONSOLE_READ_ONLY=1` | off | stream output, ignore input |
| `--static` | `WEBCONSOLE_STATIC` | `dist` | where the built client lives |

Options can be passed three ways:

```
node server.js --cwd /home/develop --port 8080     # directly
npm start -- --cwd /home/develop --port 8080       # through npm, after --
npm start --start-dir=/home/develop --port=8080    # npm-style, before --
WEBCONSOLE_CWD=/home/develop npm start             # environment
```

The third form never reaches the script as an argument — npm consumes it and
re-exports it as `npm_config_*`, which the server reads. Two names have to differ
there because npm claims them for itself: use **`--start-dir`** instead of
`--cwd` (npm errors out on `--cwd` before the script runs) and **`--access-token`**
instead of `--token` (npm expands it to `--token-description`). `--no-token`
cannot survive npm at all, so use the `--` form or `WEBCONSOLE_NO_TOKEN=1`. npm
also warns `Unknown cli config` for the others and says it will stop working in a
future major version, so the `--` form is the durable one.

Precedence is argument → npm-style flag → environment variable → default.

## Security

**This is a remote shell.** Whoever loads the page runs commands as the user
that started the server, with that user's full permissions.

The defaults are deliberately narrow: it binds to `127.0.0.1` only, and requires
a 192-bit random token, which loading `index.html?token=…` trades for an
`HttpOnly`, `SameSite=Strict` cookie scoped to the base path. Both HTTP requests
and websocket upgrades are checked, and the comparison is constant-time.

If you expose it beyond localhost:

- Put it behind TLS (a reverse proxy or `ssh -L` tunnel). The token and every
  keystroke travel in cleartext over plain HTTP.
- Prefer an SSH tunnel: `ssh -N -L 7681:127.0.0.1:7681 user@host`, then browse to
  localhost. That keeps the listener private and gets you real authentication.
- Run it as a dedicated low-privilege user, not root.
- `--no-token` hands a shell to anyone who can reach the port. Only use it when
  something else in front is doing the authentication.

## Tests

```
npm test
```

Builds the client, then boots the real server on an ephemeral port and checks
auth (missing, wrong, and the `index.html?token=` cookie exchange), that the Vite bundle is
served, that every file in `manifest.json` is reachable at its `url` with the
declared `type` and `bytes` and that the manifest covers `dist/` exactly,
path-traversal rejection, that a command actually runs in a PTY and streams back,
that the shell sees a real tty at the requested width, and that re-attaching
replays scrollback. It then builds again with `--base-url` into a temp directory
and repeats the page, asset, auth, API and websocket checks under that base.
