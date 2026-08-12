import { chromium } from 'playwright';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CONNECT_TIMEOUT_MS = 500;
const MAX_CONNECT_TIMEOUT_MS = 60_000;
const CLOSE_WAIT_MS = 1_000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function boundedTimeout(value, fallback = DEFAULT_CONNECT_TIMEOUT_MS) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, MIN_CONNECT_TIMEOUT_MS), MAX_CONNECT_TIMEOUT_MS);
}

function closeSocket(socket) {
  try {
    // 0 = CONNECTING, 1 = OPEN. Closing this client socket never closes the
    // Dolphin browser profile or sends the CDP Browser.close command.
    if (socket && socket.readyState < 2) socket.close();
  } catch {
    // A socket can race from OPEN to CLOSED while a timeout is firing.
  }
}

function textFromSocketMessage(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  return String(value);
}

function openWebSocket(url, { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const timeout = boundedTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    let socket;
    let timer;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket?.removeEventListener('open', onOpen);
      socket?.removeEventListener('error', onError);
      socket?.removeEventListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = message => {
      finish(reject, new Error(message));
      closeSocket(socket);
    };
    const onOpen = () => finish(resolve, socket);
    const onError = () => fail('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u044c\u0441\u044f \u043a Automation API Dolphin.');
    const onClose = () => fail('\u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0441 Automation API Dolphin \u0437\u0430\u043a\u0440\u044b\u043b\u043e\u0441\u044c \u0434\u043e \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0438\u044f \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f.');

    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(new Error('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0437\u0434\u0430\u0442\u044c \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0441 Automation API Dolphin.', { cause: error }));
      return;
    }

    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    timer = setTimeout(() => {
      fail(`\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u044c\u0441\u044f \u043a Automation API Dolphin \u0437\u0430 ${Math.ceil(timeout / 1_000)} \u0441\u0435\u043a.`);
    }, timeout);
  });
}

async function resolveWebSocketEndpoint(endpoint, { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const value = String(endpoint || '').trim();
  if (/^wss?:\/\//i.test(value)) return value;
  if (!/^https?:\/\//i.test(value)) {
    throw new Error('Dolphin \u0432\u0435\u0440\u043d\u0443\u043b \u043d\u0435\u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043c\u044b\u0439 \u0430\u0434\u0440\u0435\u0441 Automation API.');
  }

  const versionUrl = new URL(value);
  versionUrl.pathname = '/json/version';
  versionUrl.search = '';
  versionUrl.hash = '';
  let response;
  try {
    response = await fetch(versionUrl, { signal: AbortSignal.timeout(boundedTimeout(timeoutMs)) });
  } catch (error) {
    throw new Error('Automation API Dolphin \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b \u0432 \u043e\u0442\u0432\u0435\u0434\u0451\u043d\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f.', { cause: error });
  }
  const details = await response.json().catch(() => ({}));
  if (!response.ok || !details.webSocketDebuggerUrl) {
    throw new Error('Automation API Dolphin \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b \u0430\u0434\u0440\u0435\u0441 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430.');
  }
  return details.webSocketDebuggerUrl;
}

function withTimeout(operation, timeoutMs, message, onTimeout) {
  const timeout = boundedTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Timeout reporting must not be blocked by cleanup races.
      }
      finish(reject, new Error(message));
    }, timeout);

    Promise.resolve()
      .then(operation)
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

/**
 * Connect to a Dolphin CDP endpoint without issuing Browser.close.
 * `disconnect()` closes only the client WebSocket and leaves the Dolphin
 * browser profile running for the user.
 */
export async function connectDolphinCdp(wsEndpoint, { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  if (!wsEndpoint) {
    throw new Error('Dolphin \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b \u0430\u0434\u0440\u0435\u0441 Automation API \u0434\u043b\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f.');
  }

  const timeout = boundedTimeout(timeoutMs);
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) {
      throw new Error(`\u041f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u043a Automation API Dolphin \u043f\u0440\u0435\u0432\u044b\u0441\u0438\u043b\u043e \u043b\u0438\u043c\u0438\u0442 ${Math.ceil(timeout / 1_000)} \u0441\u0435\u043a.`);
    }
    return value;
  };

  const resolvedEndpoint = await resolveWebSocketEndpoint(wsEndpoint, { timeoutMs: remaining() });
  const socket = await openWebSocket(resolvedEndpoint, { timeoutMs: remaining() });
  let disconnected = false;
  let closeNotified = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    send(message) {
      if (socket.readyState !== 1) {
        throw new Error('CDP \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0437\u0430\u043a\u0440\u044b\u0442\u043e.');
      }
      socket.send(JSON.stringify(message));
    },
    close() {
      if (disconnected) return;
      disconnected = true;
      closeSocket(socket);
      notifyClosed('CDP client transport closed');
    },
  };
  const notifyClosed = reason => {
    if (closeNotified) return;
    closeNotified = true;
    try {
      transport.onclose?.(reason);
    } catch {
      // A consumer may already have torn down after a concurrent timeout.
    }
    resolveClosed();
  };

  socket.addEventListener('message', event => {
    if (disconnected) return;
    try {
      transport.onmessage?.(JSON.parse(textFromSocketMessage(event.data)));
    } catch {
      // Ignore malformed messages not belonging to CDP.
    }
  });
  socket.addEventListener('close', () => {
    disconnected = true;
    notifyClosed('CDP connection closed');
  }, { once: true });
  socket.addEventListener('error', () => {
    disconnected = true;
    notifyClosed('CDP connection error');
    closeSocket(socket);
  }, { once: true });

  let browser;
  try {
    browser = await withTimeout(
      () => chromium.connectOverCDP(transport),
      remaining(),
      `\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u044c Playwright \u043a CDP Dolphin \u0437\u0430 ${Math.ceil(timeout / 1_000)} \u0441\u0435\u043a.`,
      () => {
        disconnected = true;
        closeSocket(socket);
        notifyClosed('CDP connection timeout');
      },
    );
  } catch (error) {
    disconnected = true;
    closeSocket(socket);
    notifyClosed('CDP connection setup failed');
    await Promise.race([closed, delay(CLOSE_WAIT_MS)]);
    throw error;
  }

  return {
    browser,
    async disconnect() {
      if (!disconnected) {
        disconnected = true;
        closeSocket(socket);
        notifyClosed('CDP client disconnected');
      }
      await Promise.race([closed, delay(CLOSE_WAIT_MS)]);
    },
  };
}
