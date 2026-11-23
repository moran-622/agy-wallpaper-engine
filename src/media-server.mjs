import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createConfigStore, defaultSettingsPath, SettingsValidationError } from './config-store.mjs';
import { openPkg, pkgEntryPayload, PkgFormatError } from './pkg-reader.mjs';
import {
  isEmbeddedVideo, relativeMediaPath, safeFile, scanWallpapers, uploadIdPattern, uploadRecord, uploadType,
} from './we-scanner.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const vendorRoot = fileURLToPath(new URL('../node_modules/webwallgl/', import.meta.url));
const rendererRoot = fileURLToPath(new URL('./webwallgl-host/', import.meta.url));
const runtimeFile = fileURLToPath(new URL('./bg-runtime.js', import.meta.url));
const glassFile = fileURLToPath(new URL('./glass-theme.css', import.meta.url));
const pickerFile = fileURLToPath(new URL('./picker-ui.js', import.meta.url));
const host = '127.0.0.1';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
};
const mimeTypes = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const uploadLimit = 200 * 1024 * 1024;
const uploadWrites = new Map();
const loopbackNames = new Set([host, 'localhost', '[::1]']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function notFound() {
  throw new HttpError(404, 'Not found');
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'Malformed URL encoding');
  }
}

function checkLocalOrigin(request) {
  if (request.headers.origin === undefined) return;
  const origin = URL.parse(request.headers.origin);
  if (!origin || !['http:', 'https:'].includes(origin.protocol) || !loopbackNames.has(origin.hostname)) {
    throw new HttpError(403, 'Writes are available to local pages only');
  }
}

function requestPath(value) {
  const path = relativeMediaPath(decode(value));
  if (!path) throw new HttpError(403, 'Invalid relative path');
  return path;
}

async function readPatch(request) {
  const limit = 64 * 1024;
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= limit) chunks.push(chunk);
  }
  if (length > limit) throw new HttpError(413, 'Settings payload too large');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function wallpaperIds(body) {
  const ids = body?.ids ?? [body?.id];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'Expected a wallpaper ID or an array of IDs');
  }
  return new Set(ids.filter((id) => id.trim()));
}

function nextVisibleId(ids, activeId, excluded) {
  const index = ids.indexOf(activeId) + 1;
  return [...ids.slice(index), ...ids.slice(0, index)].find((id) => !excluded.has(id)) ?? null;
}

function hiddenCount(ids, { hiddenIds, permanentlyRemovedIds }) {
  const hidden = new Set(hiddenIds);
  const removed = new Set(permanentlyRemovedIds);
  return ids.filter((id) => hidden.has(id) && !removed.has(id)).length;
}

