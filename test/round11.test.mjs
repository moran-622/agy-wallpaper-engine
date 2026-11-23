import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfigStore, SettingsValidationError } from '../src/config-store.mjs';
import { createMediaServer } from '../src/media-server.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-we-r11-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t) {
  const dir = await tempDir(t);
  const scanRoots = await Promise.all(['workshop', 'default', 'custom'].map(async (source) => {
    const root = join(dir, source);
    const project = join(root, 'clip');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ type: 'video', file: 'clip.mp4', title: source }));
    await writeFile(join(project, 'clip.mp4'), source);
    return { dir: root, source };
  }));
  const media = await createMediaServer({ port: 0, settingsPath: join(dir, 'settings.json'), scanRoots });
  t.after(() => media.close());
  const request = (path, options) => fetch(media.baseUrl + path, options);
  const send = (path, body, method = 'POST', origin) => request(path, {
    method, headers: { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) },
    body: JSON.stringify(body),
  });
  const library = async (query = '') => {
    const response = await request('/api/wallpapers' + query);
    assert.equal(response.status, 200);
    return response.json();
  };
  const edit = async (action, body) => {
    const response = await send('/api/wallpapers/' + action, body);
    assert.equal(response.status, 200);
    return response.json();
  };
  const patch = async (settings) => {
    const response = await send('/api/settings', settings, 'PATCH');
    assert.equal(response.status, 200);
  };
  const upload = async () => {
    const response = await request('/api/uploads', {
      method: 'POST', headers: { 'X-File-Name': 'local.mp4', 'Content-Type': 'video/mp4' }, body: 'local video',
    });
    assert.equal(response.status, 201);
    const item = await response.json();
    assert.equal(item.source, 'upload');
    assert.match(item.id, /^upload:/);
    return item;
  };
  return { uploads: join(dir, 'uploads'), library, edit, patch, upload, send };
}

test('moving an active local upload to trash preserves the file and allows restoration', async (t) => {
  const { uploads, library, edit, patch, upload } = await fixture(t);
  const { items: [next] } = await library();
  const item = await upload();
  const path = join(uploads, item.entryFile);
  await patch({ activeId: item.id, favorites: [item.id, next.id] });

  const hidden = await edit('hide', { id: item.id });
  assert.equal(hidden.hiddenCount, 1);
  assert.equal(hidden.nextActiveId, next.id);
  assert.deepEqual(hidden.settings.favorites, [next.id]);
  assert.equal(await readFile(path, 'utf8'), 'local video');
  assert.equal((await library()).items.some(({ id }) => id === item.id), false);
  assert.equal((await library()).hiddenCount, 1);
  assert.deepEqual((await library('?trash=1&includeHidden=1')).items, [item]);

  assert.equal((await edit('unhide', { id: item.id })).hiddenCount, 0);
  assert.deepEqual((await library('?trash=1')).items, []);
  assert.deepEqual((await library()).items.find(({ id }) => id === item.id), item);
  assert.equal(await readFile(path, 'utf8'), 'local video');
  assert.deepEqual((await edit('purge', { id: item.id })).purgedIds, []);
  assert.equal(await readFile(path, 'utf8'), 'local video');
});

test('purging a trashed upload removes its file, index entry and settings references', async (t) => {
  const { uploads, library, edit, patch, upload } = await fixture(t);
  const { items: [next] } = await library();
  const { id } = await upload();
  await edit('hide', { id });
  await patch({ activeId: id, favorites: [id] });

  const purged = await edit('purge', { id });
  assert.equal(purged.ok, true);
  assert.deepEqual(purged.purgedIds, [id]);
  assert.deepEqual(purged.settings.hiddenIds, []);
  assert.deepEqual(purged.settings.favorites, []);
  assert.deepEqual(purged.settings.permanentlyRemovedIds, []);
  assert.equal(purged.nextActiveId, next.id);
  assert.equal(purged.settings.activeId, next.id);
  assert.deepEqual(await readdir(uploads), ['index.json']);
  assert.deepEqual(JSON.parse(await readFile(join(uploads, 'index.json'), 'utf8')), []);
  assert.equal((await library()).items.some((item) => item.id === id), false);
  assert.deepEqual((await library('?trash=1')).items, []);
});

