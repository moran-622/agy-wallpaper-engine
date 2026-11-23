import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parsePort } from '../src/cli-port.mjs';
import { createConfigStore } from '../src/config-store.mjs';
import { createMediaServer } from '../src/media-server.mjs';
import { scanWallpapers } from '../src/we-scanner.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-we-r10-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function projects(dir) {
  return Promise.all(['workshop', 'default', 'custom'].map(async (source) => {
    const root = join(dir, source);
    const project = join(root, 'clip');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ type: 'video', file: 'clip.mp4' }));
    await writeFile(join(project, 'clip.mp4'), source);
    return { dir: root, source };
  }));
}

async function fixture(t) {
  const dir = await tempDir(t);
  const settingsPath = join(dir, 'settings.json');
  const media = await createMediaServer({ port: 0, settingsPath, scanRoots: await projects(dir) });
  t.after(() => media.close());
  const request = (path, options) => fetch(media.baseUrl + path, options);
  const send = (path, method, body, origin) => request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) },
    body: JSON.stringify(body),
  });
  const library = async (query = '') => {
    const response = await request('/api/wallpapers' + query);
    assert.equal(response.status, 200);
    return response.json();
  };
  const edit = async (action, body) => {
    const response = await send('/api/wallpapers/' + action, 'POST', body);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { dir, request, send, library, edit };
}

test('hiding single and batch external wallpapers updates visibility, favorites and active selection', async (t) => {
  const { library, edit, send } = await fixture(t);
  const { items } = await library();
  assert.equal(items.length, 3);
  const [first, active, next] = items.map(({ id }) => id);
  assert.equal((await send('/api/settings', 'PATCH', { activeId: active, favorites: [active, next] })).status, 200);

  const single = await edit('hide', { id: active });
  assert.equal(single.ok, true);
  assert.equal(single.nextActiveId, next);
  assert.equal(single.settings.activeId, next);
  assert.deepEqual(single.settings.favorites, [next]);
  assert.deepEqual((await library()).items.map(({ id }) => id), [first, next]);
  assert.equal((await library()).activeId, next);
  assert.equal((await library()).hiddenCount, 1);

  const batch = await edit('hide', { ids: [first, next, next, 'unknown', ''] });
  assert.equal(batch.hiddenCount, 3);
  assert.equal(batch.nextActiveId, null);
  assert.equal(batch.settings.activeId, null);
  assert.deepEqual(batch.settings.favorites, []);
  assert.deepEqual(batch.settings.hiddenIds, [active, first, next]);
  assert.equal((await library()).count, 0);
  assert.deepEqual((await library('?includeHidden=1')).items, items);
  assert.equal((await library('?includeHidden=1')).hiddenCount, 3);
  for (const item of items) assert.equal(await readFile(join(item.dir, item.entryFile), 'utf8'), item.source);
});

test('unhide restores one, multiple or all wallpapers', async (t) => {
  const { library, edit } = await fixture(t);
  const { items } = await library();
  const [first, second, third] = items.map(({ id }) => id);
  await edit('hide', { ids: [first, second, third] });
  assert.equal((await edit('unhide', { id: first })).hiddenCount, 2);
  assert.deepEqual((await library()).items, [items[0]]);
  assert.deepEqual((await edit('unhide', { ids: [second, second] })).settings.hiddenIds, [third]);
  assert.equal((await edit('unhide', { all: true })).hiddenCount, 0);
  assert.deepEqual((await library()).items, items);
});

test('writes reject external origins and allow loopback or no origin', async (t) => {
  const { library, send } = await fixture(t);
  const { items: [{ id }] } = await library();
  for (const [path, method, body] of [
    ['/api/settings', 'PATCH', { enabled: false }],
    ['/api/wallpapers/hide', 'POST', { id }],
    ['/api/wallpapers/unhide', 'POST', { all: true }],
  ]) {
    assert.equal((await send(path, method, body, 'https://example.test')).status, 403);
    assert.equal((await send(path, method, body, 'null')).status, 403);
    assert.equal((await send(path, method, body, 'https://127.0.0.1:9000')).status, 200);
    assert.equal((await send(path, method, body, 'http://localhost:9000')).status, 200);
    assert.equal((await send(path, method, body)).status, 200);
  }
});

