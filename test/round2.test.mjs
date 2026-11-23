import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';
import { startCdpDaemon } from '../src/cdp-daemon.mjs';
import { createMediaServer } from '../src/media-server.mjs';

const runtime = await readFile(new URL('../src/bg-runtime.js', import.meta.url), 'utf8');
const renderer = await readFile(new URL('../src/webwallgl-host/renderer.js', import.meta.url), 'utf8');
const sceneId = 'workshop:123';
const encodedId = encodeURIComponent(sceneId);
const mainUrl = 'https://127.0.0.1:25000/c/chat';

async function save(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function archive(files) {
  function uint32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  }
  const entries = Object.entries(files).map(([name, body]) => [Buffer.from(name), Buffer.from(body)]);
  const header = [uint32(8), Buffer.from('PKGV0001'), uint32(entries.length)];
  let offset = 0;
  for (const [name, body] of entries) {
    header.push(uint32(name.length), name, uint32(offset), uint32(body.length));
    offset += body.length;
  }
  return Buffer.concat([...header, ...entries.map(([, body]) => body)]);
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-we-round2-'));
  const workshop = join(dir, '431960');
  const scene = join(workshop, '123');
  const assets = join(dir, 'assets');
  const settingsPath = join(dir, 'settings.json');
  const project = { type: 'scene', file: 'custom.mpkg', title: 'Mock scene', general: { properties: {} } };
  const pkg = archive({
    'nested/scene.json': '{"objects":[]}',
    'materials/project.tex': 'packaged texture',
    'materials/movie.mp4': 'embedded video',
  });
  let media;
  t.after(async () => {
    try {
      await media?.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
  await save(join(scene, 'project.json'), `\uFEFF${JSON.stringify(project)}`);
  await save(join(scene, 'custom.mpkg'), pkg);
  await save(join(scene, 'materials', 'loose.tex'), 'loose texture');
  await save(join(assets, 'materials', 'project.tex'), 'global texture masked by package');
  await save(join(assets, 'materials', 'common.tex'), 'global texture');
  await save(join(assets, 'shaders', 'common.frag'), 'global shader');
  media = await createMediaServer({ port: 0, settingsPath, scanRoots: [workshop], weAssetsDir: assets });
  const request = (path, options) => fetch(`${media.baseUrl}${path}`, options);
  const patch = (changes) => request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  }).then((response) => response.json());
  return { dir, media, request, patch, settingsPath, project, pkg };
}

test('WebWallGL host routes serve the global bundle and one packed/loose/global resource tree', async (t) => {
  const { request, project, pkg } = await fixture(t);
  const html = await request('/webwallgl/index.html');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  const markup = await html.text();
  const vendor = markup.indexOf('<script src="/vendor/webwallgl/webwallgl.global.min.js"></script>');
  assert.ok(vendor >= 0 && vendor < markup.indexOf('src="/webwallgl/renderer.js"'));
  for (const [path, source] of [['/webwallgl/renderer.js', renderer], ['/api/runtime/bg.js', runtime]]) {
    const script = await request(path);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(await script.text(), source);
  }
  const root = `/media/scene-root/${encodedId}/`;
  assert.deepEqual(await (await request(root + 'project.json')).json(), { ...project, file: 'nested/scene.json' });
  assert.deepEqual(await (await request(`/media/file/${encodedId}/project.json`)).json(), project);
  for (const [path, body] of [
    ['nested/scene.json', '{"objects":[]}'],
    ['materials/project.tex', 'packaged texture'],
    ['materials/loose.tex', 'loose texture'],
    ['materials/common.tex', 'global texture'],
    ['assets/materials/common.tex', 'global texture'],
    ['shaders/common.frag', 'global shader'],
    ['assets/shaders/common.frag', 'global shader'],
  ]) {
    const response = await request(root + path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), body);
  }
  for (const path of ['scene.pkg', 'custom.mpkg']) {
    assert.deepEqual(Buffer.from(await (await request(root + path)).arrayBuffer()), pkg);
  }
  assert.equal((await request(root + 'assets/%2F../project.json')).status, 403);
  assert.equal((await request(root + 'materials/missing.tex')).status, 404);
});

