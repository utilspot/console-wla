import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { FONT_STACK, THEME } from './theme';
import type { Direction } from './layout';
import type { ClientMessage, ServerMessage } from './protocol';

export type PaneState = 'connecting' | 'open' | 'lost' | 'dead';

export const FONT_RANGE = { min: 9, max: 28 } as const;

export function clampFont(size: number): number {
  return Math.max(FONT_RANGE.min, Math.min(FONT_RANGE.max, Math.round(size)));
}

/** What a pane needs from whoever is managing the split layout. */
export interface PaneHost {
  isActive(pane: TerminalPane): boolean;
  /** Name shown before the shell reports a title of its own. */
  fallbackLabel(pane: TerminalPane): string;
  activate(pane: TerminalPane): void;
  /** Splits this pane in half — beside it or below it — and starts a shell there. */
  requestSplit(pane: TerminalPane, dir: Direction): void;
  requestClose(pane: TerminalPane): void;
  /** Remembers a font size as the one panes opened later start at. */
  rememberFontSize(size: number): void;
  toast(message: string): void;
}

const MAX_RETRIES = 6;
/** Ctrl+Shift chords that main.ts handles, not the shell. */
const LAYOUT_KEYS = new Set(['t', 'd', 'w', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown']);

/** Two boxes, the second one dimmed: what the split buttons draw. */
const SPLIT_ICON: Record<Direction, string> = {
  row: '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden="true">'
    + '<rect x="0" y="1" width="5" height="10" rx="1"/>'
    + '<rect x="7" y="1" width="5" height="10" rx="1" opacity=".45"/></svg>',
  column: '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden="true">'
    + '<rect x="1" y="0" width="10" height="5" rx="1"/>'
    + '<rect x="1" y="7" width="10" height="5" rx="1" opacity=".45"/></svg>',
};

/** One split of the screen: an xterm.js screen bound to one server PTY. */
export class TerminalPane {
  /** Server session id; null until the first `ready` message arrives. */
  id: string | null;
  state: PaneState = 'connecting';

  /** Root element, placed in the split layout by the host. */
  readonly pane: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly host: PaneHost;
  private readonly screen: HTMLDivElement;
  private headEl!: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayText: HTMLParagraphElement;
  private readonly overlayButton: HTMLButtonElement;

  private ws: WebSocket | null = null;
  private retryTimer: number | undefined;
  private attempts = 0;
  private title = '';
  private fontSize: number;
  private closing = false;
  private exited = false;

  constructor(host: PaneHost, id: string | null, fontSize: number) {
    this.host = host;
    this.id = id;
    this.fontSize = clampFont(fontSize);

    this.pane = document.createElement('div');
    this.pane.className = 'pane';
    this.pane.append(this.buildHeader());

    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.pane.append(this.screen);

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.overlay.hidden = true;
    this.overlayText = document.createElement('p');
    this.overlayButton = document.createElement('button');
    this.overlayButton.type = 'button';
    this.overlayButton.textContent = 'Reconnect';
    this.overlayButton.addEventListener('click', () => this.connect());
    this.overlay.append(this.overlayText, this.overlayButton);

    // Clicking or tabbing anywhere in the pane makes it the one shortcuts act on.
    this.pane.addEventListener('pointerdown', () => this.host.activate(this));
    this.pane.addEventListener('focusin', () => this.host.activate(this));

    this.term = new Terminal({
      fontSize: this.fontSize,
      fontFamily: FONT_STACK,
      theme: THEME,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.screen);
    this.screen.append(this.overlay);

    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onBinary((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    this.term.onTitleChange((title) => {
      this.title = title;
      this.render();
    });
    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));

    this.render();
    this.connect();
  }

  private buildHeader(): HTMLDivElement {
    const head = document.createElement('div');
    head.className = 'pane-head';
    head.innerHTML = '<span class="dot"></span>';
    this.headEl = head;
    head.append(
      this.headButton('A-', 'Smaller text', () => this.bumpFontSize(-1)),
      this.headButton('A+', 'Larger text', () => this.bumpFontSize(1)),
      this.iconButton('row', 'Split to the right (Ctrl+Shift+T)'),
      this.iconButton('column', 'Split downwards (Ctrl+Shift+D)'),
      this.headButton('\u00d7', 'Close terminal (Ctrl+Shift+W)', () => this.host.requestClose(this), 'close'),
    );
    return head;
  }

  private iconButton(dir: Direction, title: string): HTMLButtonElement {
    const button = this.headButton('', title, () => this.host.requestSplit(this, dir));
    button.innerHTML = SPLIT_ICON[dir];
    return button;
  }

  private headButton(text: string, title: string, onClick: () => void, extra = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `head-btn ${extra}`.trim();
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
    const key = event.key.toLowerCase();
    if (key === 'c' && this.term.hasSelection()) {
      void navigator.clipboard.writeText(this.term.getSelection())
        .then(() => this.host.toast('Copied'))
        .catch(() => this.host.toast('Clipboard blocked by the browser'));
      return false;
    }
    if (key === 'v') {
      void navigator.clipboard.readText()
        .then((text) => this.send({ type: 'input', data: text }))
        .catch(() => this.host.toast('Clipboard blocked by the browser'));
      return false;
    }
    // Splitting, closing and moving the focus belong to the layout: returning
    // false keeps xterm from swallowing the key, so it reaches the window.
    if (LAYOUT_KEYS.has(key)) return false;
    return true;
  }

  render(): void {
    // The header carries no text: which shell this is lives in its tooltip.
    this.headEl.title = this.title || this.host.fallbackLabel(this);
    this.pane.dataset.state = this.state;
    this.pane.classList.toggle('active', this.host.isActive(this));
  }

  private setState(state: PaneState, message?: string): void {
    this.state = state;
    if (state === 'open') {
      this.overlay.hidden = true;
    } else if (message) {
      this.overlayText.innerHTML = message;
      this.overlayButton.hidden = state === 'dead';
      this.overlay.hidden = false;
    }
    this.render();
  }

  /** Where this console's shell lives.
   *
   *  BASE_URL is the --base-url the client was built with; the server mounts
   *  its routes under the same prefix. */
  private socketUrl(id: string | null): URL {
    const url = new URL(`${import.meta.env.BASE_URL}ws`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (id) url.searchParams.set('id', id);
    url.searchParams.set('cols', String(this.term.cols));
    url.searchParams.set('rows', String(this.term.rows));
    return url;
  }

  connect(): void {
    window.clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    this.setState('connecting', '<strong>Connecting…</strong>');

    const ws = new WebSocket(this.socketUrl(this.id));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.send(this.attachMessage());

    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') {
        this.term.write(new Uint8Array(event.data));
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.onControlMessage(msg);
    };

    ws.onclose = (event) => {
      if (this.closing || this.exited) return;
      if (event.code === 4001) {
        this.setState('lost', '<strong>Taken over</strong><br>This session is attached in another window.');
        return;
      }
      this.setState('lost', '<strong>Disconnected</strong><br>The shell keeps running on the server.');
      const delay = Math.min(1000 * 2 ** this.attempts++, 15_000);
      if (this.attempts <= MAX_RETRIES) {
        this.retryTimer = window.setTimeout(() => this.connect(), delay);
      }
    };
  }

  private onControlMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready': {
        this.attempts = 0;
        this.id = msg.id;
        if (!msg.resumed) this.term.reset();
        this.setState('open');
        this.resize();
        break;
      }
      case 'exit': {
        this.exited = true;
        const how = msg.signal ? `signal ${msg.signal}` : `exit code ${msg.exitCode}`;
        this.setState('dead', `<strong>Shell exited</strong> (${how})`);
        break;
      }
      case 'error':
        this.setState('dead', `<strong>${msg.message}</strong>`);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Every pane is on screen at once, so each one fits itself. */
  resize(): void {
    if (!this.screen.clientWidth || !this.screen.clientHeight) return;
    try {
      this.fit.fit();
    } catch {
      // the pane has not been laid out yet
    }
  }

  /** Font size of this console, in pixels. */
  get font(): number {
    return this.fontSize;
  }

  setFontSize(size: number): void {
    this.fontSize = clampFont(size);
    this.term.options.fontSize = this.fontSize;
    this.resize();
  }

  /** A+ / A- in this pane's header: the size is this pane's alone. */
  bumpFontSize(delta: number): void {
    this.setFontSize(this.fontSize + delta);
    this.host.rememberFontSize(this.fontSize);
    this.focus();
  }

  focus(): void {
    this.term.focus();
  }

  /** Kills the server-side session and tears down the DOM. */
  dispose(): void {
    this.closing = true;
    window.clearTimeout(this.retryTimer);
    this.closeConnection();
    this.pane.remove();
    this.term.dispose();
  }

  /**
   * Ends the session on the server whatever state the socket is in. A console
   * closed while it is still connecting — or while it sits between reconnect
   * attempts — would otherwise leave its shell running, holding one of the
   * server's session slots until the idle reaper gets to it.
   */
  private closeConnection(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      this.closeFromNewSocket();
      return;
    }
    ws.onclose = null;
    ws.onmessage = null;

    switch (ws.readyState) {
      case WebSocket.OPEN:
        ws.send(JSON.stringify({ type: 'close' } satisfies ClientMessage));
        ws.close();
        break;
      case WebSocket.CONNECTING:
        // The server is spawning the shell right now: say goodbye as soon as
        // the handshake lands, and fall back if it never does.
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'close' } satisfies ClientMessage));
          ws.close();
        };
        ws.onerror = () => this.closeFromNewSocket();
        break;
      default:
        // Closing or already closed: this socket can carry nothing any more.
        ws.close();
        this.closeFromNewSocket();
        break;
    }
  }

  /**
   * Last resort for a console whose socket has already dropped: a throwaway
   * connection whose only job is to carry the close request for the shell that
   * is still running under this pane's session id.
   */
  private closeFromNewSocket(): void {
    if (!this.id || this.exited) return;
    // Read off the terminal now: `dispose` takes it apart right after this.
    const attach = this.attachMessage();
    const ws = new WebSocket(this.socketUrl(this.id));
    ws.onopen = () => {
      ws.send(JSON.stringify(attach));
      ws.send(JSON.stringify({ type: 'close' } satisfies ClientMessage));
      ws.close();
    };
    ws.onerror = () => { /* the server is unreachable; so is its session */ };
  }

  /** Says which shell this console wants, for servers that cannot read the
   *  query string of the upgrade request. */
  private attachMessage(): ClientMessage {
    return { type: 'attach', id: this.id, cols: this.term.cols, rows: this.term.rows };
  }
}
