import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parsePort } from './src/cli-port.mjs';
import { defaultSettingsPath } from './src/config-store.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const dataDir = dirname(defaultSettingsPath);
const pidFile = join(dataDir, 'daemon.pid');
const metaFile = join(dataDir, 'daemon-meta.json');
const vbsFile = join(dataDir, 'AntigravityWallpaperDaemon.vbs');
const taskName = 'AntigravityWallpaperDaemon';
const daemonCli = join(repoRoot, 'src', 'daemon-cli.mjs');
const defaultPort = 18765;

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true });
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile() {
  try {
    return readFileSync(pidFile, 'utf8').trim();
  } catch {
    return null;
  }
}

async function probeHealth(port = defaultPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function findDaemon(port) {
  const meta = readMeta();
  const storedPid = Number(readPidFile());
  const activePort = meta?.port || port;
  for (const candidate of new Set([activePort, port])) {
    if (!candidate) continue;
    const health = await probeHealth(candidate);
    if (health?.ok !== true || health.port !== candidate
      || typeof health.version !== 'string' || typeof health.weFound !== 'boolean') continue;
    // Older media servers omitted pid. Their file can still identify the instance.
    const pid = health.pid ?? (candidate === activePort ? storedPid : null);
    if (isPidAlive(pid)) return { pid, port: candidate, health, meta };
  }
  return { pid: null, port: activePort, health: null };
}

function rememberDaemon({ pid, port, meta }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const previous = meta?.pid === pid && meta.port === port ? meta : {};
  writeFileSync(metaFile, JSON.stringify({
    ...previous, pid, port, baseUrl, startedAt: previous.startedAt ?? new Date().toISOString(),
  }, null, 2), 'utf8');
  writeFileSync(pidFile, String(pid), 'utf8');
}

function writeVbsLauncher(port) {
  ensureDataDir();
  const nodeExe = process.execPath.replace(/"/g, '""');
  const script = daemonCli.replace(/"/g, '""');
  const content = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${nodeExe}"" ""${script}"" --port ${port}", 0, False`,
    '',
  ].join('\r\n');
  writeFileSync(vbsFile, content, 'utf8');
}

const startMenuPrograms = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const startupDir = join(startMenuPrograms, 'Startup');
const startupVbs = join(startupDir, 'AntigravityWallpaperDaemon.vbs');
const defaultAntigravityLnk = join(startMenuPrograms, 'Antigravity.lnk');
const cdpAntigravityLnk = join(startMenuPrograms, 'Antigravity (CDP).lnk');

function createCdpShortcut() {
  if (process.platform !== 'win32') return { ok: false, reason: 'non-windows' };
  const defaultExe = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe');
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$origPath = '${defaultAntigravityLnk.replace(/'/g, "''")}'`,
    `$cdpPath = '${cdpAntigravityLnk.replace(/'/g, "''")}'`,
    `$fallbackExe = '${defaultExe.replace(/'/g, "''")}'`,
    'if (Test-Path $origPath) {',
    '  $orig = $ws.CreateShortcut($origPath)',
    '  $target = $orig.TargetPath',
    '  $workDir = $orig.WorkingDirectory',
    '  $icon = $orig.IconLocation',
    '} else {',
    '  $target = $fallbackExe',
    '  $workDir = Split-Path $target',
    '  $icon = "$target,0"',
    '}',
    'if (-not (Test-Path $target)) { throw "Antigravity.exe not found: $target" }',
    '$sc = $ws.CreateShortcut($cdpPath)',
    '$sc.TargetPath = $target',
    '$sc.Arguments = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1"',
    '$sc.WorkingDirectory = $workDir',
    'if ($icon) { $sc.IconLocation = $icon }',
    '$sc.Description = "Antigravity (CDP enabled, update-proof shortcut)"',
    '$sc.Save()',
    'Write-Output $target',
  ].join('\n');
  try {
    const target = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return { ok: true, path: cdpAntigravityLnk, target };
  } catch (error) {
    return { ok: false, path: cdpAntigravityLnk, reason: error.stderr?.toString().trim() || error.message };
  }
}

