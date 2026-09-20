#include "config.h"

#define NQ_LOG_TAG "WebConsole"

#ifndef _GNU_SOURCE
#define _GNU_SOURCE /* posix_openpt, ptsname_r */
#endif

#include <libnetq/Library.h>
#include <libnetq/Log.h>
#include <libnetq/fs/Path.h>
#include <libnetq/ErrorCode.h>
#include <libnetq/http/HttpHeader.h>
#include <libnetq/http/MediaType.h>
#include <libnetq/Module.h>
#include <libnetq/json/JSON.h>
#include <libnetq/json/JSONWriter.h>
#include <libnetq/Array.h>
#include <libnetq/web/WebServer.h>
#include <libnetq/web/WebManifest.h>
#include <libnetq/web/WebSocket.h>
#include <libnetq/web/WebRequest.h>
#include <libnetq/web/WebResponse.h>
#include <libnetq/Assert.h>
#include <libnetq/List.h>
#include <libnetq/Malloc.h>
#include <libnetq/Mutex.h>
#include <libnetq/NetworkLooper.h>
#include <libnetq/Random.h>
#include <libnetq/string/StringUtil.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

typedef struct WebConsoleExecutor WebConsoleExecutor;
struct WebConsoleExecutor {
  NQWebExecutor executor;
  NQWebManifestListeners manifestListeners;
  struct NQWebSocketListener consoleListener;
};

/* One console in the browser is one session here: a shell on a pty whose
 * output is pumped into a websocket. A session outlives the socket that made
 * it, so a reconnect re-attaches to the same shell instead of dropping
 * whatever was running; a console that closes for good says so with a `close`
 * message and takes its shell down with it. */

#define CONSOLE_MAX_SESSIONS   10
#define CONSOLE_IDLE_TIMEOUT   600000        /* ms a detached session survives */
#define CONSOLE_SCROLLBACK     (256 * 1024)  /* bytes replayed on re-attach */
#define CONSOLE_READ_CHUNK     8192
#define CONSOLE_ID_BYTES       9
#define CONSOLE_ID_CHARS       (CONSOLE_ID_BYTES * 2)
#define CONSOLE_JSON_LIMIT     512
#define CONSOLE_WRITE_WAIT_MS  50

/* Every message the console sends is one whole frame. The FIN bit says so:
 * a backend that looks at it (the microhttpd one does) treats a frame without
 * it as an unfinished fragment and the browser waits for a rest that never
 * comes. Terminal bytes go out binary, control messages as text. */
#define CONSOLE_WS_TEXT        (WEB_WSOPCODE_TEXT | WEB_WSBIT_FIN)
#define CONSOLE_WS_BINARY      (WEB_WSOPCODE_BINARY | WEB_WSBIT_FIN)

/* Close codes the client reads: 4001 puts up "Taken over", 4003 stops it from
 * retrying a server that has no room left. */
/* How the child reports a failure of its own: it cannot log from there, so the
 * parent reads these back from waitpid and logs on its behalf. */
#define CONSOLE_EXIT_NOTTY     126  /* could not open the terminal it was given */
#define CONSOLE_EXIT_NOEXEC    127  /* could not start the shell */

#define CONSOLE_CODE_NORMAL    1000
#define CONSOLE_CODE_TAKEOVER  4001
#define CONSOLE_CODE_LIMIT     4003

typedef struct ConsoleSession ConsoleSession;
struct ConsoleSession {
  NQListHead list;

  char id[CONSOLE_ID_CHARS + 1];
  pid_t pid;
  int master;                /* pty master; the looper polls this */
  uint16_t cols;
  uint16_t rows;

  bool exited;               /* the shell is gone */
  bool doomed;               /* unlinked, on its way to sessionFree */
  int exitCode;
  int exitSignal;

  NQWebSocket* socket;       /* the attached console, or NULL */
  NQNetworkLooper* looper;
  NQTimerIdentifier reapTimer;

  uint8_t* scrollback;       /* ring holding the most recent output */
  size_t scrollbackHead;
  size_t scrollbackSize;
};

/* The store owns every session, and membership in this list *is* the
 * ownership: a session is reachable from another thread only while it is
 * linked here, and whoever unlinks it (under the mutex) owns it from then on.
 * That is what makes a pointer held by a websocket safe to check. */
struct ConsoleStore {
  NQMutex mutex;
  NQListHead sessions;
  size_t count;
};

