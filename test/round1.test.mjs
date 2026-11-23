import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createMediaServer } from '../src/media-server.mjs';
import { openPkg, pkgEntryPayload, PkgFormatError } from '../src/pkg-reader.mjs';

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function sizedString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function packageBytes(files) {
  const headers = [sizedString('PKGV0001'), uint32(Object.keys(files).length)];
  const bodies = [];
  let offset = 0;
  for (const [path, contents] of Object.entries(files)) {
    const bytes = Buffer.from(contents);
    headers.push(sizedString(path), uint32(offset), uint32(bytes.length));
    bodies.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat([...headers, ...bodies]);
}

function compressedBytes() {
  const block = Buffer.from([0x1f, 0x41, 1, 0, 10]);
  return Buffer.concat([uint32(60), uint32(0),
    uint32(30), uint32(block.length), block,
    uint32(30), uint32(block.length), block]);
}

async function save(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

async function project(dir, metadata, files, bom = false) {
  await save(join(dir, 'project.json'), (bom ? '\uFEFF' : '') + JSON.stringify(metadata));
  for (const [name, bytes] of Object.entries(files)) await save(join(dir, name), bytes);
}

const sceneId = encodeURIComponent('workshop:10001');
const videoId = encodeURIComponent('workshop:10002');
const sceneJson = '{"objects":[]}';
const video = '0123456789abcdef';

async function fixture(t, port = 0) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-we-round1-')));
  let media;
  t.after(async () => {
    try {
      await media?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const workshop = join(root, '431960');
  const defaults = join(root, 'defaultprojects');
  const settingsPath = join(root, 'config', 'settings.json');
  const weAssetsDir = join(root, 'assets');
  const sceneDir = join(workshop, '10001');
  await project(sceneDir, {
    type: 'scene', file: 'scene.json', title: '芙莉莲', tags: ['Anime'], contentrating: 'Everyone',
  }, {
    'scene.pkg': packageBytes({
      'scene.json': sceneJson,
      'materials\\背景.tex': 'from package',
      'media/clip.mp4': video,
      'compressed.txt': compressedBytes(),
    }),
    'preview.png': 'scene preview',
    'materials/背景.tex': 'loses to package',
    'materials/loose.json': '{"local":true}',
  }, true);
  await project(join(workshop, '10002'), {
    type: 'video', file: 'videos/影片 01.mp4', title: 'Moon Rise', preview: 'thumb.webp',
  }, { 'videos/影片 01.mp4': video, 'thumb.webp': 'video preview', 'empty.txt': '' });
  await project(join(workshop, '10003'), { type: 'video', file: '../outside.mp4' }, {});
  await save(join(workshop, '10004', 'random.7z'), 'ignored');
  await save(join(workshop, '10005', 'project.json'), '{ broken');
  await save(join(workshop, '10006', 'project.json'), 'null');
  await save(join(workshop, 'outside.mp4'), 'outside');
  await project(join(defaults, 'Ocean'), { type: 'scene', file: 'scene.json' }, {
    'scene.json': '{"loose":true}', 'media/loop.webm': 'loose video', 'preview.gif': 'ocean preview',
  });
  await save(join(weAssetsDir, 'materials', 'shared.tex'), 'WE global asset');
  await save(join(weAssetsDir, 'materials', 'loose.json'), '{"global":true}');

  const options = { port, settingsPath, scanRoots: [workshop, { dir: defaults, source: 'default' }], weAssetsDir };
  media = await createMediaServer(options);
  const request = (path, init) => fetch(`${media.baseUrl}${path}`, init);
  return { media, root, workshop, settingsPath, options, request, sceneDir };
}

function rawGet(url, path) {
  return new Promise((resolve, reject) => {
    get(url, { path }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
      response.once('error', reject);
    }).once('error', reject);
  });
}

function patch(request, body) {
  return request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('loopback health, CORS, BOM metadata, filters, and inventory refresh', async (t) => {
  const { media, workshop, request } = await fixture(t);
  assert.equal(media.server.address().address, '127.0.0.1');
  assert.equal(media.baseUrl, `http://127.0.0.1:${media.port}`);
  const response = await request('/api/health');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const health = await response.json();
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(health, {
    ok: true, version, port: media.port, pid: process.pid, weFound: true, wallpaperCount: 3, roots: [workshop, join(workshop, '..', 'defaultprojects')],
  });
  const preflight = await request('/api/settings', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, X-File-Name');

  const { count, items } = await (await request('/api/wallpapers?type=scene&q=anime')).json();
  assert.equal(count, 1);
  assert.deepEqual(items[0], {
    id: 'workshop:10001', source: 'workshop', type: 'scene', title: '芙莉莲', dir: join(workshop, '10001'),
    entryFile: 'scene.json', hasPkg: true, pkgFile: 'scene.pkg',
    previewUrl: `/media/preview/${sceneId}`, mediaUrl: `/media/scene/${sceneId}/scene.json`,
    sceneManifestUrl: `/api/scene/${sceneId}/manifest`, tags: ['Anime'], contentRating: 'Everyone',
  });
  await project(join(workshop, '10007'), { type: 'image', file: 'photo.jpg' }, { 'photo.jpg': 'photo' });
  assert.equal((await (await request('/api/wallpapers')).json()).count, 3);
  assert.equal((await (await request('/api/wallpapers?refresh=1&type=image')).json()).count, 1);
  assert.equal((await (await request('/api/wallpapers')).json()).count, 4);
});

test('atomic settings PATCH preserves defaults, merges concurrent updates, and survives restart', async (t) => {
  const { media, settingsPath, options, request } = await fixture(t);
  const defaults = await (await request('/api/settings')).json();
  assert.deepEqual(defaults, {
    enabled: true, activeId: null, favorites: [], hiddenIds: [], permanentlyRemovedIds: [], customDirs: [], extraRoots: [],
    bg: { opacity: 1, dim: 0.10, blur: 0, fit: 'cover', muted: true, volume: 0, fpsLimit: 30, pauseOnHidden: true },
    glass: { enabled: true, preset: 'liquid-auto', toneMode: 'auto', blur: 14, surfaceOpacity: 0, sidebarOpacity: 0.44,
      cardOpacity: 0.68, borderGlow: 0.34 },
    slideshow: { enabled: false, intervalSec: 300 },
  });
  const responses = await Promise.all([
    patch(request, { bg: { blur: 9 }, glass: { surfaceOpacity: 0.5 } }),
    patch(request, { bg: { dim: 0.4 }, slideshow: { enabled: true }, activeId: 'workshop:10002' }),
    patch(request, { glass: null }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 400]);
  const expected = {
    ...defaults, activeId: 'workshop:10002', bg: { ...defaults.bg, blur: 9, dim: 0.4 },
    glass: { ...defaults.glass, surfaceOpacity: 0.5 }, slideshow: { ...defaults.slideshow, enabled: true },
  };
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), expected);
  assert.deepEqual(await readdir(dirname(settingsPath)), ['settings.json']);
  await media.close();
  const restarted = await createMediaServer(options);
  t.after(() => restarted.close());
  assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/settings`)).json(), expected);
});

test('preview and direct files have MIME headers and support closed, open and suffix ranges', async (t) => {
  const { request } = await fixture(t);
  const { items: [item] } = await (await request('/api/wallpapers?type=video')).json();
  assert.equal(item.mediaUrl, `/media/file/${videoId}/videos/${encodeURIComponent('影片 01.mp4')}`);
  const preview = await request(item.previewUrl);
  assert.equal(preview.headers.get('content-type'), 'image/webp');
  assert.match(preview.headers.get('cache-control'), /max-age=\d+/);
  assert.equal(await preview.text(), 'video preview');
  const full = await request(item.mediaUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), video);
  for (const [range, bounds, contents] of [
    ['bytes=3-6', '3-6', '3456'], ['bytes=12-', '12-15', 'cdef'], ['bytes=-3', '13-15', 'def'],
  ]) {
    const response = await request(item.mediaUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), `bytes ${bounds}/16`);
    assert.equal(response.headers.get('content-length'), String(contents.length));
    assert.equal(await response.text(), contents);
  }
  const invalid = await request(item.mediaUrl, { headers: { Range: 'bytes=16-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */16');
  const empty = await request(`/media/file/${videoId}/empty.txt`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');
});

test('scene manifests and VFS resolve package, loose, and global resources in order', async (t) => {
  const { request } = await fixture(t);
  const manifest = await (await request(`/api/scene/${sceneId}/manifest`)).json();
  assert.deepEqual(manifest, {
    ok: true, id: 'workshop:10001', title: '芙莉莲', hasPkg: true, entryJsonPath: 'scene.json',
    files: ['compressed.txt', 'materials/loose.json', 'materials/背景.tex', 'media/clip.mp4', 'preview.png', 'scene.json'],
    embeddedVideo: 'media/clip.mp4', previewUrl: `/media/preview/${sceneId}`,
  });
  const base = `/media/scene/${sceneId}/`;
  for (const [path, text] of [
    ['scene.json', sceneJson],
    [`materials/${encodeURIComponent('背景.tex')}`, 'from package'],
    ['materials/loose.json', '{"local":true}'],
    ['materials/shared.tex', 'WE global asset'],
  ]) {
    const response = await request(base + path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), text);
  }
  const clip = await request(base + manifest.embeddedVideo, { headers: { Range: 'bytes=5-8' } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get('content-type'), 'video/mp4');
  assert.equal(await clip.text(), '5678');
  const compressed = await request(base + 'compressed.txt', { headers: { Range: 'bytes=27-33' } });
  assert.equal(compressed.status, 206);
  assert.equal(compressed.headers.get('content-range'), 'bytes 27-33/60');
  assert.equal(await compressed.text(), 'AAAAAAA');
  const loose = await (await request('/api/scene/default%3AOcean/manifest')).json();
  assert.equal(loose.hasPkg, false);
  assert.equal(loose.embeddedVideo, 'media/loop.webm');
  assert.equal(await (await request('/media/scene/default%3AOcean/scene.json')).text(), '{"loose":true}');
  const { items: [looseItem] } = await (await request('/api/wallpapers?q=ocean')).json();
  assert.equal(looseItem.mediaUrl, '/media/file/default%3AOcean/scene.json');
  assert.equal((await request(`/api/scene/${videoId}/manifest`)).status, 404);
});

test('PKG index handles MPKG, archive replacement, and invalid offsets', async (t) => {
  const { workshop, request, sceneDir } = await fixture(t);
  await project(join(workshop, '10008'), { type: 'scene', file: 'main.mpkg' }, {
    'main.mpkg': packageBytes({ 'nested/scene.json': '{"mpkg":true}' }),
  });
  const { items: [item] } = await (await request('/api/wallpapers?refresh=1&q=10008')).json();
  const manifest = await (await request('/api/scene/workshop%3A10008/manifest')).json();
  assert.equal(manifest.hasPkg, true);
  assert.equal(manifest.entryJsonPath, 'nested/scene.json');
  assert.equal(item.mediaUrl, '/media/scene/workshop%3A10008/nested/scene.json');
  assert.equal(await (await request(item.mediaUrl)).text(), '{"mpkg":true}');

  const file = join(sceneDir, 'scene.pkg');
  const first = await openPkg(file);
  try {
    const { size, stream } = await pkgEntryPayload(first.file, first.entries.get('scene.json'));
    const chunks = [];
    for await (const chunk of stream(0, size - 1)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), sceneJson);
  } finally {
    await first.file.close();
  }
  await save(file, packageBytes({ 'scene.json': '{"replacement":true}' }));
  assert.equal(await (await request(`/media/scene/${sceneId}/scene.json`)).text(), '{"replacement":true}');

  const invalid = packageBytes({ 'scene.json': sceneJson });
  invalid.writeUInt32LE(0xffffffff, sizedString('PKGV0001').length + 4 + sizedString('scene.json').length);
  await save(file, invalid);
  await assert.rejects(openPkg(file), PkgFormatError);
  await save(join(sceneDir, 'scene.json'), '{"fallback":true}');
  assert.equal(await (await request(`/media/scene/${sceneId}/scene.json`)).text(), '{"fallback":true}');
});

test('encoded traversal and links outside wallpaper roots do not serve files', async (t) => {
  const { media, sceneDir, workshop, root, request } = await fixture(t);
  await save(join(root, 'private', 'secret.txt'), 'never served');
  await symlink(join(root, 'private'), join(sceneDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [
    `/media/file/${videoId}/../outside.mp4`,
    `/media/file/${videoId}/%2e%2e/outside.mp4`,
    `/media/file/${videoId}/%2e%2e%5coutside.mp4`,
    `/media/file/${videoId}/C%3A%5coutside.mp4`,
    `/media/file/${videoId}/videos/${encodeURIComponent('影片 01.mp4') }%3Astream`,
    `/media/scene/${sceneId}/%2e%2e%2foutside.mp4`,
    '/vendor/webwallgl/%2e%2e/webwallgl/package.json',
  ]) {
    const response = await rawGet(media.baseUrl, path);
    assert.equal(response.statusCode, 403, path);
    assert.equal(response.headers['access-control-allow-origin'], '*');
  }
  assert.equal((await request(`/media/file/${sceneId}/linked/secret.txt`)).status, 404);
  assert.equal((await request(`/media/scene/${sceneId}/linked/secret.txt`)).status, 404);
  const manifest = await (await request(`/api/scene/${sceneId}/manifest`)).json();
  assert.ok(manifest.files.every((name) => !name.startsWith('linked/')));
  assert.equal((await (await request('/api/wallpapers')).json()).items.some(({ dir }) => dir === join(workshop, '10003')), false);
});

test('settings add custom projects and local web HTML is served sandboxed', async (t) => {
  const { root, request } = await fixture(t);
  const custom = join(root, 'custom');
  await project(join(custom, 'Website'), { type: 'web', file: 'index.html' }, {
    'index.html': '<script src="scripts/main.js"></script>', 'scripts/main.js': 'console.log("wallpaper")',
  });
  await save(join(custom, 'Local image.jpg'), 'image');
  await project(join(custom, 'Picture preset'), { type: 'preset', preset: { image: 'photo.png' } }, {
    'photo.png': 'preset image',
  });
  const extra = join(root, 'other', '431960');
  await project(join(extra, '20001'), { type: 'image', file: 'photo.jpg' }, { 'photo.jpg': 'extra image' });
  assert.equal((await (await request('/api/wallpapers')).json()).count, 3);
  assert.equal((await patch(request, { customDirs: [custom], extraRoots: [extra] })).status, 200);
  const { count, items } = await (await request('/api/wallpapers')).json();
  assert.equal(count, 7);
  const web = items.find((item) => item.type === 'web');
  assert.equal(web.source, 'custom');
  assert.equal(web.sceneManifestUrl, null);
  const html = await request(web.mediaUrl);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.match(html.headers.get('content-security-policy'), /^sandbox allow-scripts;/);
  assert.match(await html.text(), /scripts\/main\.js/);
  assert.equal(await (await request(web.mediaUrl.replace('index.html', 'scripts/main.js'))).text(), 'console.log("wallpaper")');
  const localImage = items.find(({ title }) => title === 'Local image');
  assert.equal(await (await request(localImage.previewUrl)).text(), 'image');
  const preset = items.find(({ title }) => title === 'Picture preset');
  assert.equal(await (await request(preset.mediaUrl)).text(), 'preset image');
  assert.equal(items.find(({ id }) => id === 'workshop:20001').type, 'image');
});

test('WebWallGL vendor routes serve installed modules and nested images', async (t) => {
  const { request } = await fixture(t);
  for (const name of ['webwallgl.mjs', 'webwallgl.global.min.js']) {
    const module = await request(`/vendor/webwallgl/${name}`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.ok((await module.arrayBuffer()).byteLength > 0);
  }
  const images = await readdir(new URL('../node_modules/webwallgl/imgs/', import.meta.url), { withFileTypes: true });
  const image = images.find((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
  assert.ok(image);
  const response = await request(`/vendor/webwallgl/imgs/${encodeURIComponent(image.name)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\//);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});

test('occupied requested port falls back to a different loopback port and close is idempotent', async (t) => {
  const { media, options } = await fixture(t);
  const fallback = await createMediaServer({ ...options, port: media.port });
  t.after(() => fallback.close());
  assert.notEqual(fallback.port, media.port);
  assert.equal(fallback.server.address().address, '127.0.0.1');
  const health = await fetch(`${fallback.baseUrl}/api/health`);
  assert.equal((await health.json()).port, fallback.port);
  await Promise.all([fallback.close(), fallback.close()]);
});
