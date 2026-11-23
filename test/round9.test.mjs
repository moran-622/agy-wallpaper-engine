import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createConfigStore } from '../src/config-store.mjs';

const exec = promisify(execFile);
const [renderer, runtime, css] = await Promise.all(
  ['webwallgl-host/renderer.js', 'bg-runtime.js', 'glass-theme.css']
    .map((path) => readFile(new URL('../src/' + path, import.meta.url), 'utf8')),
);
const baseUrl = 'http://127.0.0.1:18765';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-we-round9-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('daemon CLI registers its PID and install can find, reuse and stop it without a PID file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-we-round9-daemon-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: dir };
  const dataDir = join(dir, '.gemini', 'antigravity', 'wallpaper-engine');
  const pidFile = join(dataDir, 'daemon.pid');
  const metaFile = join(dataDir, 'daemon-meta.json');
  const cli = fileURLToPath(new URL('../src/daemon-cli.mjs', import.meta.url));
  const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));
  const daemon = spawn(process.execPath, [cli, '--port', '0', '--once', '--port-file', join(dir, 'missing-port')], { env });
  const closed = once(daemon, 'close');
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    try {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
      await closed;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  let output = '';
  for await (const chunk of daemon.stdout) {
    output += chunk;
    if (output.includes('Single CDP discovery pass finished.')) break;
  }
  const url = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(url, output || stderr);
  const port = Number(new URL(url).port);
  const health = await fetch(url + '/api/health').then((r) => r.json());
  assert.equal(health.pid, daemon.pid);
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(meta.pid, daemon.pid);
  assert.equal(meta.baseUrl, url);
  assert.equal(meta.port, port);
  assert.ok(Number.isFinite(Date.parse(meta.startedAt)));
  assert.equal(await readFile(pidFile, 'utf8'), String(daemon.pid));

  async function install(command) {
    const { stdout } = await exec(process.execPath, [installer, command, '--port', String(port)], { env, timeout: 10000 });
    return JSON.parse(stdout);
  }
  await rm(pidFile);
  await rm(metaFile);
  const status = await install('status');
  assert.equal(status.running, true);
  assert.equal(status.pid, daemon.pid);
  await writeFile(metaFile, JSON.stringify(meta));
  await writeFile(pidFile, 'stale');
  const start = await install('start');
  assert.equal(start.alreadyRunning, true);
  assert.equal(start.pid, daemon.pid);
  assert.equal(await readFile(pidFile, 'utf8'), String(daemon.pid));
  assert.deepEqual(JSON.parse(await readFile(metaFile, 'utf8')), meta);

  await rm(pidFile);
  assert.equal((await install('stop')).stoppedPid, daemon.pid);
  await closed;
});

test('particle draws reset a patched value for RGBA8 and keep an explicit value on ordinary textures', () => {
  const calls = [];
  const location = {};
  const gl = {
    TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, R8: 0x8229, RG8: 0x822b, RGBA8: 0x8058,
    getUniformLocation: () => location,
    activeTexture() {}, bindTexture() {}, texImage2D() {}, shaderSource() {}, useProgram() {},
    uniform1i: (loc, value) => calls.push([loc, value]),
    drawArraysInstanced: () => calls.push('draw'),
  };
  const canvas = { getContext: () => gl };
  const window = new EventTarget();
  window.parent = { postMessage() {} };
  window.WebWallGL = {
    httpSource: (url) => url,
    createScene: (node) => {
      node.getContext('webgl2');
      return { on() {}, load: async () => {}, setFit() {}, setFps() {}, setVolume() {}, resume() {} };
    },
  };
  runInNewContext(renderer, {
    window, document: { getElementById: () => canvas, referrer: '' },
    location: new URL('/webwallgl/index.html?id=workshop:123', baseUrl),
    URL, URLSearchParams, setInterval: () => 1,
  });
  const program = {};
  gl.useProgram(program);
  const albedo = gl.getUniformLocation(program, 'u_albedoR8');
  const rg8 = {}, rgba8 = {};
  gl.bindTexture(gl.TEXTURE_2D, rgba8);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1);
  gl.bindTexture(gl.TEXTURE_2D, rg8);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 1, 1);
  gl.drawArraysInstanced(4, 0, 6, 3);
  assert.deepEqual(calls.slice(-2), [[albedo, 2], 'draw']);

  gl.uniform1i(albedo, 0);
  gl.bindTexture(gl.TEXTURE_2D, rgba8);
  gl.drawArraysInstanced(4, 0, 6, 3);
  assert.deepEqual(calls.slice(-2), [[albedo, 0], 'draw']);

  gl.uniform1i(albedo, 1);
  gl.drawArraysInstanced(4, 0, 6, 3);
  assert.deepEqual(calls.slice(-2), [[albedo, 1], 'draw']);
});

test('inset canvas respects the surface tint while browser holes stay transparent', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const transparent = /\bbackground(?:-color)?:\s*transparent\s*!important/;
  const canvas = '.agy-inset-shell .agy-sheet[data-sheet-inset] [data-main-content-body]';
  assert.ok(rules.some(([, selectors, declarations]) => selectors.includes('[data-main-content-body]')
    && /background-color:\s*var\(--agy-surface-bg\)/.test(declarations)));
  assert.ok(!rules.some(([, selectors, declarations]) => transparent.test(declarations)
    && selectors.split(',').some((selector) => selector.trim().endsWith(canvas))));
  assert.ok(rules.some(([, selectors, declarations]) => transparent.test(declarations)
    && selectors.includes('[data-browser-hole="true"]')
    && selectors.includes('[data-main-content-body][data-has-browser-hole="true"]')));
});