static struct ConsoleStore s_store = {
  .mutex = NQ_MUTEX_INIT(s_store.mutex),
  .sessions = NQ_LISTHEAD_INIT(s_store.sessions),
  .count = 0,
};

/* ---- settings ----------------------------------------------------------- */

static const char* consoleShell(void)
{
  const char* shell = getenv("WEBCONSOLE_SHELL");
  if (NQCStrIsNullOrEmpty(shell))
    shell = getenv("SHELL");
  return NQCStrIsNullOrEmpty(shell) ? "/bin/sh" : shell;
}

static const char* consoleCwd(void)
{
  return getenv("WEBCONSOLE_CWD");
}

static bool consoleReadOnly(void)
{
  const char* value = getenv("WEBCONSOLE_READ_ONLY");
  return !NQCStrIsNullOrEmpty(value) && *value != '0' && *value != 'f' && *value != 'F';
}

static uint16_t clampCols(int64_t cols)
{
  return (uint16_t)(cols < 2 ? 2 : (cols > 1000 ? 1000 : cols));
}

static uint16_t clampRows(int64_t rows)
{
  return (uint16_t)(rows < 1 ? 1 : (rows > 500 ? 500 : rows));
}

/* ---- control messages --------------------------------------------------- */

struct ConsoleJson {
  NQJSONWriter writer;
  char data[CONSOLE_JSON_LIMIT];
  size_t size;
};

static bool consoleJsonWrite(void* userdata, const char* characters, size_t size)
{
  struct ConsoleJson* json = (struct ConsoleJson*)userdata;
  if (json->size + size > sizeof(json->data))
    return false;
  memcpy(json->data + json->size, characters, size);
  json->size += size;
  return true;
}

static void consoleJsonInit(struct ConsoleJson* json)
{
  json->size = 0;
  NQJSONWriter_init(&json->writer, consoleJsonWrite, json);
}

/* Text frames are control messages; terminal bytes travel as binary ones. */
static void consoleJsonSend(struct ConsoleJson* json, NQWebSocket* sock)
{
  bool failed = json->writer.hasError;
  NQJSONWriter_finalize(&json->writer);
  if (!failed && sock != NULL)
    NQWebSocket_send(sock, (const uint8_t*)json->data, json->size, CONSOLE_WS_TEXT);
}

static void sendReady(NQWebSocket* sock, const ConsoleSession* session, bool resumed)
{
  struct ConsoleJson json;
  consoleJsonInit(&json);
  NQJSONWriter_writeObjectBegin(&json.writer);
  NQJSONWriter_writeKeyString(&json.writer, "type", "ready");
  NQJSONWriter_writeKeyString(&json.writer, "id", session->id);
  NQJSONWriter_writeKeyBool(&json.writer, "resumed", resumed);
  NQJSONWriter_writeKeyBool(&json.writer, "readOnly", consoleReadOnly());
  NQJSONWriter_writeKeyUint16(&json.writer, "cols", session->cols);
  NQJSONWriter_writeKeyUint16(&json.writer, "rows", session->rows);
  NQJSONWriter_writeObjectEnd(&json.writer);
  consoleJsonSend(&json, sock);
}

static void sendExit(NQWebSocket* sock, const ConsoleSession* session)
{
  struct ConsoleJson json;
  consoleJsonInit(&json);
  NQJSONWriter_writeObjectBegin(&json.writer);
  NQJSONWriter_writeKeyString(&json.writer, "type", "exit");
  NQJSONWriter_writeKeyInt32(&json.writer, "exitCode", session->exitCode);
  if (session->exitSignal != 0)
    NQJSONWriter_writeKeyInt32(&json.writer, "signal", session->exitSignal);
  NQJSONWriter_writeObjectEnd(&json.writer);
  consoleJsonSend(&json, sock);
}

static void sendError(NQWebSocket* sock, const char* message)
{
  struct ConsoleJson json;
  consoleJsonInit(&json);
  NQJSONWriter_writeObjectBegin(&json.writer);
  NQJSONWriter_writeKeyString(&json.writer, "type", "error");
  NQJSONWriter_writeKeyString(&json.writer, "message", message);
  NQJSONWriter_writeObjectEnd(&json.writer);
  consoleJsonSend(&json, sock);
}

/* ---- scrollback --------------------------------------------------------- */

