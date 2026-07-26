/** Wire protocol shared by the server and the browser client.
 *
 * Terminal output travels as binary websocket frames (raw PTY bytes); every
 * text frame is one JSON control message from the types below. */

/** Sent once per connection, before any output is replayed. */
export interface ReadyMessage {
  type: 'ready';
  id: string;
  /** True when this socket re-attached to a PTY that was already running. */
  resumed: boolean;
  readOnly: boolean;
  cols: number;
  rows: number;
}

export interface ExitMessage {
  type: 'exit';
  exitCode: number;
  signal?: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage = ReadyMessage | ExitMessage | ErrorMessage;

export type ClientMessage =
  /** First message of every connection: which shell to attach to, and how big
   *  it should be. Servers that read those from the query string ignore it. */
  | { type: 'attach'; id: string | null; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' };

/** Payload of `GET /api/info`. The console does not ask for it; it is the
 *  shape the server answers with, for whoever does. */
export interface ServerInfo {
  shell: string;
  cwd: string;
  readOnly: boolean;
  maxSessions: number;
  host: string;
}