function dispatch(target, type, fields = {}) {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this.paused = true;
    this.messages = [];
    if (tag === 'iframe') {
      this.contentWindow = { postMessage: (data, origin) => this.messages.push({ data, origin }) };
    }
  }

  append(...nodes) {
    this.children.push(...nodes);
    for (const node of nodes) node.parent = this;
  }

  prepend(node) {
    this.children.unshift(node);
    node.parent = this;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  toggleAttribute(name, present) {
    if (present) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }

  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
}

function runtimeHost() {
  const window = new EventTarget();
  const document = new EventTarget();
  const timers = new Map();
  const app = new Element('div');
  app.id = 'root';
  const composer = new Element('div');
  composer.id = 'agy-capsule-native-layout';
  app.append(composer);
  document.body = new Element('body');
  document.body.append(app);
  document.head = new Element('head');
  document.visibilityState = 'visible';
  document.createElement = (tag) => new Element(tag);
  const context = createContext({
    window, document, location: new URL(mainUrl), URL, URLSearchParams,
    setTimeout(callback, timeout) {
      const token = Symbol();
      timers.set(token, { callback, timeout });
      return token;
    },
    clearTimeout: (token) => timers.delete(token),
  });
  return { context, window, document, app, composer, timers };
}

const baseUrl = 'http://127.0.0.1:35200';
function payload(type = 'scene', bg = {}, manifest = { embeddedVideo: 'materials/movie.mp4' }) {
  return {
    baseUrl,
    settings: { enabled: true, activeId: sceneId, bg },
    wallpaper: {
      id: sceneId, type, mediaUrl: `/media/file/${encodedId}/entry.${type === 'web' ? 'html' : 'mp4'}`,
      previewUrl: `/media/preview/${encodedId}`,
    },
    manifest,
  };
}

test('background trusts only its renderer and falls back from an error or timeout to video and preview', () => {
  const { context, window, document, app, composer, timers } = runtimeHost();
  runInContext(runtime, context);
  const api = window.__agyWeBg;
  api.update(payload());
  const [root, originalRoot] = document.body.children;
  const [style] = document.head.children;
  const [content, dim] = root.children;
  const [preview, frame] = content.children;
  assert.equal(root.id, 'agy-we-bg-root');
  assert.equal(style.id, 'agy-we-bg-base-style');
  assert.match(style.textContent, /pointer-events: none/);
  assert.equal(originalRoot, app);
  assert.equal(app.children[0], composer);
  assert.equal(new URL(frame.src).searchParams.get('id'), sceneId);
  const status = (event, source = frame.contentWindow, origin = baseUrl) => dispatch(window, 'message', {
    source, origin, data: { source: 'agy-we-renderer', event },
  });
  dispatch(preview, 'load');
  assert.ok(root.attributes.has('data-visible'));
  status('ready', {});
  status('ready', frame.contentWindow, 'http://127.0.0.1:35201');
  assert.equal(api.getState().mode, 'scene-loading');
  status('ready');
  assert.equal(api.getState().mode, 'scene');
  assert.equal(timers.size, 0);
  api.update(payload('scene', { fit: 'contain', fpsLimit: 16, muted: false, volume: 0.5, blur: 6, opacity: 0.8, dim: 0.4 }));
  assert.equal(content.children[1], frame);
  assert.equal(content.style.filter, 'blur(6px)');
  assert.equal(root.style.opacity, '0.8');
  assert.equal(dim.style.backgroundColor, 'rgba(0, 0, 0, 0.4)');
  assert.equal(frame.messages.findLast(({ data }) => data.action === 'setConfig').data.config.fps, 16);
  document.visibilityState = 'hidden';
  dispatch(document, 'visibilitychange');
  assert.equal(frame.messages.at(-1).data.action, 'pause');
  status('error');
  const embedded = content.children[1];
  assert.equal(api.getState().mode, 'embedded-video');
  assert.equal(embedded.src, `${baseUrl}/media/scene/${encodedId}/materials/movie.mp4`);
  assert.equal(embedded.paused, true);
  document.visibilityState = 'visible';
  dispatch(document, 'visibilitychange');
  assert.equal(embedded.paused, false);
  dispatch(embedded, 'error');
  assert.equal(api.getState().mode, 'preview');
  assert.deepEqual(content.children, [preview]);
  api.destroy();
  assert.deepEqual(document.body.children, [app]);
  assert.deepEqual(document.head.children, []);
  api.update(payload('scene', {}, null));
  const [deadline] = timers.values();
  assert.equal(deadline.timeout, 8000);
  deadline.callback();
  assert.equal(api.getState().mode, 'preview');
  api.update({ settings: { enabled: false } });
  assert.equal(timers.size, 0);
  assert.deepEqual(document.body.children, [app]);
  assert.deepEqual(document.head.children, []);
});