test('deleting the active upload advances to a visible wallpaper and removes the upload file', async (t) => {
  const { dir, library, request, send, edit } = await fixture(t);
  const { items: [first, next] } = await library();
  const response = await request('/api/uploads', {
    method: 'POST', headers: { 'X-File-Name': 'clip.mp4', 'Content-Type': 'video/mp4' }, body: 'upload',
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.deepEqual((await edit('hide', { ids: [first.id, uploaded.id] })).settings.hiddenIds, [first.id, uploaded.id]);
  assert.equal((await send('/api/settings', 'PATCH', { activeId: uploaded.id, favorites: [uploaded.id] })).status, 200);
  assert.equal((await request('/api/uploads/' + encodeURIComponent(uploaded.id), { method: 'DELETE' })).status, 204);
  const settings = await (await request('/api/settings')).json();
  assert.equal(settings.activeId, next.id);
  assert.deepEqual(settings.favorites, []);
  assert.deepEqual(await readdir(join(dir, 'uploads')), ['index.json']);
});

test('schema-invalid JSON is backed up and settings recover with sanitized hidden IDs', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'settings.json');
  const store = createConfigStore(file);
  const defaults = await store.read();
  assert.deepEqual(defaults.hiddenIds, []);
  for (const value of [{ glass: { toneMode: 'invalid' } }, []]) {
    const input = JSON.stringify(value);
    await writeFile(file, input);
    assert.deepEqual(await store.read(), defaults);
    const backups = (await readdir(dir)).filter((name) => /^settings\.json\.corrupt\.\d+\.bak$/.test(name));
    assert.equal(backups.length, 1);
    const backup = join(dir, backups[0]);
    assert.equal(await readFile(backup, 'utf8'), input);
    await rm(backup);
  }
  await store.patch({ hiddenIds: ['default:clip', '', '  ', 'default:clip'] });
  assert.deepEqual((await store.read()).hiddenIds, ['default:clip']);
});

for (const [script, name, expectedVersion, previousVersion] of [
  ['bg-runtime.js', '__agyWeBg', '2026.11.r10', '2026.11.r9'],
  ['picker-ui.js', '__agyWePicker', '2026.11.r11b', '2026.11.r11'],
]) {
  test(`${script} replaces legacy versions and makes same-version injection idempotent`, async () => {
    const code = await readFile(new URL('../src/' + script, import.meta.url), 'utf8');
    for (const version of [undefined, previousVersion]) {
      let destroyed = 0;
      const old = { version, destroy() { destroyed++; throw new Error('legacy cleanup failed'); } };
      if (name === '__agyWeBg') old.setTheme = () => {};
      const window = { [name]: old };
      runInNewContext(code, { window });
      const api = window[name];
      assert.equal(destroyed, 1);
      assert.notEqual(api, old);
      assert.equal(api.version, expectedVersion);
      runInNewContext(code, { window });
      assert.equal(window[name], api);
      assert.equal(destroyed, 1);
    }
  });
}

test('wallpapers without a preview file have no preview URL', async (t) => {
  const scanRoots = await projects(await tempDir(t));
  const { records } = await scanWallpapers({ scanRoots });
  assert.equal(records.size, 3);
  for (const { item, previewFile } of records.values()) {
    assert.equal(previewFile, null);
    assert.equal(item.previewUrl, null);
  }
});

test('installer and daemon port validation accepts the bounds and rejects invalid strings', () => {
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort('0'), 0);
  assert.equal(parsePort('65535'), 65535);
  for (const invalid of ['', '-1', '65536', '1.5', '1e3', 'localhost']) {
    assert.throws(() => parsePort(invalid), /--port must be an integer from 0 to 65535/);
  }
});