static void scrollbackAppend(ConsoleSession* session, const uint8_t* data, size_t size)
{
  size_t tail;
  size_t first;
  size_t total;

  if (session->scrollback == NULL || size == 0)
    return;

  if (size >= CONSOLE_SCROLLBACK) {
    memcpy(session->scrollback, data + size - CONSOLE_SCROLLBACK, CONSOLE_SCROLLBACK);
    session->scrollbackHead = 0;
    session->scrollbackSize = CONSOLE_SCROLLBACK;
    return;
  }

  tail = (session->scrollbackHead + session->scrollbackSize) % CONSOLE_SCROLLBACK;
  first = CONSOLE_SCROLLBACK - tail;
  if (first > size)
    first = size;
  memcpy(session->scrollback + tail, data, first);
  if (first < size)
    memcpy(session->scrollback, data + first, size - first);

  total = session->scrollbackSize + size;
  if (total > CONSOLE_SCROLLBACK) {
    session->scrollbackHead = (session->scrollbackHead + total - CONSOLE_SCROLLBACK) % CONSOLE_SCROLLBACK;
    session->scrollbackSize = CONSOLE_SCROLLBACK;
  }
  else {
    session->scrollbackSize = total;
  }
}

/* Replayed so a reconnecting console sees the screen it left behind. */
static void scrollbackReplay(const ConsoleSession* session, NQWebSocket* sock)
{
  size_t first;

  if (session->scrollbackSize == 0)
    return;

  first = CONSOLE_SCROLLBACK - session->scrollbackHead;
  if (first > session->scrollbackSize)
    first = session->scrollbackSize;

  NQWebSocket_send(sock, session->scrollback + session->scrollbackHead, first, CONSOLE_WS_BINARY);
  if (first < session->scrollbackSize)
    NQWebSocket_send(sock, session->scrollback, session->scrollbackSize - first, CONSOLE_WS_BINARY);
}

/* ---- the pty ------------------------------------------------------------ */

/* The shell has no business holding the server's listening socket, the
 * looper's wakeup pipe or another console's pty: hand it nothing but its
 * own three streams. */
static void consoleCloseInherited(void)
{
#if defined(__GLIBC_PREREQ)
#if __GLIBC_PREREQ(2, 34)
  if (close_range(STDERR_FILENO + 1, ~0U, 0) == 0)
    return;
#endif
#endif
  {
    int fd;
    for (fd = STDERR_FILENO + 1; fd < 1024; fd++)
      close(fd);
  }
}

static int consoleSpawn(ConsoleSession* session)
{
  char slavePath[128];
  const char* shell = consoleShell();
  const char* cwd = consoleCwd();
  struct winsize size;
  pid_t pid;
  int flags;
  int slave = -1;      /* the child's end, when the kernel can hand it over */

  int master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0) {
    NQ_LOGE("Cannot open a pty (errno %d)", NQGetLastError());
    return -NQ_EIO;
  }

  fcntl(master, F_SETFD, FD_CLOEXEC);

  /* Best effort: on a modern devpts the slave already belongs to us, and the
   * chown behind this is what a container or a user namespace can refuse. */
  if (grantpt(master) != 0)
    NQ_LOGW("grantpt failed (errno %d); carrying on with the pty as it is", NQGetLastError());

  if (unlockpt(master) != 0) {
    NQ_LOGE("Cannot unlock the pty (errno %d)", NQGetLastError());
    close(master);
    return -NQ_EIO;
  }

  /* Ask the master for its own peer: no path involved, so it works where the
   * /dev/pts this process can see is not the instance the master came from --
   * containers, chroots, a stripped /dev. Kernels without it (WSL1 among
   * them) answer with an error, and the path below takes over. */
#if defined(TIOCGPTPEER)
  slave = ioctl(master, TIOCGPTPEER, O_RDWR | O_NOCTTY);