test('background creates image, video and sandboxed web nodes and preserves its single root', () => {
  const { context, window, document, app } = runtimeHost();
  runInContext(runtime, context);
  const api = window.__agyWeBg;
  api.update(payload('video', { fit: 'stretch', volume: 0.4, muted: false }));
  const root = document.body.children[0];
  const video = root.children[0].children[1];
  assert.equal(video.tag, 'video');
  assert.ok(video.autoplay && video.loop && video.playsInline);
  assert.equal(video.volume, 0.4);
  assert.equal(video.muted, false);
  assert.equal(video.style.objectFit, 'fill');
  api.update(payload('web'));
  assert.equal(video.paused, true);
  assert.equal(video.src, '');
  const frame = document.body.children[0].children[0].children[1];
  assert.equal(frame.attributes.get('sandbox'), 'allow-scripts allow-same-origin');
  dispatch(frame, 'load');
  assert.equal(api.getState().mode, 'web');
  api.update(payload('image'));
  const image = document.body.children[0].children[0].children[1];
  dispatch(image, 'load');
  assert.equal(api.getState().mode, 'image');
  assert.deepEqual(document.body.children.map(({ id }) => id), ['agy-we-bg-root', 'root']);
  runInContext(runtime, context);
  assert.equal(window.__agyWeBg, api);
  api.destroy();
  assert.deepEqual(document.body.children, [app]);
});

test('wallpaper switch keeps the last frame while its preview loads and fades in the ready scene', () => {
  const { context, window, document, app, timers } = runtimeHost();
  runInContext(runtime, context);
  const api = window.__agyWeBg;
  api.update(payload('image'));
  const [root] = document.body.children;
  const [oldContent] = root.children;
  const oldImage = oldContent.children[1];
  dispatch(oldImage, 'load');

  api.update(payload('scene'));
  assert.deepEqual(document.body.children, [root, app]);
  const content = root.children.find(node => node.children.some(child => child.tag === 'iframe'));
  const [preview, frame] = content.children;
  assert.ok(root.children.includes(oldContent));
  assert.ok(root.attributes.has('data-visible'));
  assert.equal(frame.style.opacity, '0');
  dispatch(preview, 'load');
  assert.equal(preview.style.opacity, '1');
  assert.match(preview.style.transition, /opacity/);
  dispatch(window, 'message', {
    origin: baseUrl, source: frame.contentWindow, data: { source: 'agy-we-renderer', event: 'ready' },
  });
  assert.equal(frame.style.opacity, '1');
  assert.match(frame.style.transition, /opacity/);
  const [[id, fade]] = timers;
  timers.delete(id);
  fade.callback();
  assert.ok(!root.children.includes(oldContent));

  api.update(payload('video'));
  const loading = root.children.find(node => node.children.some(child => child.tag === 'video'));
  const [stalePreview, staleVideo] = loading.children;
  api.update(payload('web'));
  dispatch(stalePreview, 'load');
  dispatch(staleVideo, 'loadeddata');
  assert.equal(api.getState().mode, 'web-loading');
  assert.ok(root.children.includes(content));
  assert.ok(!root.children.includes(loading));
  api.destroy();
  assert.deepEqual(document.body.children, [app]);
  assert.equal(timers.size, 0);
});

