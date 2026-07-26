'use strict';

const crypto = require('node:crypto');
const pty = require('node-pty');

/** @typedef {import('./config').Config} Config */
/** @typedef {import('ws').WebSocket} WebSocket */
/** @typedef {import('./src/protocol').ServerMessage} ServerMessage */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {import('node-pty').IPty} pty
 * @property {number} cols
 * @property {number} rows
 * @property {Buffer[]} buffer          recent output, replayed on re-attach
 * @property {number} bufferBytes
 * @property {WebSocket | null} socket
 * @property {NodeJS.Timeout | null} reapTimer
 * @property {number} createdAt
 * @property {boolean} exited
 */

const SCROLLBACK_BYTES = 256 * 1024;

/**
 * @param {WebSocket | null} socket
 * @param {ServerMessage} message
 */
function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Owns the server-side PTY processes. A session outlives the websocket that
 * created it, so a page reload re-attaches to the same shell instead of
 * dropping whatever was running.
 */
class SessionStore {
  /** @param {Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /** @returns {number} */
  get size() {
    return this.sessions.size;
  }

  /**
   * @param {{ cols?: number, rows?: number }} size
   * @returns {Session}
   */
  create({ cols, rows }) {
    if (this.sessions.size >= this.cfg.maxSessions) {
      throw new Error(`session limit reached (${this.cfg.maxSessions})`);
    }

    const id = crypto.randomBytes(9).toString('base64url');
    const child = pty.spawn(this.cfg.shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: this.cfg.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        WEBCONSOLE: '1',
      },
    });

    /** @type {Session} */
    const session = {
      id,
      pty: child,
      cols: cols || 80,
      rows: rows || 24,
      buffer: [],
      bufferBytes: 0,
      socket: null,
      reapTimer: null,
      createdAt: Date.now(),
      exited: false,
    };

    child.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      session.buffer.push(chunk);
      session.bufferBytes += chunk.length;
      while (session.bufferBytes > SCROLLBACK_BYTES && session.buffer.length > 1) {
        const dropped = session.buffer.shift();
        if (!dropped) break;
        session.bufferBytes -= dropped.length;
      }
      if (session.socket && session.socket.readyState === session.socket.OPEN) {
        session.socket.send(chunk);
      }
    });

    child.onExit(({ exitCode, signal }) => {
      session.exited = true;
      send(session.socket, { type: 'exit', exitCode, signal });
      if (session.socket) session.socket.close(1000, 'shell exited');
      this.destroy(id);
    });

    this.sessions.set(id, session);
    return session;
  }

  /**
   * @param {string | null | undefined} id
   * @returns {Session | undefined}
   */
  get(id) {
    return id ? this.sessions.get(id) : undefined;
  }

  /**
   * @param {Session} session
   * @param {WebSocket} socket
   */
  attach(session, socket) {
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }
    const previous = session.socket;
    session.socket = socket;
    if (previous && previous !== socket && previous.readyState === previous.OPEN) {
      previous.close(4001, 'session attached elsewhere');
    }
  }

  /**
   * Replayed so a reconnecting client sees the screen it left behind.
   * @param {Session} session
   * @param {WebSocket} socket
   */
  replay(session, socket) {
    for (const chunk of session.buffer) socket.send(chunk);
  }

  /**
   * @param {Session} session
   * @param {WebSocket} socket
   */
  detach(session, socket) {
    if (session.socket !== socket) return; // already replaced by a newer client
    session.socket = null;
    if (session.exited) return;
    if (this.cfg.idleTimeout <= 0) {
      this.destroy(session.id);
      return;
    }
    session.reapTimer = setTimeout(() => this.destroy(session.id), this.cfg.idleTimeout * 1000);
    session.reapTimer.unref();
  }

  /**
   * @param {Session} session
   * @param {string | Buffer} data
   */
  write(session, data) {
    if (this.cfg.readOnly || session.exited) return;
    session.pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  /**
   * @param {Session} session
   * @param {number} cols
   * @param {number} rows
   */
  resize(session, cols, rows) {
    if (session.exited || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    const nextCols = Math.max(2, Math.min(cols, 1000));
    const nextRows = Math.max(1, Math.min(rows, 500));
    if (nextCols === session.cols && nextRows === session.rows) return;
    session.cols = nextCols;
    session.rows = nextRows;
    try {
      session.pty.resize(nextCols, nextRows);
    } catch {
      // the pty may have exited between the check and the call
    }
  }

  /** @param {string} id */
  destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.reapTimer) clearTimeout(session.reapTimer);
    if (!session.exited) {
      try {
        session.pty.kill();
      } catch {
        // already gone
      }
    }
    if (session.socket && session.socket.readyState === session.socket.OPEN) {
      session.socket.close(1000, 'session closed');
    }
  }

  destroyAll() {
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }
}

module.exports = { SessionStore };