#endif

  if (slave < 0) {
#ifdef NQ_OS_LINUX
    if (ptsname_r(master, slavePath, sizeof(slavePath)) != 0) {
      NQ_LOGE("Cannot name the pty slave (errno %d)", NQGetLastError());
      close(master);
      return -NQ_EIO;
    }
#else
    {
      /* ptsname's buffer is shared, so copy it while the store lock still
       * serialises everyone who could be spawning. */
      const char* name = ptsname(master);
      if (name == NULL) {
        NQ_LOGE("Cannot name the pty slave (errno %d)", NQGetLastError());
        close(master);
        return -NQ_EIO;
      }
      snprintf(slavePath, sizeof(slavePath), "%s", name);
    }
#endif
  }

  memset(&size, 0, sizeof(size));
  size.ws_col = session->cols;
  size.ws_row = session->rows;

  pid = fork();
  if (pid < 0) {
    NQ_LOGE("Cannot fork a shell (errno %d)", NQGetLastError());
    if (slave >= 0)
      close(slave);
    close(master);
    return -NQ_EIO;
  }

  if (pid == 0) {
    /* The child hands itself the slave end as its controlling terminal, so
     * the shell comes up interactive with a real tty on all three streams. */
    int noTty = 0;

    close(master);
    if (setsid() < 0)
      noTty = NQGetLastError();

    if (slave < 0)
      slave = open(slavePath, O_RDWR);
    if (slave < 0)
      _exit(CONSOLE_EXIT_NOTTY);

#if defined(TIOCSCTTY)
    if (ioctl(slave, TIOCSCTTY, 0) < 0 && noTty == 0)
      noTty = NQGetLastError();
#endif
    /* Without a controlling terminal the shell comes up with no job control
     * and complains in its own words ("cannot set terminal process group");
     * say who is at fault first, so the console shows where to look. */
    if (noTty != 0)
      dprintf(slave, "webconsole: this shell has no controlling terminal (errno %d)\r\n", noTty);

    ioctl(slave, TIOCSWINSZ, &size);

    dup2(slave, STDIN_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDERR_FILENO);
    if (slave > STDERR_FILENO)
      close(slave);
    consoleCloseInherited();

    if (!NQCStrIsNullOrEmpty(cwd))
      (void)chdir(cwd);

    setenv("TERM", "xterm-256color", 1);
    setenv("COLORTERM", "truecolor", 1);
    setenv("WEBCONSOLE", "1", 1);

    execl(shell, shell, (char*)NULL);
    _exit(CONSOLE_EXIT_NOEXEC);
  }

  if (slave >= 0)
    close(slave);   /* the child's end is the child's alone */

  flags = fcntl(master, F_GETFL, 0);
  if (flags >= 0)
    fcntl(master, F_SETFL, flags | O_NONBLOCK);

  session->pid = pid;
  session->master = master;
  return 0;
}

/* The pty master is non-blocking, so a burst of input can come back short. */
static void consoleWriteAll(int master, const uint8_t* data, size_t size)
{
  size_t sent = 0;

  while (sent < size) {
    ssize_t wrote = write(master, data + sent, size - sent);
    if (wrote > 0) {
      sent += (size_t)wrote;
      continue;
    }
    if (wrote < 0 && NQGetLastError() == EINTR)
      continue;
    if (wrote < 0 && (NQGetLastError() == EAGAIN || NQGetLastError() == EWOULDBLOCK)) {
      struct pollfd wait;
      wait.fd = master;
      wait.events = POLLOUT;
      wait.revents = 0;
      if (poll(&wait, 1, CONSOLE_WRITE_WAIT_MS) > 0)
        continue;
    }
    /* the shell is not draining: drop the rest rather than block */
    NQ_LOGW("Dropped %zu input byte(s): the shell is not reading", size - sent);
    break;
  }
}

static void consoleResizePty(ConsoleSession* session, uint16_t cols, uint16_t rows)
{
  struct winsize size;

  if (session->exited || session->master < 0)
    return;
  if (session->cols == cols && session->rows == rows)
    return;

  session->cols = cols;
  session->rows = rows;

  memset(&size, 0, sizeof(size));
  size.ws_col = cols;
  size.ws_row = rows;
  ioctl(session->master, TIOCSWINSZ, &size);
}

/* ---- session lifetime --------------------------------------------------- */

static int sessionReadAction(NQSocketHandle handle, int events, void* userdata);

/* Only ever called with the store locked: it answers "is this pointer still
 * one of ours", which is what keeps a stale session pointer harmless. */
static bool sessionInStore(const ConsoleSession* candidate)
{
  NQListHead* iter;

  if (candidate == NULL)
    return false;

  for (iter = s_store.sessions.next; iter != &s_store.sessions; iter = iter->next) {
    if (NQ_CONTAINER_OF(iter, ConsoleSession, list) == candidate)
      return true;
  }
  return false;
}

static ConsoleSession* sessionOf(NQWebSocket* sock)
{
  ConsoleSession* candidate = (ConsoleSession*)NQWebSocket_userdata(sock);
  return sessionInStore(candidate) ? candidate : NULL;
}

static ConsoleSession* sessionFind(const char* id)
{
  NQListHead* iter;

  if (NQCStrIsNullOrEmpty(id))
    return NULL;

  for (iter = s_store.sessions.next; iter != &s_store.sessions; iter = iter->next) {
    ConsoleSession* session = NQ_CONTAINER_OF(iter, ConsoleSession, list);
    if (strcmp(session->id, id) == 0)
      return session;
  }
  return NULL;
}

