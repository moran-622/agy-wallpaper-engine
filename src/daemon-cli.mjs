import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { startCdpDaemon } from './cdp-daemon.mjs';
import { parsePort } from './cli-port.mjs';
import { defaultSettingsPath } from './config-store.mjs';
import { createMediaServer } from './media-server.mjs';

let media;
let daemon;
let pidFile;
function clearPidFile() {
  if (!pidFile) return;
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      wallpaper: { type: 'string' },
      once: { type: 'boolean' },
      settings: { type: 'string' },
      'port-file': { type: 'string' },
      'no-pid-file': { type: 'boolean' },
    },
  });
  const port = parsePort(values.port);
  const trackPid = !values['no-pid-file'] && values.settings === undefined;
  media = await createMediaServer({ port, settingsPath: values.settings, fallbackOnPortInUse: !trackPid });
  if (trackPid) {
    const dataDir = dirname(defaultSettingsPath);
    mkdirSync(dataDir, { recursive: true });
    const { port, baseUrl } = media;
    writeFileSync(join(dataDir, 'daemon-meta.json'), JSON.stringify({
      port, baseUrl, pid: process.pid, startedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    pidFile = join(dataDir, 'daemon.pid');
    writeFileSync(pidFile, String(process.pid), 'utf8');
  }
  const stop = async () => {
    try {
      await daemon?.stop();
    } finally {
      await media.close();
      clearPidFile();
    }
  };
  const startup = (async () => {
    if (values.wallpaper !== undefined) {
      const response = await fetch(`${media.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, activeId: values.wallpaper }),
      });
      if (!response.ok) throw new Error(`Could not set the active wallpaper (HTTP ${response.status})`);
      await response.json();
    }
    daemon = await startCdpDaemon({ baseUrl: media.baseUrl, portFile: values['port-file'], once: values.once });
  })();
  function onSignal() {
    void startup.then(stop, () => {}).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await startup;
  console.log(`Wallpaper Engine media server listening at ${media.baseUrl}`);
  if (values.once) {
    await daemon.ready;
    console.log('Single CDP discovery pass finished. Media stays available until Ctrl+C.');
  }
} catch (error) {
  await daemon?.stop();
  await media?.close();
  clearPidFile();
  console.error(error.message);
  process.exitCode = 1;
}