test('ready video gives the new preview a head start and can proceed if the preview stalls', () => {
  const { context, window, document, timers } = runtimeHost();
  runInContext(runtime, context);
  const api = window.__agyWeBg;
  api.update(payload('image'));
  const [root] = document.body.children;
  dispatch(root.children[0].children[1], 'load');

  api.update(payload('video'));
  const [preview, video] = root.children[0].children;
  dispatch(video, 'loadeddata');
  assert.equal(video.style.opacity, '0');
  dispatch(preview, 'load');
  assert.equal(preview.style.opacity, '1');
  assert.equal(video.style.opacity, '1');
  assert.equal(video.style.transitionDelay, '80ms');

  api.update({ ...payload('video'), wallpaper: { ...payload('video').wallpaper, mediaUrl: '/media/file/other.mp4' } });
  const next = root.children[0].children[1];
  dispatch(next, 'loadeddata');
  assert.equal(next.style.opacity, '0');
  const [[id, { callback }]] = timers;
  timers.delete(id);
  callback();
  assert.equal(next.style.opacity, '1');
  assert.equal(video.src, '');
  api.destroy();
  assert.equal(timers.size, 0);
});

test('renderer uses httpSource, reports first frame and stats, and accepts only parent controls', async () => {
  const window = new EventTarget();
  const parent = {};
  const messages = [];
  const calls = [];
  const timers = new Map();
  const origin = new URL(mainUrl).origin;
  parent.postMessage = (data, targetOrigin) => messages.push({ data, targetOrigin });
  window.parent = parent;
  const scene = {
    stats: { fps: 24, running: true },
    on: (event, callback) => { if (event === 'error') scene.fail = callback; },
    load: async (source) => { calls.push(['load', source]); },
  };
  for (const name of ['setFit', 'setFps', 'setVolume', 'pause', 'resume', 'destroy']) {
    scene[name] = (...args) => calls.push([name, ...args]);
  }
  window.WebWallGL = { createScene: () => scene, httpSource: (url) => url };
  runInContext(renderer, createContext({
    window, document: { getElementById: () => ({}), referrer: '' },
    location: new URL(`${baseUrl}/webwallgl/index.html?id=${encodedId}&parentOrigin=${encodeURIComponent(origin)}`),
    URL, URLSearchParams, setInterval: (callback) => { timers.set(1, callback); return 1; },
    clearInterval: (id) => timers.delete(id),
  }));
  await new Promise(setImmediate);
  assert.deepEqual(calls[0], ['load', `${baseUrl}/media/scene-root/${encodedId}`]);
  assert.equal(messages[0].data.event, 'ready');
  assert.equal(messages[0].targetOrigin, origin);
  const control = (action, config, source = parent) => dispatch(window, 'message', {
    source, origin, data: { source: 'agy-we-bg', action, config },
  });
  control('pause', null, {});
  assert.equal(calls.some(([name]) => name === 'pause'), false);
  control('pause');
  control('setConfig', { fps: 24, fit: 'contain', volume: 0.6, muted: false });
  assert.deepEqual(calls.slice(-4), [['pause'], ['setFit', 'contain'], ['setFps', 24], ['setVolume', 0.6]]);
  timers.get(1)();
  assert.equal(messages.at(-1).data.fps, 24);
  scene.fail(new Error('no WebGL context'));
  assert.equal(messages.at(-1).data.event, 'error');
  assert.equal(messages.at(-1).data.message, 'no WebGL context');
  assert.equal(timers.size, 0);
});