static bool sessionMakeId(ConsoleSession* session)
{
  static const char kHex[] = "0123456789abcdef";
  uint8_t raw[CONSOLE_ID_BYTES];
  size_t i;

  if (NQGetCryptoRandom(raw, sizeof(raw)) != 0)
    return false;

  for (i = 0; i < sizeof(raw); i++) {
    session->id[i * 2] = kHex[raw[i] >> 4];
    session->id[i * 2 + 1] = kHex[raw[i] & 0x0f];
  }
  session->id[CONSOLE_ID_CHARS] = '\0';
  return true;
}

/* Store locked. */
static ConsoleSession* sessionCreate(NQNetworkLooper* looper, uint16_t cols, uint16_t rows)
{
  ConsoleSession* session;

  if (looper == NULL) {
    NQ_LOGE("No looper to run a shell on");
    return NULL;
  }
  if (s_store.count >= CONSOLE_MAX_SESSIONS) {
    NQ_LOGW("Refusing a new console: all %d sessions are taken", CONSOLE_MAX_SESSIONS);
    return NULL;
  }

  session = (ConsoleSession*)NQMalloc(sizeof(*session));
  if (session == NULL) {
    NQ_LOGE("Out of memory for a session");
    return NULL;
  }

  memset(session, 0, sizeof(*session));
  NQListHead_init(&session->list);
  session->master = -1;
  session->pid = -1;
  session->cols = cols;
  session->rows = rows;
  session->looper = looper;

  session->scrollback = (uint8_t*)NQMalloc(CONSOLE_SCROLLBACK);
  if (session->scrollback == NULL || !sessionMakeId(session)) {
    NQ_LOGE("Cannot set up a session: no scrollback buffer or no id");
    NQFree(session->scrollback);
    NQFree(session);
    return NULL;
  }

  if (consoleSpawn(session) != 0) {
    NQFree(session->scrollback);
    NQFree(session);
    return NULL;
  }

  if (!NQNetworkLooper_addSocket(looper, session->master, sessionReadAction, NULL, session)) {
    NQ_LOGE("Cannot poll the pty of session %s; dropping it", session->id);
    kill(session->pid, SIGKILL);
    waitpid(session->pid, NULL, 0);
    close(session->master);
    NQFree(session->scrollback);
    NQFree(session);
    return NULL;
  }

  NQListHead_addBack(&s_store.sessions, &session->list);
  s_store.count++;
  return session;
}

/* Store locked. Takes the session out of the store — and its socket with it —
 * so that from here on it belongs to the caller alone. */
static void sessionUnlink(ConsoleSession* session, uint16_t closeCode)
{
  if (session->socket != NULL) {
    NQWebSocket_setUserdata(session->socket, NULL);
    if (closeCode != 0)
      NQWebSocket_close(session->socket, closeCode);
    session->socket = NULL;
  }
  if (session->reapTimer != 0) {
    NQNetworkLooper_clearTimeout(session->looper, session->reapTimer);
    session->reapTimer = 0;
  }
  NQListHead_remove(&session->list);
  NQListHead_init(&session->list);
  session->doomed = true;
  s_store.count--;
}

static void sessionKill(ConsoleSession* session)
{
  int attempt;

  if (session->pid <= 0)
    return;

  kill(session->pid, SIGHUP);
  for (attempt = 0; attempt < 20; attempt++) {
    pid_t done = waitpid(session->pid, NULL, WNOHANG);
    if (done == session->pid || (done < 0 && NQGetLastError() == ECHILD)) {
      session->pid = -1;
      return;
    }
    usleep(5000);
  }

  NQ_LOGW("Shell %d ignored SIGHUP; killing it", (int)session->pid);
  kill(session->pid, SIGKILL);
  waitpid(session->pid, NULL, 0);
  session->pid = -1;
}

/* Unlinked sessions only, on the looper thread (or at shutdown). */
static void sessionFree(ConsoleSession* session)
{
  if (session->master >= 0) {
    NQNetworkLooper_removeSocket(session->looper, session->master);
    close(session->master);
    session->master = -1;
  }
  if (!session->exited)
    sessionKill(session);

  NQFree(session->scrollback);
  NQFree(session);
}

static void sessionDestroyAction(void* userdata)
{
  sessionFree((ConsoleSession*)userdata);
}

