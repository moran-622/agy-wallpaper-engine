import { parseArgs } from 'node:util';
import { createMediaServer } from './media-server.mjs';

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      settings: { type: 'string' },
    },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!/^\d+$/.test(values.port) || port < 0 || port > 65535)) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  const media = await createMediaServer({ port, settingsPath: values.settings });
  console.log(`Wallpaper Engine media server listening at ${media.baseUrl}`);
  const stop = () => media.close().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