test('purging workshop and built-in wallpapers preserves their original files and excludes them from every listing', async (t) => {
  const { library, edit, patch } = await fixture(t);
  const { items } = await library();
  const targets = items.filter(({ source }) => source !== 'custom');
  const ids = targets.map(({ id }) => id);
  const remaining = items.filter(({ source }) => source === 'custom');
  await patch({ hiddenIds: [...ids, 'default:missing'] });
  assert.equal((await library('?trash=1')).hiddenCount, 2);

  const purged = await edit('purge', { ids: [...ids, ids[0], remaining[0].id] });
  assert.deepEqual(purged.purgedIds, ids);
  assert.deepEqual(purged.settings.permanentlyRemovedIds, ids);
  assert.equal(purged.hiddenCount, 0);
  for (const { dir, entryFile, source } of targets) {
    assert.equal(await readFile(join(dir, entryFile), 'utf8'), source);
    assert.equal(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).title, source);
  }
  await edit('unhide', { all: true });
  assert.deepEqual((await edit('hide', { ids })).settings.hiddenIds, []);
  assert.deepEqual((await library()).items, remaining);
  assert.deepEqual((await library('?trash=1')).items, []);
  assert.deepEqual((await library('?includeHidden=1&refresh=1')).items, remaining);
});

test('clearing mixed trash purges uploads and external IDs, including missing hidden entries', async (t) => {
  const { uploads, library, edit, patch, upload } = await fixture(t);
  const { items } = await library();
  const uploaded = await upload();
  const externalIds = items.map(({ id }) => id);
  const ids = [uploaded.id, ...externalIds, 'default:missing'];
  await patch({ hiddenIds: ids, activeId: uploaded.id });

  const purged = await edit('purge', { all: true });
  assert.deepEqual(purged.purgedIds, ids);
  assert.deepEqual(purged.settings.permanentlyRemovedIds, [...externalIds, 'default:missing']);
  assert.deepEqual(purged.settings.hiddenIds, []);
  assert.equal(purged.hiddenCount, 0);
  assert.equal(purged.nextActiveId, null);
  assert.deepEqual((await library('?trash=1')).items, []);
  assert.deepEqual((await library()).items, []);
  assert.deepEqual(await readdir(uploads), ['index.json']);
  for (const { dir, entryFile, source } of items) assert.equal(await readFile(join(dir, entryFile), 'utf8'), source);
});

test('purge rejects external origins without changing the trash', async (t) => {
  const { library, edit, send } = await fixture(t);
  const { items: [item] } = await library();
  await edit('hide', { id: item.id });
  const response = await send('/api/wallpapers/purge', { all: true }, 'POST', 'https://example.test');
  assert.equal(response.status, 403);
  assert.deepEqual((await library('?trash=1')).items, [item]);
});

test('permanently removed IDs default to empty, are sanitized and persist across store instances', async (t) => {
  const file = join(await tempDir(t), 'settings.json');
  await writeFile(file, JSON.stringify({ hiddenIds: ['default:legacy'] }));
  const store = createConfigStore(file);
  assert.deepEqual((await store.read()).permanentlyRemovedIds, []);
  await store.patch({ permanentlyRemovedIds: ['default:old', '', ' \t ', 'custom:old', 'default:old'] });
  const expected = ['default:old', 'custom:old'];
  await assert.rejects(store.patch({ permanentlyRemovedIds: ['default:old', 1] }), SettingsValidationError);
  assert.deepEqual((await createConfigStore(file).read()).permanentlyRemovedIds, expected);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permanentlyRemovedIds, expected);
});