/* The pty fd is polled by the looper, so the teardown that unregisters it
 * belongs on the looper thread rather than on whichever connection thread
 * happened to ask for it. */
static void sessionHandOff(ConsoleSession* session)
{
  if (session->looper != NULL
      && NQNetworkLooper_dispatch(session->looper, sessionDestroyAction, NULL, session))
    return;

  NQ_LOGW("Tearing session %s down in place: the looper took no dispatch", session->id);
  sessionFree(session);
}

/* ---- pty -> websocket --------------------------------------------------- */

/* The shell is gone: tell the console, then take the session down. */
static void sessionShellExited(ConsoleSession* session)
{
  int status = 0;

  if (session->pid > 0 && waitpid(session->pid, &status, 0) == session->pid) {
    session->exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : 0;
    session->exitSignal = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    session->pid = -1;
  }
  else if (session->pid > 0) {
    NQ_LOGW("Cannot reap the shell of session %s (errno %d)", session->id, NQGetLastError());
  }
  session->exited = true;

  /* A shell that stops on its own is ordinary; these are the ways it never
   * really started, which nothing else would report. */
  if (session->exitCode == CONSOLE_EXIT_NOEXEC)
    NQ_LOGE("Session %s: cannot start the shell '%s'", session->id, consoleShell());
  else if (session->exitCode == CONSOLE_EXIT_NOTTY)
    NQ_LOGE("Session %s: the shell could not open the terminal it was given", session->id);
  else if (session->exitSignal != 0)
    NQ_LOGW("Session %s: the shell was killed by signal %d", session->id, session->exitSignal);

  NQMutex_lock(&s_store.mutex);
  if (!sessionInStore(session)) {
    NQMutex_unlock(&s_store.mutex);
    return;
  }
  if (session->socket != NULL)
    sendExit(session->socket, session);
  sessionUnlink(session, CONSOLE_CODE_NORMAL);
  NQMutex_unlock(&s_store.mutex);

  sessionHandOff(session);
}

static int sessionReadAction(NQSocketHandle handle, int events, void* userdata)
{
  ConsoleSession* session = (ConsoleSession*)userdata;
  uint8_t chunk[CONSOLE_READ_CHUNK];

  NQ_UNUSED_PARAM(events);

  for (;;) {
    ssize_t got = read(handle, chunk, sizeof(chunk));
    if (got > 0) {
      /* Sending under the store lock is what keeps this from racing a
       * connection thread that is closing the very same socket. */
      NQMutex_lock(&s_store.mutex);
      scrollbackAppend(session, chunk, (size_t)got);
      if (session->socket != NULL)
        NQWebSocket_send(session->socket, chunk, (size_t)got, CONSOLE_WS_BINARY);
      NQMutex_unlock(&s_store.mutex);
      continue;
    }
    if (got < 0 && NQGetLastError() == EINTR)
      continue;
    if (got < 0 && (NQGetLastError() == EAGAIN || NQGetLastError() == EWOULDBLOCK))
      return POLLIN;

    break; /* EOF, or EIO once the last slave fd is closed */
  }

  sessionShellExited(session);
  return 0; /* stop polling; sessionFree unregisters the fd */
}

static void sessionReapAction(NQTimerIdentifier id, void* userdata)
{
  ConsoleSession* session = (ConsoleSession*)userdata;

  NQ_UNUSED_PARAM(id);

  NQMutex_lock(&s_store.mutex);
  if (!sessionInStore(session)) {
    NQMutex_unlock(&s_store.mutex);
    return;
  }
  session->reapTimer = 0;
  if (session->socket != NULL) {
    NQMutex_unlock(&s_store.mutex); /* somebody came back for it */
    return;
  }
  sessionUnlink(session, 0);
  NQMutex_unlock(&s_store.mutex);

  sessionHandOff(session);
}

/* ---- websocket -> pty --------------------------------------------------- */

/* The console names the shell it wants — a fresh one, or the id it had before
 * a reconnect — in its first message, and gets `ready` in return. */
