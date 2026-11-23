import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const defaultSettingsPath = join(
  process.env.USERPROFILE || homedir(), '.gemini', 'antigravity', 'wallpaper-engine', 'settings.json',
);

const defaults = {
  enabled: true,
  activeId: null,
  favorites: [],
  hiddenIds: [],
  permanentlyRemovedIds: [],
  customDirs: [],
  extraRoots: [],
  bg: {
    opacity: 1, dim: 0.10, blur: 0, fit: 'cover', muted: true, volume: 0,
    fpsLimit: 30, pauseOnHidden: true,
  },
  glass: {
    enabled: true, preset: 'liquid-auto', toneMode: 'auto', blur: 14, surfaceOpacity: 0,
    sidebarOpacity: 0.44, cardOpacity: 0.68, borderGlow: 0.34,
  },
  slideshow: { enabled: false, intervalSec: 300 },
};

const numericRanges = {
  bg: { opacity: [0, 1], dim: [0, 1], blur: [0, 100], volume: [0, 1], fpsLimit: [1, 120] },
  glass: {
    blur: [0, 32], surfaceOpacity: [0, 0.75], sidebarOpacity: [0.12, 0.88],
    cardOpacity: [0.25, 0.94], borderGlow: [0, 0.6],
  },
  slideshow: { intervalSec: [60, 86400] },
};

export class SettingsValidationError extends Error {}

function mergeSettings(current, patch, fallback = defaults, ranges = numericRanges) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsValidationError('Settings must be a JSON object');
  }

  const result = { ...current };
  for (const [key, previous] of Object.entries(current)) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === 'activeId' && (value === null || typeof value === 'string')) {
      result[key] = value;
    } else if (key === 'toneMode' && !['auto', 'light', 'dark'].includes(value)) {
      throw new SettingsValidationError('Invalid settings value for toneMode');
    } else if (['hiddenIds', 'permanentlyRemovedIds'].includes(key)
      && Array.isArray(value) && value.every((id) => typeof id === 'string')) {
      result[key] = [...new Set(value.filter((id) => id.trim()))];
    } else if (Array.isArray(previous) && Array.isArray(value)
      && value.every((dir) => typeof dir === 'string' && dir.trim())) {
      result[key] = [...value];
    } else if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
      result[key] = mergeSettings(previous, value, fallback[key], ranges[key]);
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      result[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback[key];
    } else if (key !== 'activeId' && typeof value === typeof previous
      && value !== null && typeof value !== 'object') {
      result[key] = value;
    } else {
      throw new SettingsValidationError(`Invalid settings value for ${key}`);
    }
  }
  return result;
}

// Corrupt-file recovery and read/merge/write transactions share the queue for each file.
const pendingOperations = new Map();

export function createConfigStore(settingsPath = defaultSettingsPath) {
  const file = resolve(settingsPath);

  async function readSettings() {
    try {
      const json = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
      return mergeSettings(structuredClone(defaults), JSON.parse(json));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SettingsValidationError) {
        await rename(file, `${file}.corrupt.${Date.now()}.bak`).catch(() => {});
      } else if (error.code !== 'ENOENT') {
        throw error;
      }
      return structuredClone(defaults);
    }
  }

  function enqueue(operation) {
    const previous = pendingOperations.get(file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    pendingOperations.set(file, pending);
    function clear() {
      if (pendingOperations.get(file) === pending) pendingOperations.delete(file);
    }
    void pending.then(clear, clear);
    return pending;
  }

  function patch(changes) {
    return enqueue(async () => {
      const current = await readSettings();
      const patch = typeof changes === 'function' ? changes(current) : changes;
      if (patch === undefined && typeof changes === 'function') return current;
      const updated = mergeSettings(current, patch);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx' });
        await rename(temp, file);
      } finally {
        await rm(temp, { force: true });
      }
      return updated;
    });
  }

  return { read: () => enqueue(readSettings), patch };
}