class Element extends EventTarget {
  style = {};
  children = [];
  paused = true;

  constructor(tag) {
    super();
    this.tag = tag;
    if (tag === 'iframe') this.contentWindow = { postMessage() {} };
  }

  append(...nodes) {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }

  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  }

  remove() {
    this.parent.children = this.parent.children.filter((node) => node !== this);
  }

  setAttribute() {}
  toggleAttribute() {}
  removeAttribute() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
}

function background() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    body: new Element('body'), head: new Element('head'), createElement: (tag) => new Element(tag),
  });
  const timers = new Map();
  runInNewContext(runtime, {
    window, document, URL, URLSearchParams, location: new URL('https://localhost/chat'),
    setTimeout(callback, delay) {
      const token = Symbol();
      timers.set(token, { callback, delay });
      return token;
    },
    clearTimeout: (token) => timers.delete(token),
  });
  const api = window.__agyWeBg;
  return {
    api, timers, body: document.body,
    message(frame, event) {
      window.dispatchEvent(Object.assign(new Event('message'), {
        origin: baseUrl, source: frame.contentWindow, data: { source: 'agy-we-renderer', event },
      }));
    },
    select(id, type, manifest) {
      api.update({
        baseUrl, settings: { enabled: true, activeId: id },
        wallpaper: { id, type, mediaUrl: '/media/' + id }, manifest,
      });
    },
  };
}

test('late scene manifest keeps the ready iframe and supplies its video fallback', () => {
  const { api, body, message, select } = background();
  select('workshop:123', 'scene', null);
  const [root] = body.children;
  const [content] = root.children;
  const [frame] = content.children;
  message(frame, 'ready');
  select('workshop:123', 'scene', { embeddedVideo: 'materials/movie file.mp4' });
  assert.equal(root.children[0], content);
  assert.equal(content.children[0], frame);
  assert.equal(api.getState().mode, 'scene');
  message(frame, 'error');
  assert.equal(content.children[0].tag, 'video');
  assert.equal(content.children[0].src, baseUrl + '/media/scene/workshop%3A123/materials/movie%20file.mp4');
});

test('rapid wallpaper switches release the oldest artwork and finish the latest fade', () => {
  const { body, select, timers } = background();
  select('a', 'image');
  const [root] = body.children;
  const [oldest] = root.children;
  oldest.children[0].dispatchEvent(new Event('load'));
  select('b', 'image');
  root.children[0].children[0].dispatchEvent(new Event('load'));
  assert.equal([...timers.values()][0].delay, 240);
  select('c', 'image');
  assert.ok(!root.children.includes(oldest));
  const [latest] = root.children;
  latest.children[0].dispatchEvent(new Event('load'));
  for (const [token, { callback }] of timers) {
    timers.delete(token);
    callback();
  }
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0], latest);
  assert.ok(!root.children.some((node) => node.style.zIndex === '-1'));
});

test('settings store backs up broken JSON and accepts writes after recovery', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'settings.json');
  const store = createConfigStore(file);
  const defaults = await store.read();
  const corrupt = '\uFEFF{"bg":{"opacity":';
  await writeFile(file, corrupt);
  assert.deepEqual(await Promise.all([store.read(), createConfigStore(file).read()]), [defaults, defaults]);
  const backups = (await readdir(dir)).filter((name) => /^settings\.json\.corrupt\.\d+\.bak$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), corrupt);
  const updated = await store.patch({ bg: { opacity: 0.7 } });
  assert.equal(updated.bg.opacity, 0.7);
  assert.deepEqual(await store.read(), updated);
});

test('numeric settings clamp to runtime limits and fall back to defaults for invalid values', async (t) => {
  const file = join(await tempDir(t), 'settings.json');
  const store = createConfigStore(file);
  await writeFile(file, '{"bg":{"opacity":8,"dim":-1,"blur":200,"volume":"0.7","fpsLimit":1e999},'
    + '"glass":{"blur":-2,"surfaceOpacity":4,"sidebarOpacity":-1,"cardOpacity":2,"borderGlow":1},'
    + '"slideshow":{"intervalSec":10}}');
  const settings = await store.read();
  assert.deepEqual(settings.bg, {
    opacity: 1, dim: 0, blur: 100, fit: 'cover', muted: true, volume: 0, fpsLimit: 30, pauseOnHidden: true,
  });
  assert.deepEqual(settings.glass, {
    enabled: true, preset: 'liquid-auto', toneMode: 'auto', blur: 0, surfaceOpacity: 0.75,
    sidebarOpacity: 0.12, cardOpacity: 0.94, borderGlow: 0.6,
  });
  assert.equal(settings.slideshow.intervalSec, 60);
  const updated = await store.patch({
    bg: { opacity: -1, fpsLimit: 24, blur: Infinity, dim: NaN, volume: 3 },
    glass: { surfaceOpacity: null },
    slideshow: { intervalSec: 1e6 },
  });
  assert.deepEqual(updated.bg, { ...settings.bg, opacity: 0, fpsLimit: 24, blur: 0, dim: 0.10, volume: 1 });
  assert.equal(updated.glass.surfaceOpacity, 0);
  assert.equal(updated.slideshow.intervalSec, 86400);
  assert.deepEqual(await store.read(), updated);
});
