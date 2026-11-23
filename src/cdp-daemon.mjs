import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const runtimeFile = new URL('./bg-runtime.js', import.meta.url);
const defaultPortFile = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort',
);
const loopbackNames = new Set(['127.0.0.1', 'localhost', '[::1]']);

async function readPort(file) {
  try {
    const [first] = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
    const port = Number(first);
    return /^\d+$/.test(first) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function getPageSocket(target, port, mediaOrigin) {
  if (target?.type !== 'page' || typeof target.id !== 'string' || !target.id) return null;
  try {
    const page = new URL(target.url);
    const socket = new URL(target.webSocketDebuggerUrl);
    if (page.protocol !== 'https:' || !loopbackNames.has(page.hostname)
      || page.origin === mediaOrigin) return null;
    if (socket.protocol !== 'ws:' || !loopbackNames.has(socket.hostname)
      || Number(socket.port || 80) !== port || socket.username || socket.password
      || !socket.pathname.startsWith('/devtools/page/')) return null;
    socket.hostname = '127.0.0.1';
    return socket.href;
  } catch {
    return null;
  }
}

function connect(url, timeoutMs, onNavigation) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  let acceptOpen;
  let rejectOpen;
  let finishClose;
  const opened = new Promise((resolve, reject) => {
    acceptOpen = resolve;
    rejectOpen = reject;
  });
  const closed = new Promise((resolve) => { finishClose = resolve; });
  const handshakeTimer = setTimeout(() => {
    rejectOpen(new Error('CDP connection timed out'));
    socket.close();
  }, timeoutMs);

  socket.addEventListener('open', () => {
    clearTimeout(handshakeTimer);
    acceptOpen();
  }, { once: true });

  function fail(error) {
    clearTimeout(handshakeTimer);
    rejectOpen(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  socket.addEventListener('error', () => fail(new Error('CDP connection failed')));
  socket.addEventListener('close', () => {
    fail(new Error('CDP connection closed'));
    finishClose();
  }, { once: true });

  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) onNavigation();
    const request = pending.get(message?.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  async function send(method, params = {}) {
    await opened;
    if (socket.readyState !== WebSocket.OPEN) throw new Error('CDP connection closed');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { timer, resolve, reject });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    send,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close() {
      socket.close();
      return closed;
    },
  };
}

function evaluate(connection, expression) {
  return connection.send('Runtime.evaluate', { expression, returnByValue: true }).then((result) => {
    if (result?.exceptionDetails) throw new Error('Wallpaper runtime evaluation failed');
    return result?.result?.value;
  });
}

export async function startCdpDaemon({
  baseUrl, portFile = defaultPortFile, pollIntervalMs = 1000, timeoutMs = 3000, once = false,
}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'http:' || !loopbackNames.has(origin.hostname)) {
    throw new Error('The wallpaper media server must use a loopback HTTP origin');
  }
  baseUrl = origin.origin;
  const [background, css, picker] = await Promise.all([
    runtimeFile, new URL('./glass-theme.css', import.meta.url), new URL('./picker-ui.js', import.meta.url),
  ].map(file => readFile(file, 'utf8')));
  const runtime = `${background}\n;${picker}\n;window.__agyWeBg.setTheme(${JSON.stringify(css)});`;
  const targets = new Map();
  const stopSignal = new AbortController();
  let selection;
  let timer;
  let inFlight;
  let shutdown;

  async function getJson(url) {
    const signal = AbortSignal.any([stopSignal.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(url, { signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function readPayload() {
    const settings = await getJson(`${baseUrl}/api/settings`);
    const activeId = settings.enabled ? settings.activeId : null;
    const roots = JSON.stringify([settings.customDirs, settings.extraRoots]);
    if (!activeId) {
      selection = undefined;
      return JSON.stringify({ baseUrl, settings, wallpaper: null, manifest: null });
    }
    if (!selection || selection.id !== activeId || selection.roots !== roots
      || (!selection.wallpaper && Date.now() >= selection.retryAt)) {
      const { items } = await getJson(`${baseUrl}/api/wallpapers?refresh=1`);
      const wallpaper = items.find((item) => item.id === activeId) ?? null;
      const manifest = wallpaper?.type === 'scene'
        ? await getJson(`${baseUrl}/api/scene/${encodeURIComponent(activeId)}/manifest`).catch(() => null)
        : null;
      selection = { id: activeId, roots, wallpaper, manifest, retryAt: Date.now() + 5000 };
    }
    return JSON.stringify({ baseUrl, settings, wallpaper: selection.wallpaper, manifest: selection.manifest });
  }

  async function removeTarget(id, entry) {
    targets.delete(id);
    await entry.connection.close();
  }

  async function push(target, url, payload, leader) {
    let entry = targets.get(target.id);
    try {
      if (!entry) {
        const attached = { url, pageUrl: target.url, generation: 0, syncedGeneration: -1 };
        attached.connection = connect(url, timeoutMs, () => { attached.generation++; });
        targets.set(target.id, attached);
        entry = attached;
        await entry.connection.send('Page.enable');
      }
      if (stopSignal.signal.aborted) return;
      if (entry.pageUrl !== target.url) {
        entry.pageUrl = target.url;
        entry.generation++;
      }
      const generation = entry.generation;
      const inject = generation !== entry.syncedGeneration;
      if (!inject && entry.payload === payload && entry.leader === leader) return;
      const update = `window.__agyWeBg ? (p => {
        if (!window.__agyWePicker) return false;
        p.slideshowLeader = ${leader};
        window.__agyWePicker.update(p);
        return true;
      })(${payload}) : false`;
      const expression = inject ? `${runtime}\n;${update}` : update;
      const updated = await evaluate(entry.connection, expression);
      if (updated === false && !inject) await evaluate(entry.connection, `${runtime}\n;${update}`);
      entry.syncedGeneration = generation;
      entry.payload = payload;
      entry.leader = leader;
    } catch {
      if (entry) await removeTarget(target.id, entry);
    }
  }

  async function reconcile() {
    const port = await readPort(portFile);
    const list = port
      ? await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []) : [];
    if (stopSignal.signal.aborted) return;
    const candidates = new Map();
    for (const target of Array.isArray(list) ? list : []) {
      const url = getPageSocket(target, port, baseUrl);
      if (url) candidates.set(target.id, { target, url });
    }
    await Promise.all([...targets].map(async ([id, entry]) => {
      if (candidates.get(id)?.url !== entry.url || !entry.connection.isOpen()) {
        await removeTarget(id, entry);
      }
    }));
    if (stopSignal.signal.aborted || !candidates.size) return;
    const payload = await readPayload();
    if (stopSignal.signal.aborted) return;
    const leader = [...candidates.keys()].sort()[0];
    await Promise.all([...candidates.values()].map(({ target, url }) => push(target, url, payload, target.id === leader)));
  }

  async function poll() {
    try {
      await reconcile();
    } catch {
      // Neither a closed Antigravity window nor an unavailable local server is fatal.
    } finally {
      if (!once && !stopSignal.signal.aborted) {
        timer = setTimeout(() => { inFlight = poll(); }, pollIntervalMs);
      }
    }
  }

  function stop() {
    if (shutdown) return shutdown;
    stopSignal.abort();
    clearTimeout(timer);
    shutdown = (async () => {
      await inFlight;
      await Promise.all([...targets].map(async ([id, entry]) => {
        try {
          if (entry.connection.isOpen()) {
            await evaluate(entry.connection, `
              try { window.__agyWePicker?.destroy?.(); } catch {}
              delete window.__agyWePicker;
              try { window.__agyWeBg?.destroy?.(); } catch {}
              delete window.__agyWeBg;
            `);
          }
        } catch {
          // The page may already have closed.
        } finally {
          await removeTarget(id, entry);
        }
      }));
    })();
    return shutdown;
  }

  const ready = inFlight = poll();
  return { ready, stop };
}