static void consoleAttach(NQWebSocket* sock, const NQJSON* message)
{
  const char* id = NULL;
  int64_t cols = 80;
  int64_t rows = 24;
  ConsoleSession* session;
  bool resumed = false;

  NQJSON_objectGetString(message, "id", &id);
  NQJSON_objectGetInt64(message, "cols", &cols);
  NQJSON_objectGetInt64(message, "rows", &rows);

  NQMutex_lock(&s_store.mutex);
  if (sessionOf(sock) != NULL) {
    NQMutex_unlock(&s_store.mutex); /* already attached */
    return;
  }

  session = sessionFind(id);
  if (session != NULL) {
    resumed = true;
    if (session->reapTimer != 0) {
      NQNetworkLooper_clearTimeout(session->looper, session->reapTimer);
      session->reapTimer = 0;
    }
    /* One shell, one console: whoever asks last gets it. */
    if (session->socket != NULL && session->socket != sock) {
      NQWebSocket_setUserdata(session->socket, NULL);
      NQWebSocket_close(session->socket, CONSOLE_CODE_TAKEOVER);
      session->socket = NULL;
    }
  }
  else {
    session = sessionCreate(NQWebSocket_looper(sock), clampCols(cols), clampRows(rows));
    if (session == NULL) {
      NQ_LOGW("No shell for a console asking for %dx%d", (int)cols, (int)rows);
      sendError(sock, "session limit reached");
      NQWebSocket_close(sock, CONSOLE_CODE_LIMIT);
      NQMutex_unlock(&s_store.mutex);
      return;
    }
  }

  session->socket = sock;
  NQWebSocket_setUserdata(sock, session);

  sendReady(sock, session, resumed);
  if (resumed) {
    scrollbackReplay(session, sock);
    consoleResizePty(session, clampCols(cols), clampRows(rows));
  }
  NQMutex_unlock(&s_store.mutex);
}

static void consoleInput(NQWebSocket* sock, const uint8_t* data, size_t size)
{
  ConsoleSession* session;

  if (size == 0 || consoleReadOnly())
    return;

  NQMutex_lock(&s_store.mutex);
  session = sessionOf(sock);
  if (session != NULL && !session->exited && session->master >= 0)
    consoleWriteAll(session->master, data, size);
  NQMutex_unlock(&s_store.mutex);
}

static void consoleResize(NQWebSocket* sock, const NQJSON* message)
{
  ConsoleSession* session;
  int64_t cols = 0;
  int64_t rows = 0;

  if (!NQJSON_objectGetInt64(message, "cols", &cols) || !NQJSON_objectGetInt64(message, "rows", &rows))
    return;

  NQMutex_lock(&s_store.mutex);
  session = sessionOf(sock);
  if (session != NULL)
    consoleResizePty(session, clampCols(cols), clampRows(rows));
  NQMutex_unlock(&s_store.mutex);
}

/* The console is closing for good: kill the shell now instead of leaving it
 * to the idle reaper, then hang up — the client waits for that goodbye. */
static void consoleClose(NQWebSocket* sock)
{
  ConsoleSession* session;

  NQMutex_lock(&s_store.mutex);
  session = sessionOf(sock);
  if (session != NULL)
    sessionUnlink(session, CONSOLE_CODE_NORMAL);
  else
    NQWebSocket_close(sock, CONSOLE_CODE_NORMAL); /* nothing left to close */
  NQMutex_unlock(&s_store.mutex);

  if (session != NULL)
    sessionHandOff(session);
}

/* ---- socket callbacks --------------------------------------------------- */

static int socketInit(NQWebSocket* sock, void* data)
{
  NQ_UNUSED_PARAM(data);

  /* No shell yet: userdata carries the session once `attach` names one. */
  NQWebSocket_setUserdata(sock, NULL);
  return 0;
}

static void socketOpen(NQWebSocket* sock)
{
  NQ_UNUSED_PARAM(sock);
}

static void socketReceive(NQWebSocket* sock, const uint8_t* data, size_t size, unsigned opcode)
{
  const char* type = NULL;
  NQJSON* message;

  switch (opcode & 0x0f) {
  case WEB_WSOPCODE_BINARY:
    consoleInput(sock, data, size); /* raw keystrokes */
    return;

  case WEB_WSOPCODE_TEXT:
    break;

  default:
    return; /* ping, pong and close belong to the backend */
  }

  message = NQJSON_parse2((const char*)data, size);
  if (message == NULL)
    return;

  if (NQJSON_objectGetString(message, "type", &type) && type != NULL) {
    if (strcmp(type, "attach") == 0) {
      consoleAttach(sock, message);
    }
    else if (strcmp(type, "input") == 0) {
      const char* text = NULL;
      if (NQJSON_objectGetString(message, "data", &text) && text != NULL)
        consoleInput(sock, (const uint8_t*)text, NQStrlen(text));
    }
    else if (strcmp(type, "resize") == 0) {
      consoleResize(sock, message);
    }
    else if (strcmp(type, "close") == 0) {
      consoleClose(sock);
    }
  }

  NQJSON_release(message);
}

