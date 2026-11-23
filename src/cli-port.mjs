export function parsePort(value) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return port;
}