async function readUploads(dir) {
  try {
    const entries = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    return entries.filter((entry) => {
      const uuid = uploadIdPattern.exec(entry?.id)?.[1];
      if (!uuid || typeof entry.file !== 'string' || typeof entry.title !== 'string') return false;
      const extension = extname(entry.file);
      const type = uploadType(extension);
      return type && entry.type === type && entry.file === uuid + extension;
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function changeUploads(dir, update) {
  const previous = uploadWrites.get(dir) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => update(await readUploads(dir)));
  uploadWrites.set(dir, write);
  const clear = () => {
    if (uploadWrites.get(dir) === write) uploadWrites.delete(dir);
  };
  void write.then(clear, clear);
  return write;
}

async function saveUploads(dir, entries) {
  const temp = join(dir, `index-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(entries, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, join(dir, 'index.json'));
  } finally {
    await rm(temp, { force: true });
  }
}

async function* uploadBody(request) {
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > uploadLimit) throw new HttpError(413, 'Wallpaper exceeds the 200 MB limit');
    yield chunk;
  }
  if (!size) throw new HttpError(400, 'Wallpaper file is empty');
}

async function saveUpload(request, dir) {
  if (Number(request.headers['content-length']) > uploadLimit) {
    throw new HttpError(413, 'Wallpaper exceeds the 200 MB limit');
  }
  const name = win32.basename(decode(request.headers['x-file-name'] ?? ''));
  const extension = extname(name).toLowerCase();
  const type = uploadType(extension);
  const mime = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (!type || (mime && mime !== 'application/octet-stream' && mime !== mimeTypes[extension])) {
    throw new HttpError(400, 'Unsupported wallpaper file type');
  }
  const uuid = randomUUID();
  const entry = {
    id: `upload:${uuid}`,
    title: name.slice(0, -extension.length).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255) || 'Local wallpaper',
    type, file: uuid + extension, createdAt: new Date().toISOString(),
  };
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `${uuid}.part`);
  const file = join(dir, entry.file);
  const handle = await open(temp, 'wx');
  try {
    try {
      await handle.writeFile(uploadBody(request));
    } finally {
      await handle.close();
    }
    await changeUploads(dir, async (entries) => {
      await rename(temp, file);
      try {
        await saveUploads(dir, [...entries, entry]);
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
    });
  } finally {
    await rm(temp, { force: true });
  }
  return uploadRecord(dir, entry).item;
}

async function removeUploadFile(dir, entries, entry) {
  if (!(await lstat(dir)).isDirectory()) throw new HttpError(403, 'Invalid uploads directory');
  const remaining = entries.filter(({ id }) => id !== entry.id);
  await saveUploads(dir, remaining);
  try {
    await rm(join(dir, entry.file), { force: true });
  } catch (error) {
    await saveUploads(dir, entries);
    throw error;
  }
  return remaining;
}

async function deleteUpload(dir, id, store, getInventory) {
  if (!uploadIdPattern.test(id)) throw new HttpError(400, 'Invalid upload ID');
  await changeUploads(dir, async (entries) => {
    const entry = entries.find((entry) => entry.id === id);
    if (!entry) return notFound();
    const { records } = await getInventory();
    const ids = [...records.keys(), ...entries.map((entry) => entry.id)];
    await removeUploadFile(dir, entries, entry);
    await store.patch(({ activeId, favorites, hiddenIds, permanentlyRemovedIds }) => {
      const changes = {};
      if (activeId === id) changes.activeId = nextVisibleId(ids, id, new Set([...hiddenIds, ...permanentlyRemovedIds, id]));
      if (favorites.includes(id)) changes.favorites = favorites.filter((favorite) => favorite !== id);
      if (hiddenIds.includes(id)) changes.hiddenIds = hiddenIds.filter((hidden) => hidden !== id);
      return Object.keys(changes).length ? changes : undefined;
    });
  });
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const [, first, last] = match;
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
  return start < size && start <= end ? { start, end } : null;
}

async function servePayload(request, response, name, payload) {
  const { size } = payload;
  const range = request.headers.range;
  response.setHeader('Accept-Ranges', 'bytes');
  const bounds = range === undefined ? { start: 0, end: size - 1 } : byteRange(range, size);
  if (!bounds) {
    response.setHeader('Content-Range', `bytes */${size}`);
    throw new HttpError(416, 'Range not satisfiable');
  }
  const { start, end } = bounds;
  const extension = extname(name).toLowerCase();
  const headers = {
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
    'Content-Length': end - start + 1,
    'X-Content-Type-Options': 'nosniff',
  };
  const partial = range !== undefined;
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (['.html', '.htm', '.svg'].includes(extension) && !response.hasHeader('Content-Security-Policy')) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
  }
  response.writeHead(partial ? 206 : 200, headers);
  if (request.method === 'HEAD' || size === 0) response.end();
  else await pipeline(payload.stream(start, end), response);
}

async function serveFile(request, response, file) {
  if (!file) return notFound();
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    await servePayload(request, response, file, {
      size,
      stream: (start, end) => handle.createReadStream({ start, end, autoClose: false }),
    });
  } finally {
    await handle.close();
  }
}

function missingFile(error) {
  return ['ENOENT', 'ENOTDIR'].includes(error.code);
}

async function openScenePkg(item) {
  const file = await safeFile(item.dir, item.pkgFile);
  if (!file) return null;
  try {
    return await openPkg(file);
  } catch (error) {
    if (error instanceof PkgFormatError || missingFile(error)) return null;
    throw error;
  }
}

async function looseFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if (missingFile(error) || ['EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!relativeMediaPath(path)) continue;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const file of await looseFiles(dir, path)) files.push(file);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function sceneManifest(item) {
  const pkg = await openScenePkg(item);
  const files = new Map();
  if (pkg) {
    try {
      for (const [key, entry] of pkg.entries) {
        if (relativeMediaPath(entry.path)) files.set(key, entry.path);
      }
    } finally {
      await pkg.file.close();
    }
  }
  for (const path of await looseFiles(item.dir)) {
    if (/^project\.json$/i.test(path) || /\.m?pkg$/i.test(path)) continue;
    const key = path.toLowerCase();
    if (!files.has(key)) files.set(key, path);
  }
  const names = [...files.values()].sort();
  const entryJsonPath = files.get(item.entryFile.toLowerCase()) ?? files.get('scene.json')
    ?? names.find((name) => /\/scene\.json$/i.test(name)) ?? item.entryFile;
  return {
    ok: true, id: item.id, title: item.title, hasPkg: item.hasPkg, entryJsonPath, files: names,
    embeddedVideo: names.find(isEmbeddedVideo) ?? null, previewUrl: item.previewUrl,
  };
}

async function sceneFile(request, response, item, path, assetsDir) {
  const pkg = await openScenePkg(item);
  if (pkg) {
    try {
      const entry = pkg.entries.get(path.toLowerCase());
      if (entry) {
        const payload = await pkgEntryPayload(pkg.file, entry);
        return await servePayload(request, response, entry.path, payload);
      }
    } finally {
      await pkg.file.close();
    }
  }
  const loose = await safeFile(item.dir, path);
  const asset = loose ?? await safeFile(assetsDir, path)
    ?? (path.startsWith('assets/') ? await safeFile(assetsDir, path.slice('assets/'.length)) : null);
  return serveFile(request, response, asset);
}

async function serveSceneRoot(request, response, item, path, assetsDir) {
  if (path === 'project.json') {
    const metadata = await safeFile(item.dir, 'project.json');
    if (!metadata) return notFound();
    const project = JSON.parse((await readFile(metadata, 'utf8')).replace(/^\uFEFF/, ''));
    const { entryJsonPath } = await sceneManifest(item);
    // In directory mode WebWallGL resolves each asset through our VFS, even
    // for packed scenes. The original project.json still lives under /media/file.
    return json(response, 200, { ...project, type: 'scene', file: entryJsonPath });
  }
  if (path === 'scene.pkg' || path === item.pkgFile) {
    return serveFile(request, response, await safeFile(item.dir, item.pkgFile));
  }
  return sceneFile(request, response, item, path, assetsDir);
}

export async function createMediaServer(options = {}) {
  const store = createConfigStore(options.settingsPath);
  const uploadsDir = join(dirname(resolve(options.settingsPath ?? defaultSettingsPath)), 'uploads');
  let inventory;

  function getInventory(refresh = false) {
    if (inventory && !refresh) return inventory;
    const pending = store.read().then(({ customDirs, extraRoots }) => scanWallpapers({
      scanRoots: options.scanRoots, customDirs, extraRoots,
    }));
    inventory = pending;
    void pending.catch(() => {
      if (inventory === pending) inventory = undefined;
    });
    return pending;
  }

  async function hideWallpapers(ids) {
    // Serialize with upload deletion so both operations select from the same library order.
    return changeUploads(uploadsDir, async (uploads) => {
      const { records } = await getInventory();
      const libraryIds = [...records.keys(), ...uploads.map(({ id }) => id)];
      const library = new Set(libraryIds);
      const settings = await store.patch(({ hiddenIds, permanentlyRemovedIds, favorites, activeId }) => {
        const permanent = new Set(permanentlyRemovedIds);
        const removed = new Set([...ids].filter((id) => library.has(id) && !permanent.has(id)));
        if (!removed.size) return;
        const hidden = new Set([...hiddenIds, ...removed]);
        return {
          hiddenIds: [...hidden],
          favorites: favorites.filter((id) => !removed.has(id)),
          activeId: removed.has(activeId) ? nextVisibleId(libraryIds, activeId, new Set([...hidden, ...permanent])) : activeId,
        };
      });
      return { ok: true, settings, hiddenCount: hiddenCount(libraryIds, settings), nextActiveId: settings.activeId };
    });
  }

  async function restoreWallpapers(ids) {
    return changeUploads(uploadsDir, async (uploads) => {
      const { records } = await getInventory();
      const settings = await store.patch(({ hiddenIds }) => ({
        hiddenIds: ids ? hiddenIds.filter((id) => !ids.has(id)) : [],
      }));
      return { ok: true, settings, hiddenCount: hiddenCount([...records.keys(), ...uploads.map(({ id }) => id)], settings) };
    });
  }

  async function purgeWallpapers(ids) {
    return changeUploads(uploadsDir, async (uploads) => {
      const { records } = await getInventory();
      const current = await store.read();
      const targets = current.hiddenIds.filter((id) => !ids || ids.has(id));
      const libraryIds = [...records.keys(), ...uploads.map(({ id }) => id)];
      const indexed = new Map(uploads.map((entry) => [entry.id, entry]));
      const purged = new Set();
      let settings = current;
      try {
        for (const id of targets) {
          const entry = indexed.get(id);
          if (entry) uploads = await removeUploadFile(uploadsDir, uploads, entry);
          purged.add(id);
        }
      } finally {
        // Keep finished deletions reflected in settings if a later file could not be removed.
        if (purged.size) settings = await store.patch(({ activeId, hiddenIds, favorites, permanentlyRemovedIds }) => {
          const remainingHidden = hiddenIds.filter((id) => !purged.has(id));
          const permanent = new Set([...permanentlyRemovedIds, ...[...purged].filter((id) => !id.startsWith('upload:'))]);
          return {
            hiddenIds: remainingHidden,
            favorites: favorites.filter((id) => !purged.has(id)),
            permanentlyRemovedIds: [...permanent],
            activeId: purged.has(activeId)
              ? nextVisibleId(libraryIds, activeId, new Set([...remainingHidden, ...permanent, ...purged])) : activeId,
          };
        });
      }
      return {
        ok: true, purgedIds: [...purged], settings,
        hiddenCount: hiddenCount(libraryIds, settings), nextActiveId: settings.activeId,
      };
    });
  }

  async function route(request, response) {
    const method = request.method;
    // Keep the raw pathname so dot segments are checked before normalization.
    const target = request.url ?? '';
    const queryIndex = target.indexOf('?');
    const path = queryIndex < 0 ? target : target.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex < 0 ? '' : target.slice(queryIndex + 1));

    if (method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (path === '/api/settings' && method === 'PATCH') {
      checkLocalOrigin(request);
      const changes = await readPatch(request);
      const settings = await store.patch(changes);
      if (Object.hasOwn(changes, 'customDirs') || Object.hasOwn(changes, 'extraRoots')) inventory = undefined;
      return json(response, 200, settings);
    }
    if (path === '/api/uploads' && method === 'POST') {
      try {
        checkLocalOrigin(request);
        return json(response, 201, await saveUpload(request, uploadsDir));
      } catch (error) {
        if (!request.readableEnded && !response.destroyed) {
          response.setHeader('Connection', 'close');
          request.resume();
        }
        throw error;
      }
    }
    if (method === 'DELETE' && path.startsWith('/api/uploads/')) {
      checkLocalOrigin(request);
      await deleteUpload(uploadsDir, decode(path.slice('/api/uploads/'.length)), store, getInventory);
      return response.writeHead(204).end();
    }
    if (method === 'POST' && path === '/api/wallpapers/hide') {
      checkLocalOrigin(request);
      return json(response, 200, await hideWallpapers(wallpaperIds(await readPatch(request))));
    }
    if (method === 'POST' && ['/api/wallpapers/unhide', '/api/wallpapers/purge'].includes(path)) {
      checkLocalOrigin(request);
      const body = await readPatch(request);
      const ids = body?.all === true ? null : wallpaperIds(body);
      const edit = path === '/api/wallpapers/purge' ? purgeWallpapers : restoreWallpapers;
      return json(response, 200, await edit(ids));
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    if (path === '/api/settings') return json(response, 200, await store.read());
    if (path === '/api/runtime/bg.js') return serveFile(request, response, runtimeFile);
    if (path === '/api/runtime/glass.css') return serveFile(request, response, glassFile);
    if (path === '/api/runtime/picker.js') return serveFile(request, response, pickerFile);
    if (path === '/webwallgl/index.html' || path === '/webwallgl/renderer.js') {
      if (path.endsWith('.html')) {
        // WebWallGL compiles Wallpaper Engine scene scripts with Function().
        response.setHeader('Content-Security-Policy', [
          "script-src 'self' 'unsafe-eval'", "connect-src 'self'",
          "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        ].join('; '));
      }
      return serveFile(request, response, join(rendererRoot, path.slice('/webwallgl/'.length)));
    }
    if (path === '/api/health') {
      const [{ records, roots, weFound }, uploads] = await Promise.all([getInventory(), readUploads(uploadsDir)]);
      return json(response, 200, { ok: true, version, port, pid: process.pid, weFound, wallpaperCount: records.size + uploads.length, roots });
    }
    if (path === '/api/wallpapers') {
      const [{ records }, uploads, settings] = await Promise.all([
        getInventory(query.get('refresh') === '1'), readUploads(uploadsDir), store.read(),
      ]);
      const hidden = new Set(settings.hiddenIds);
      const removed = new Set(settings.permanentlyRemovedIds);
      const trash = query.get('trash') === '1';
      const includeHidden = query.get('includeHidden') === '1';
      const type = query.get('type');
      const search = query.get('q')?.trim().toLowerCase();
      const library = [...records.values(), ...uploads.map((entry) => uploadRecord(uploadsDir, entry))]
        .map(({ item }) => item)
        .filter(({ id }) => !removed.has(id));
      const items = library
        .filter(({ id }) => trash ? hidden.has(id) : includeHidden || !hidden.has(id))
        .filter((item) => !type || item.type === type)
        .filter((item) => !search || [item.title, item.id, ...item.tags]
          .some((value) => value.toLowerCase().includes(search)));
      return json(response, 200, {
        ok: true, count: items.length, items, activeId: settings.activeId,
        hiddenCount: library.filter(({ id }) => hidden.has(id)).length,
      });
    }

    let match = /^\/vendor\/webwallgl\/(.+)$/.exec(path);
    if (match) return serveFile(request, response, await safeFile(vendorRoot, requestPath(match[1])));

    match = /^\/api\/scene\/([^/]+)\/manifest$/.exec(path);
    if (match) {
      const { records } = await getInventory();
      const item = records.get(decode(match[1]))?.item;
      if (item?.type !== 'scene') return notFound();
      return json(response, 200, await sceneManifest(item));
    }

    match = /^\/media\/(preview|file|scene|scene-root)\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return notFound();
    const [, kind, encoded, rawPath] = match;
    const id = decode(encoded);
    if (uploadIdPattern.test(id)) {
      if (kind !== 'file' || !rawPath) return notFound();
      const rel = requestPath(rawPath);
      const entry = (await readUploads(uploadsDir)).find((entry) => entry.id === id);
      if (entry?.file !== rel) return notFound();
      return serveFile(request, response, await safeFile(uploadsDir, rel));
    }
    const { records, assetsDir } = await getInventory();
    const record = records.get(id);
    if (!record) return notFound();
    const { item, previewFile } = record;
    if (kind === 'preview') {
      if (rawPath !== undefined) return notFound();
      response.setHeader('Cache-Control', 'public, max-age=300');
      return serveFile(request, response, await safeFile(item.dir, previewFile));
    }
    if (!rawPath) return notFound();
    const rel = requestPath(rawPath);
    if (kind === 'scene' || kind === 'scene-root') {
      if (item.type !== 'scene') return notFound();
      const globalAssets = options.weAssetsDir === undefined ? assetsDir : options.weAssetsDir;
      if (kind === 'scene-root') return serveSceneRoot(request, response, item, rel, globalAssets);
      return sceneFile(request, response, item, rel, globalAssets);
    }
    const file = await safeFile(item.dir, rel);
    if (file && item.type === 'web' && /\.html?$/i.test(file)) {
      const projectUrl = `${baseUrl}/media/file/${encodeURIComponent(item.id)}/`;
      response.setHeader('Content-Security-Policy', [
        'sandbox allow-scripts', `connect-src ${projectUrl}`,
        "form-action 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
      ].join('; '));
    }
    return serveFile(request, response, file);
  }

  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(cors)) response.setHeader(name, value);
    route(request, response).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      let status = 500;
      if (error instanceof HttpError) status = error.status;
      else if (error instanceof SettingsValidationError) status = 400;
      else if (missingFile(error)) status = 404;
      const message = status === 500 ? 'Internal server error' : status === 404 ? 'Not found' : error.message;
      json(response, status, { ok: false, error: message });
    });
  });

  async function listen(port) {
    server.listen(port, host);
    await once(server, 'listening');
  }

  try {
    await listen(options.port ?? 18765);
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || options.fallbackOnPortInUse === false) throw error;
    await listen(0);
  }

  const { port } = server.address();
  const baseUrl = `http://${host}:${port}`;
  let closing;
  function close() {
    closing ??= new Promise((resolve, reject) => {
      server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closing;
  }
  return { server, port, baseUrl, close };
}