function registerScheduledTask() {
  if (process.platform !== 'win32') return { ok: false, reason: 'non-windows' };
  try {
    mkdirSync(startupDir, { recursive: true });
    writeFileSync(startupVbs, readFileSync(vbsFile, 'utf8'), 'utf8');
    return { ok: true, method: 'startup-folder', path: startupVbs };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function removeScheduledTask() {
  if (process.platform !== 'win32') return false;
  try {
    if (existsSync(startupVbs)) rmSync(startupVbs, { force: true });
    try { execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { stdio: 'pipe', windowsHide: true }); } catch {}
    return true;
  } catch {
    return false;
  }
}

function queryScheduledTask() {
  if (process.platform !== 'win32') return false;
  return existsSync(startupVbs);
}

async function cleanupLiveDom() {
  try {
    const portFile = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
    if (!existsSync(portFile)) return false;
    const [cdpPort] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(t.url || ''));
    for (const page of pages) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 1500);
        ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('err')); }, { once: true });
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `
            try { window.__agyWePicker?.destroy?.(); } catch {}
            delete window.__agyWePicker;
            try { window.__agyWeBg?.destroy?.(); } catch {}
            delete window.__agyWeBg;
            for (const attr of ['glass', 'tone', 'preset', 'peek']) {
              document.body?.removeAttribute('data-agy-we-' + attr);
            }
            for (const id of ['glass-style', 'bg-base-style', 'bg-root', 'picker-host']) {
              document.getElementById('agy-we-' + id)?.remove();
            }
          `,
        },
      }));
      await new Promise((r) => setTimeout(r, 150));
      ws.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(port) {
  const previousPidFile = readPidFile();
  const { pid } = await findDaemon(port);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 15 && isPidAlive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (isPidAlive(pid) && process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
      } catch {}
    }
  }
  if (previousPidFile !== null && readPidFile() === previousPidFile) rmSync(pidFile, { force: true });
  await cleanupLiveDom();
  return { stoppedPid: pid };
}

async function startDaemon({ port = defaultPort, wallpaper } = {}) {
  ensureDataDir();
  async function reuse(existing) {
    rememberDaemon(existing);
    if (wallpaper) {
      await fetch(`http://127.0.0.1:${existing.port}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, activeId: wallpaper }),
      });
    }
    return { alreadyRunning: true, pid: existing.pid, port: existing.port };
  }
  const existing = await findDaemon(port);
  if (existing.pid) return reuse(existing);

  const args = [daemonCli, '--port', String(port)];
  if (wallpaper) args.push('--wallpaper', wallpaper);
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.unref();

  for (let i = 0; i < 30; i += 1) {
    const started = await findDaemon(port);
    if (started.pid === child.pid) {
      return { alreadyRunning: false, pid: child.pid, port: started.port, health: started.health };
    }
    if (started.pid) return reuse(started);
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { alreadyRunning: false, pid: child.pid, port, health: null };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    wallpaper: { type: 'string' },
  },
});

const cmd = (positionals[0] || 'status').toLowerCase();
let port;
try {
  port = parsePort(values.port) ?? defaultPort;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (cmd === 'install') {
  writeVbsLauncher(port);
  const task = registerScheduledTask();
  const cdpShortcut = createCdpShortcut();
  const started = await startDaemon({ port, wallpaper: values.wallpaper });
  console.log(JSON.stringify({ ok: Boolean(started.health?.ok || started.alreadyRunning), action: 'install', task, cdpShortcut, ...started }, null, 2));
} else if (cmd === 'shortcut') {
  const cdpShortcut = createCdpShortcut();
  console.log(JSON.stringify({ ok: cdpShortcut.ok, action: 'shortcut', ...cdpShortcut }, null, 2));
  if (!cdpShortcut.ok) process.exitCode = 1;
} else if (cmd === 'start') {
  const started = await startDaemon({ port, wallpaper: values.wallpaper });
  console.log(JSON.stringify({ ok: Boolean(started.health?.ok || started.alreadyRunning), action: 'start', ...started }, null, 2));
} else if (cmd === 'stop') {
  const res = await stopDaemon(port);
  console.log(JSON.stringify({ ok: true, action: 'stop', ...res }, null, 2));
} else if (cmd === 'uninstall') {
  const stopped = await stopDaemon(port);
  const taskRemoved = removeScheduledTask();
  rmSync(vbsFile, { force: true });
  rmSync(metaFile, { force: true });
  console.log(JSON.stringify({ ok: true, action: 'uninstall', ...stopped, taskRemoved, settingsKept: resolve(dataDir, 'settings.json') }, null, 2));
} else if (cmd === 'status') {
  const { pid, port: activePort, health } = await findDaemon(port);
  let settings = null;
  if (health?.ok) {
    try {
      settings = await fetch(`http://127.0.0.1:${activePort}/api/settings`).then((r) => r.json());
    } catch {}
  }
  console.log(JSON.stringify({
    ok: Boolean(health?.ok),
    running: Boolean(pid && health?.ok),
    pid,
    port: activePort,
    scheduledTaskRegistered: queryScheduledTask(),
    health,
    activeId: settings?.activeId ?? null,
    enabled: settings?.enabled ?? null,
    glassPreset: settings?.glass?.preset ?? null,
  }, null, 2));
} else {
  console.error('Usage: node install.mjs <install|start|stop|status|shortcut|uninstall> [--port 18765] [--wallpaper <id>]');
  process.exitCode = 1;
}
