/**
 * Port allocation for the proxy that talks to Renesas Playground.
 *
 * The proxy listens on 0.0.0.0, so a port "free on 127.0.0.1" may still be
 * taken globally. We bind on 0.0.0.0 here to mirror that.
 *
 * Port layout (avoid collisions across coexisting installs):
 *   • CLI proxy (manual `./run.sh`)              : 8100–8199
 *   • AURA v1 extension (renesas-ai.aura)        : 8200–8299
 *   • AURA v2 extension (renesas-ai.aura-v2)     : 8300–8399
 *   • Official AURA    (renesas-ai.official-aura): 8400–8499  ← this build
 *
 * Each window picks a port via username-hash inside its own range, so the
 * three installs can run side-by-side without binding on each other's ports.
 *
 * The user can override via `officialAura.proxy.portRange` setting.
 */

import * as os  from 'os';
import * as net from 'net';

// Official AURA: 8400–8499 (100 slots).
export const EXT_PORT_START = 8400;
export const EXT_PORT_END   = 8500;

export function hashUsernameToPort(start = EXT_PORT_START, end = EXT_PORT_END): number {
  const user = os.userInfo().username || 'default';
  let h = 0;
  for (const ch of user) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return start + (h % (end - start));
}

/**
 * Try to bind on 0.0.0.0:port. Resolves true only if no other process
 * holds the port on any interface (mirrors what proxy_station does).
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

export async function pickAvailablePort(start = EXT_PORT_START, end = EXT_PORT_END): Promise<number> {
  const preferred = hashUsernameToPort(start, end);
  if (await isPortFree(preferred)) return preferred;
  for (let p = start; p < end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port in ${start}–${end}`);
}