/* The socket dropped without saying goodbye: keep the shell running for a
 * while, so a reconnect can pick up where it left off. */
static void socketRelease(NQWebSocket* sock, uint32_t reason)
{
  ConsoleSession* session;
  bool destroy = false;

  NQ_UNUSED_PARAM(reason);

  NQMutex_lock(&s_store.mutex);
  session = sessionOf(sock);
  if (session != NULL && session->socket == sock) {
    session->socket = NULL;
    if (CONSOLE_IDLE_TIMEOUT > 0) {
      session->reapTimer = NQNetworkLooper_setTimeout(
        session->looper, CONSOLE_IDLE_TIMEOUT, sessionReapAction, NULL, session);
      destroy = session->reapTimer == 0; /* no timer to reap it: do it now */
      if (destroy)
        NQ_LOGW("No timer to reap session %s; ending it now", session->id);
    }
    else {
      destroy = true;
    }
    if (destroy)
      sessionUnlink(session, 0);
  }
  NQWebSocket_setUserdata(sock, NULL);
  NQMutex_unlock(&s_store.mutex);

  if (destroy)
    sessionHandOff(session);
}

static void consoleDestroyAll(void)
{
  for (;;) {
    ConsoleSession* session;

    NQMutex_lock(&s_store.mutex);
    if (NQListHead_isEmpty(&s_store.sessions)) {
      NQMutex_unlock(&s_store.mutex);
      return;
    }
    session = NQ_CONTAINER_OF(s_store.sessions.next, ConsoleSession, list);
    sessionUnlink(session, CONSOLE_CODE_NORMAL);
    NQMutex_unlock(&s_store.mutex);

    /* The looper is on its way out, so this one cannot be handed to it. */
    sessionFree(session);
  }
}

static const NQWebSocketOperations kSocketOps = {
  .init = socketInit,
  .open = socketOpen,
  .receive = socketReceive,
  .release = socketRelease,
};

static int executorInit(NQWebExecutor* executor, void* data)
{
  NQ_UNUSED_PARAM(data);

  struct WebConsoleExecutor* console = (struct WebConsoleExecutor*)executor;

  NQLibraryInfo info;
  int ret = NQLibraryInfoLoad(&info, &executorInit);
  if (ret != 0)
    return ret;

  NQPath* manifest = NQPath_join3(info.filename, "../../" CONSOLE_ASSETS_DIR, NQ_WEBMANIFEST_FILE);
  NQLibraryInfoFinalize(&info);
  if (manifest == NULL) {
    NQ_LOGE("Out of memory building the path to " NQ_WEBMANIFEST_FILE);
    return -NQ_ENOMEM;
  }

  ret = NQWebManifestListenersInit(executor, &console->manifestListeners, NQPath_characters(manifest));
  if (ret != 0)
    NQ_LOGE("Cannot serve the client from '%s' (%d)", NQPath_characters(manifest), ret);
  NQPath_destroy(manifest);
  if (ret != 0) {
    return ret;
  }

  ret = NQWebExecutor_addSocketListener(&console->executor, &console->consoleListener, &kSocketOps, console, NQ_HTTP_GET, CONSOLE_SERVICE_URL);
  if (ret != 0) {
    NQ_LOGE("Cannot mount the shell socket at " CONSOLE_SERVICE_URL " (%d)", ret);
    NQWebManifestListenersFinalize(&console->executor, &console->manifestListeners);
    return ret;
  }

  return ret;
}

static void executorRelease(NQWebExecutor* executor)
{
  struct WebConsoleExecutor* console = (struct WebConsoleExecutor*)executor;
  NQWebExecutor_removeSocketListener(&console->executor, &console->consoleListener);
  NQWebManifestListenersFinalize(&console->executor, &console->manifestListeners);
  consoleDestroyAll();
}

static struct NQWebExecutorOperations s_executorOps = {
  .name = "console",
  .init = executorInit,
  .release = executorRelease,
  .size = sizeof(struct WebConsoleExecutor),
};

static int moduleInit(NQContext* context)
{
  NQWebExecutorRegister(&s_executorOps);
  return 0;
}

static void moduleExit(NQContext* context)
{
  NQWebExecutorUnregister(&s_executorOps);
}

NQ_MODULE_INIT(moduleInit);
NQ_MODULE_EXIT(moduleExit);
