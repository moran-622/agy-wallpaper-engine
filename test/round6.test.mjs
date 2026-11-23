import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMediaServer } from '../src/media-server.mjs';

test('glass shell fixes keep the wallpaper clear and inner surfaces unblurred', async () => {
  const css = await readFile(new URL('../src/glass-theme.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarations = (selector) => rules.filter(([, selectors]) => selectors.includes(selector))
    .map(([, , properties]) => properties).join('\n');
  assert.match(declarations('[data-testid="title-menu-bar"].bg-sidebar'), /backdrop-filter: blur\(/);
  assert.match(declarations('div:has([data-testid="title-menu-bar"])'), /z-index: 90 !important/);
  assert.match(declarations(':is([role="dialog"], .agy-dialog) div.bg-sidebar'), /\/ 0\.24\).*backdrop-filter: none/s);
  assert.match(declarations('[data-testid="pane-titlebar-toolbar"]'), /background-color: var\(--agy-composer-bg\)/);
  assert.match(declarations('[data-testid="agent-response"] + div'), /width: fit-content.*backdrop-filter: none/s);
  assert.match(declarations('[data-main-content-body]'), /backdrop-filter: none !important/);
  assert.doesNotMatch(declarations('[data-main-content-body]'), /backdrop-filter: blur\(/);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-round6-'));
  const options = { port: 0, scanRoots: [], settingsPath: join(dir, 'settings.json') };
  const media = await createMediaServer(options);
  t.after(async () => {
    await media.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path, init) => fetch(media.baseUrl + path, init);
  const patch = changes => request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  const upload = (name, body, mime) => request('/api/uploads', {
    method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': mime }, body,
  });
  return { dir, options, media, request, patch, upload };
}

test('legacy settings get default glass tone and favorites, and invalid values return 400', async t => {
  const { options, request, patch } = await fixture(t);
  await writeFile(options.settingsPath, JSON.stringify({ glass: { blur: 18 } }));
  const settings = await (await request('/api/settings')).json();
  assert.equal(settings.glass.toneMode, 'auto');
  assert.equal(settings.glass.surfaceOpacity, 0);
  assert.equal(settings.glass.blur, 18);
  assert.deepEqual(settings.favorites, []);
  assert.equal((await patch({ glass: { toneMode: 'sepia' } })).status, 400);
  assert.equal((await patch({ glass: { toneMode: 1 } })).status, 400);
  assert.equal((await patch({ favorites: ['default:one', 2] })).status, 400);
  for (const toneMode of ['dark', 'light', 'auto']) {
    const response = await patch({ glass: { toneMode }, favorites: ['default:two', 'custom:one'] });
    assert.equal(response.status, 200);
    const saved = JSON.parse(await readFile(options.settingsPath, 'utf8'));
    assert.equal(saved.glass.toneMode, toneMode);
    assert.deepEqual(saved.favorites, ['default:two', 'custom:one']);
  }
});

test('concurrent uploads persist across restart, use scoped media paths and retain video Range support', async t => {
  const { dir, options, media, request, patch, upload } = await fixture(t);
  assert.equal((await (await request('/api/wallpapers')).json()).count, 0);
  const responses = await Promise.all([
    upload('C:\\fakepath\\海 岸.JPG', Buffer.from('test image bytes'), 'image/jpeg'),
    upload('夜空.MP4', Buffer.from('0123456789'), 'video/mp4'),
  ]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const [image, video] = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual([image.title, image.type, image.source], ['海 岸', 'image', 'upload']);
  assert.equal(image.previewUrl, image.mediaUrl);
  assert.deepEqual([video.title, video.type, video.source], ['夜空', 'video', 'upload']);
  const index = JSON.parse(await readFile(join(dir, 'uploads', 'index.json'), 'utf8'));
  assert.deepEqual(new Set(index.map(({ id }) => id)), new Set([image.id, video.id]));
  for (const entry of index) {
    assert.equal(entry.file, entry.id.slice('upload:'.length) + (entry.type === 'image' ? '.jpg' : '.mp4'));
    assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  }
  const picture = await request(image.previewUrl);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.equal(await picture.text(), 'test image bytes');
  assert.equal((await request(image.mediaUrl.replace(image.entryFile, 'index.json'))).status, 404);
  assert.equal((await request(image.mediaUrl.replace(image.entryFile, video.entryFile))).status, 404);
  const stream = await request(video.mediaUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(stream.status, 206);
  assert.equal(stream.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(stream.headers.get('content-type'), 'video/mp4');
  assert.equal(await stream.text(), '2345');
  assert.equal((await patch({ activeId: video.id, favorites: [image.id, video.id] })).status, 200);

  await media.close();
  const restarted = await createMediaServer(options);
  t.after(() => restarted.close());
  const afterRestart = (path, init) => fetch(restarted.baseUrl + path, init);
  assert.deepEqual((await (await afterRestart('/api/wallpapers?type=image&q=%E6%B5%B7')).json()).items, [image]);
  const deleteUrl = '/api/uploads/' + encodeURIComponent(video.id);
  assert.equal((await afterRestart(deleteUrl, { method: 'DELETE' })).status, 204);
  assert.equal((await afterRestart(deleteUrl, { method: 'DELETE' })).status, 404);
  assert.equal((await afterRestart(video.mediaUrl)).status, 404);
  assert.deepEqual((await (await afterRestart('/api/wallpapers?refresh=1')).json()).items, [image]);
  const settings = await (await afterRestart('/api/settings')).json();
  assert.equal(settings.activeId, image.id);
  assert.deepEqual(settings.favorites, [image.id]);
  assert.deepEqual((await readdir(join(dir, 'uploads'))).sort(), [image.entryFile, 'index.json'].sort());
});

test('upload validation rejects unsupported, empty, and oversized requests without committing files', async t => {
  const { dir, media, request, upload } = await fixture(t);
  assert.equal((await upload('page.svg', Buffer.from('test'), 'image/svg+xml')).status, 400);
  assert.equal((await upload('photo.png', Buffer.from('test'), 'text/html')).status, 400);
  assert.equal((await upload('empty.webp', Buffer.alloc(0), 'image/webp')).status, 400);
  assert.equal((await request('/api/uploads/upload%3A..%2Findex.json', { method: 'DELETE' })).status, 400);
  assert.equal((await request('/api/uploads', {
    method: 'POST', headers: { Origin: 'https://example.invalid', 'X-File-Name': 'photo.png', 'Content-Type': 'image/png' },
    body: Buffer.from('test'),
  })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(media.baseUrl + '/api/uploads', {
      method: 'POST',
      headers: { 'X-File-Name': 'large.mp4', 'Content-Type': 'video/mp4', 'Content-Length': 200 * 1024 * 1024 + 1 },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 413);
  assert.deepEqual(await readdir(join(dir, 'uploads')), []);
  assert.deepEqual((await (await request('/api/wallpapers')).json()).items, []);
});