function sendFrame(socket, opcode, body) {
  const bytes = Buffer.from(body);
  const header = bytes.length < 126
    ? Buffer.from([0x80 | opcode, bytes.length])
    : Buffer.from([0x80 | opcode, 126, bytes.length >> 8, bytes.length & 255]);
  socket.write(Buffer.concat([header, bytes]));
}

// Only mock CDP text and close frames are needed. The client is Node's native WebSocket.
function receiveFrames(socket, onCommand) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      const size = buffer[1] & 127;
      const header = size === 127 ? 10 : size === 126 ? 4 : 2;
      if (buffer.length < header) return;
      const length = header === 10 ? Number(buffer.readBigUInt64BE(2))
        : header === 4 ? buffer.readUInt16BE(2) : size;
      const start = header + 4;
      if (buffer.length < start + length) return;
      const body = Buffer.from(buffer.subarray(start, start + length));
      for (let index = 0; index < length; index++) body[index] ^= buffer[header + index % 4];
      buffer = buffer.subarray(start + length);
      if (opcode === 8) {
        sendFrame(socket, 8, body);
        socket.end();
        return;
      }
      if (opcode === 1) onCommand(JSON.parse(body.toString()));
    }
  };
}

async function mockCdp(extraTargets = []) {
  const pages = new Map([['main', runtimeHost()]]);
  const connections = new Map();
  const upgrades = [];
  const evaluations = [];
  const targets = [
    { id: 'main', type: 'page', url: mainUrl },
    { id: 'devtools', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
    { id: 'plugin', type: 'page', url: 'plugin://extension/' },
    { id: 'extension', type: 'page', url: 'chrome-extension://extension/index.html' },
    { id: 'other', type: 'page', url: 'https://example.com/c/chat' },
    { id: 'iframe', type: 'iframe', url: mainUrl },
    ...extraTargets,
  ];
  for (const { id } of extraTargets) pages.set(id, runtimeHost());
  const server = createServer((request, response) => {
    assert.equal(request.url, '/json/list');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(targets.map((target) => ({
      ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${target.id}`,
    }))));
  });
  server.on('upgrade', (request, socket, head) => {
    const id = request.url.split('/').at(-1);
    upgrades.push(id);
    connections.set(id, socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      if (connections.get(id) === socket) connections.delete(id);
    });
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const consume = receiveFrames(socket, (command) => {
      let result = {};
      if (command.method === 'Runtime.evaluate') {
        const expression = command.params.expression;
        evaluations.push({ id, expression });
        try {
          result = { result: { value: runInContext(expression, pages.get(id).context, { timeout: 200 }) } };
        } catch (error) {
          result = { exceptionDetails: { text: error.message } };
        }
      }
      sendFrame(socket, 1, JSON.stringify({ id: command.id, result }));
    });
    socket.on('data', consume);
    if (head.length) consume(head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port, pages, targets, connections, upgrades, evaluations,
    navigate(id) {
      pages.set(id, runtimeHost());
      sendFrame(connections.get(id), 1, JSON.stringify({ method: 'Page.frameNavigated', params: { frame: {} } }));
    },
    close() {
      const closing = new Promise((resolve) => server.close(resolve));
      for (const socket of connections.values()) socket.destroy();
      server.closeAllConnections();
      return closing;
    },
  };
}

async function waitFor(check, description) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(15);
  assert.ok(check(), description);
}

test('CDP daemon discovers mock windows, pushes PATCH and disk changes, and reconnects', async (t) => {
  const { dir, media, patch, settingsPath } = await fixture(t);
  const mock = await mockCdp();
  let daemon;
  t.after(async () => {
    try {
      await daemon?.stop();
    } finally {
      await mock.close();
    }
  });
  await patch({ activeId: sceneId });
  const portFile = join(dir, 'fake-antigravity', 'DevToolsActivePort');
  daemon = await startCdpDaemon({ baseUrl: media.baseUrl, portFile, pollIntervalMs: 25, timeoutMs: 1000 });
  await daemon.ready;
  assert.deepEqual(mock.upgrades, [], 'no port file means no connection');
  await save(portFile, `${mock.port}\r\n/devtools/browser/mock\r\n`);
  const firstPage = mock.pages.get('main');
  await waitFor(() => firstPage.window.__agyWeBg?.getState().mode === 'scene-loading', 'runtime injected');
  assert.deepEqual(mock.upgrades, ['main']);
  const root = firstPage.document.body.children[0];
  await patch({ bg: { opacity: 0.7 } });
  await waitFor(() => root.style.opacity === '0.7', 'PATCH updates the original root');
  assert.equal(firstPage.document.body.children[0], root);
  assert.ok(mock.evaluations.some(({ expression }) => expression.startsWith('window.__agyWeBg ?')));

  const stored = JSON.parse(await readFile(settingsPath, 'utf8'));
  await save(settingsPath, JSON.stringify({ ...stored, bg: { ...stored.bg, opacity: 0.6 } }));
  await waitFor(() => root.style.opacity === '0.6', 'direct settings file edit is applied');

  mock.navigate('main');
  const current = mock.pages.get('main');
  await waitFor(() => current.document.body.children[0].id === 'agy-we-bg-root', 'same-URL navigation reinjects');
  mock.connections.get('main').destroy();
  await waitFor(() => mock.upgrades.filter((id) => id === 'main').length === 2, 'closed socket reconnects');

  mock.pages.set('second', runtimeHost());
  mock.targets.push({ id: 'second', type: 'page', url: mainUrl + '/second' });
  const second = mock.pages.get('second');
  await waitFor(() => second.document.body.children[0].id === 'agy-we-bg-root', 'new window inherits settings');
  await daemon.stop();
  await waitFor(() => mock.connections.size === 0, 'mock sockets closed');
  assert.deepEqual(current.document.body.children.map(({ id }) => id), ['root']);
  assert.deepEqual(second.document.body.children.map(({ id }) => id), ['root']);
  for (const { window } of [current, second]) {
    assert.equal(Object.hasOwn(window, '__agyWeBg'), false);
    assert.equal(Object.hasOwn(window, '__agyWePicker'), false);
  }
});

test('CDP daemon applies the theme beyond chat routes and skips media and non-app targets', async (t) => {
  const { dir, media, patch } = await fixture(t);
  const routes = ['/', '/automations', '/customizations', '/skills', '/settings', '/new'];
  const allowed = routes.map((route, index) => ({
    id: 'app-' + index, type: 'page', url: new URL(route, mainUrl).href,
  }));
  const mock = await mockCdp([
    ...allowed,
    { id: 'media', type: 'page', url: media.baseUrl + '/c/renderer' },
    { id: 'about', type: 'page', url: 'about:blank' },
    { id: 'data', type: 'page', url: 'data:text/html,example' },
  ]);
  let daemon;
  t.after(async () => {
    try {
      await daemon?.stop();
    } finally {
      await mock.close();
    }
  });
  await patch({ activeId: sceneId });
  const portFile = join(dir, 'mock-port');
  await save(portFile, String(mock.port));
  daemon = await startCdpDaemon({ baseUrl: media.baseUrl, portFile, once: true });
  await daemon.ready;
  assert.deepEqual(mock.upgrades.toSorted(), ['main', ...allowed.map(({ id }) => id)].toSorted());
  for (const { id } of allowed) {
    const { document } = mock.pages.get(id);
    assert.equal(document.body.attributes.get('data-agy-we-glass'), 'on');
    assert.ok(document.head.children.some(node => node.id === 'agy-we-glass-style'));
  }
});
