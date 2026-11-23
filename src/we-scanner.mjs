// Steam discovery and project conventions reference elysia395/dsh-wallpaper-engine (MIT).
// Copyright (c) 2026 elysia395. The MIT notice is included in pkg-reader.mjs.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { openPkg, PkgFormatError } from './pkg-reader.mjs';

const exec = promisify(execFile);
const types = new Set(['scene', 'video', 'web', 'image']);
const sources = ['workshop', 'default', 'custom'];
const packageExtension = /\.m?pkg$/i;
const embeddedVideoExtension = /\.(mp4|webm)$/i;
const previewNames = ['preview.jpg', 'preview.png', 'preview.gif', 'preview.webp'];
export const uploadIdPattern = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const uploadExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm']);

export function uploadType(extension) {
  return uploadExtensions.has(extension) ? inferType(extension) : null;
}

export function relativeMediaPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const path = value.replaceAll('\\', '/');
  const segments = path.split('/');
  const invalid = segments.some((part) => !part || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
  return invalid ? null : path;
}

function inside(root, file) {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function safeFile(root, rel) {
  const path = relativeMediaPath(rel);
  if (!root || !path) return null;
  try {
    const realRoot = await realpath(root);
    const file = await realpath(join(realRoot, path));
    return inside(realRoot, file) && (await stat(file)).isFile() ? file : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

export function encodeMediaPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function isEmbeddedVideo(path) {
  return embeddedVideoExtension.test(path);
}

async function directory(path) {
  try {
    const dir = await realpath(path);
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

async function children(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
}

async function steamDirectories() {
  if (process.platform !== 'win32') return [];
  const roots = [];
  for (const [key, name] of [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\Software\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ]) {
    try {
      const { stdout } = await exec('reg.exe', ['query', key, '/v', name], {
        timeout: 1500, windowsHide: true,
      });
      const match = /\bREG_(?:EXPAND_)?SZ\s+([^\r\n]+)/.exec(stdout);
      if (match && isAbsolute(match[1].trim())) roots.push(match[1].trim());
    } catch {
      // Registry entries are optional. Check the standard install directories too.
    }
  }
  for (const parent of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (parent) roots.push(join(parent, 'Steam'));
  }
  return [...new Set(roots)];
}

async function discoverSteam() {
  const libraries = new Set(await steamDirectories());
  for (const steam of [...libraries]) {
    let vdf;
    try {
      vdf = await readFile(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    } catch {
      continue;
    }
    // Modern libraryfolders.vdf uses "path", while older versions use numeric keys.
    for (const [, value] of vdf.matchAll(/"(?:path|\d+)"\s+"((?:\\.|[^"\\])*)"/g)) {
      const path = value.replace(/\\(["\\])/g, '$1');
      if (isAbsolute(path)) libraries.add(path);
    }
  }

  const roots = [];
  let assetsDir = null;
  let installFound = false;
  for (const library of libraries) {
    roots.push({ source: 'workshop', dir: join(library, 'steamapps', 'workshop', 'content', '431960') });
    const install = await directory(join(library, 'steamapps', 'common', 'wallpaper_engine'));
    if (!install) continue;
    installFound = true;
    roots.push({ source: 'default', dir: join(install, 'projects', 'defaultprojects') });
    assetsDir ??= await directory(join(install, 'assets'));
  }
  return { roots, assetsDir, installFound };
}

function rootSource(path) {
  const name = basename(resolve(path)).toLowerCase();
  if (name === '431960' || name === 'workshop') return 'workshop';
  if (name === 'defaultprojects' || name === 'default') return 'default';
  return 'custom';
}

function scanRoot(root, source) {
  const dir = typeof root === 'string' ? root : root?.dir ?? root?.path;
  if (typeof dir !== 'string' || !dir.trim()) return null;
  const requested = source ?? root?.source;
  return { dir, source: sources.includes(requested) ? requested : rootSource(dir) };
}

function inferType(file) {
  if (/\.(?:m?pkg|json)$/i.test(file)) return 'scene';
  if (/\.(?:mp4|webm|ogv|mov|m4v|mkv|avi|wmv)$/i.test(file)) return 'video';
  if (/\.html?$/i.test(file)) return 'web';
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(file)) return 'image';
  return null;
}

async function firstFile(dir, names) {
  for (const name of names) {
    const path = relativeMediaPath(name);
    if (path && await safeFile(dir, path)) return path;
  }
  return null;
}

async function pictureEntry(dir, preset) {
  const image = relativeMediaPath(preset?.image);
  if (image && inferType(image) === 'image' && await safeFile(dir, image)) return image;
  const folder = relativeMediaPath(preset?.customdirectory);
  if (!folder) return null;
  const actual = await directory(join(dir, folder));
  if (!actual || !inside(dir, actual)) return null;
  const entries = await children(actual);
  return firstFile(dir, entries
    .filter((entry) => entry.isFile() && inferType(entry.name) === 'image')
    .map((entry) => `${folder}/${entry.name}`));
}

async function packagedSceneEntry(dir, pkgFile, declaredFile) {
  const path = await safeFile(dir, pkgFile);
  if (!path) return null;
  try {
    const pkg = await openPkg(path);
    try {
      const entry = pkg.entries.get(declaredFile?.toLowerCase()) ?? pkg.entries.get('scene.json');
      if (entry && /\.json$/i.test(entry.path) && relativeMediaPath(entry.path)) return entry.path;
      for (const { path } of pkg.entries.values()) {
        if (/\/scene\.json$/i.test(path) && relativeMediaPath(path)) return path;
      }
      return null;
    } finally {
      await pkg.file.close();
    }
  } catch (error) {
    if (error instanceof PkgFormatError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}

function makeItem(dir, source, entryFile, type, { pkgFile = null, previewFile, project, packed = false, uploadId }) {
  const name = basename(dir);
  const key = source === 'custom'
    ? createHash('sha256').update(`${dir}\0${project.loose ? entryFile : ''}`).digest('hex').slice(0, 20)
    : name;
  const id = uploadId ?? `${source}:${key}`;
  const encoded = encodeURIComponent(id);
  const scene = type === 'scene';
  const base = packed ? 'scene' : 'file';
  const rating = project.contentrating ?? project.contentRating;
  const mediaUrl = `/media/${base}/${encoded}/${encodeMediaPath(entryFile)}`;
  const previewUrl = previewFile ? (uploadId ? mediaUrl : `/media/preview/${encoded}`) : null;
  const item = {
    id, source, type, title: typeof project.title === 'string' && project.title.trim() ? project.title : name,
    dir, entryFile, hasPkg: pkgFile !== null, pkgFile,
    previewUrl,
    mediaUrl,
    sceneManifestUrl: scene ? `/api/scene/${encoded}/manifest` : null,
    tags: Array.isArray(project.tags) ? project.tags.filter((tag) => typeof tag === 'string') : [],
    contentRating: typeof rating === 'string' ? rating : null,
  };
  return { item, previewFile };
}

export function uploadRecord(dir, { id, title, type, file }) {
  return makeItem(dir, 'upload', file, type, {
    uploadId: id, previewFile: type === 'image' ? file : null, project: { title },
  });
}

async function readProject(dir, source) {
  const file = await safeFile(dir, 'project.json');
  if (!file) return null;
  let project;
  try {
    project = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)) return null;

  const declaredFile = relativeMediaPath(project.file);
  const declaredType = typeof project.type === 'string' ? project.type.toLowerCase() : null;
  const type = declaredType === 'preset' ? 'image'
    : declaredType || inferType(declaredFile ?? '') || (project.preset ? 'image' : null);
  if (!types.has(type)) return null;

  let entryFile = await firstFile(dir, [declaredFile]);
  let pkgFile = null;
  let packed = false;
  if (type === 'scene') {
    const packages = (await children(dir)).filter((entry) => entry.isFile() && packageExtension.test(entry.name));
    pkgFile = await firstFile(dir, [
      packageExtension.test(declaredFile ?? '') ? declaredFile : null,
      'scene.pkg', 'scene.mpkg', ...packages.map((entry) => entry.name),
    ]);
    if (!entryFile || packageExtension.test(entryFile)) {
      entryFile = await firstFile(dir, ['scene.json']);
      if (!entryFile && pkgFile) {
        entryFile = await packagedSceneEntry(dir, pkgFile, declaredFile)
          ?? (/\.json$/i.test(declaredFile ?? '') ? declaredFile : 'scene.json');
        packed = true;
      }
    }
  }
  if (type === 'image' && (!entryFile || inferType(entryFile) !== 'image')) {
    entryFile = await pictureEntry(dir, project.preset);
  }
  if (!entryFile) return null;
  const preview = await firstFile(dir, [project.preview, ...previewNames, type === 'image' ? entryFile : null]);
  return makeItem(dir, source, entryFile, type, { pkgFile, previewFile: preview, project, packed });
}

async function scanRootEntries({ dir, source }) {
  const project = await readProject(dir, source);
  if (project) return [project];
  const entries = await children(dir);
  const projects = [];
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  for (let index = 0; index < folders.length; index += 24) {
    const batch = folders.slice(index, index + 24);
    projects.push(...(await Promise.all(batch.map((entry) => readProject(join(dir, entry.name), source)))).filter(Boolean));
  }
  if (source === 'custom') {
    for (const entry of entries) {
      const type = inferType(entry.name);
      if (!entry.isFile() || !type || type === 'scene' || !relativeMediaPath(entry.name)) continue;
      const title = basename(entry.name, extname(entry.name));
      projects.push(makeItem(dir, source, entry.name, type, {
        previewFile: type === 'image' ? entry.name : null, project: { title, loose: true },
      }));
    }
  }
  return projects;
}

// Explicit roots bypass Steam probing. Use a path or a { dir, source } descriptor.
export async function scanWallpapers({ scanRoots, customDirs = [], extraRoots = [] } = {}) {
  const steam = scanRoots === undefined ? await discoverSteam()
    : { roots: [], assetsDir: null, installFound: false };
  const explicit = Array.isArray(scanRoots) ? scanRoots.map((root) => scanRoot(root))
    : sources.flatMap((source) => [scanRoots?.[source]].flat().map((root) => scanRoot(root, source)));
  const candidates = [
    ...steam.roots, ...explicit,
    ...extraRoots.map((root) => scanRoot(root)),
    ...customDirs.map((root) => scanRoot(root, 'custom')),
  ];
  const roots = new Map();
  const records = new Map();
  for (const root of candidates.filter(Boolean)) {
    const dir = await directory(root.dir);
    if (!dir || roots.has(dir)) continue;
    roots.set(dir, root.source);
    for (const record of await scanRootEntries({ dir, source: root.source })) {
      if (!records.has(record.item.id)) records.set(record.item.id, record);
    }
  }
  return {
    roots: [...roots.keys()], records, assetsDir: steam.assetsDir,
    weFound: steam.installFound || [...roots.values()].some((source) => source !== 'custom'),
  };
}
