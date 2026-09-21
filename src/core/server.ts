/**
 * server.ts — Aether's standalone entrypoint.
 *
 * Replaces the old AURA `extension.ts` activate()/deactivate(). No VS Code
 * host: this constructs the same dependency graph extension.ts did, minus
 * everything that was VS-Code-chrome-only (SidebarProvider, StatusBar, the
 * native webview panel — BrowserServer already replaces that last one) and
 * runs the model-routing proxy as a local child process instead of a
 * Docker container (see ProxyProcessManager).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../utils/logger';
import { Paths } from '../utils/paths';
import { EnvFileManager } from '../auth/EnvFileManager';
import { PresetManager, DEFAULT_PRESET_YAML } from '../preset/PresetManager';
import { ContainerLifecycle } from '../container/ContainerLifecycle';
import { SandboxContainerManager } from '../sandbox/SandboxContainerManager';
import { ProxyProcessManager } from '../proxy/ProxyProcessManager';
import { RuntimeConfig } from './RuntimeConfig';
import { BrowserServer } from '../chat/BrowserServer';
import { ChatPanelV2 } from '../chat/ChatPanelV2';

async function seedPreset(paths: Paths, log: Logger) {
  const exists = await fs.access(paths.presetFile).then(() => true).catch(() => false);
  if (exists) return;
  let bundled = DEFAULT_PRESET_YAML;
  try { bundled = await fs.readFile(paths.bundledPresetFile, 'utf8'); } catch { /* use the built-in default */ }
  await fs.mkdir(path.dirname(paths.presetFile), { recursive: true });
  await fs.writeFile(paths.presetFile, bundled, 'utf8');
  log.info(`[preset] seeded ${paths.presetFile}`);
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dataRoot = process.env.AETHER_DATA_DIR
    ? path.resolve(process.env.AETHER_DATA_DIR)
    : path.join(os.homedir(), '.aether', 'data');
  await fs.mkdir(dataRoot, { recursive: true });

  const log = new Logger('aether', path.join(dataRoot, 'logs', 'aether.log'));
  log.info(`[aether] data root: ${dataRoot}`);

  const paths = new Paths(repoRoot, dataRoot);
  await seedPreset(paths, log);

  const env = new EnvFileManager(log);
  try {
    const saved = JSON.parse(await fs.readFile(paths.envConfigFile, 'utf8'));
    if (saved?.envFilePath) await env.load(saved.envFilePath, true).catch(() => {});
  } catch { /* no .env configured yet — every MCP tool key is optional */ }
  // Also try a plain `.env` next to the repo, since that's what
  // scripts/run.sh and the README point users at. Missing is expected on a
  // fresh install (every MCP tool key is optional), so load silently.
  if (!env.getPath()) {
    await env.load(path.join(repoRoot, '.env'), true).catch(() => {});
  }

  const preset = new PresetManager(paths.presetFile, log);
  await preset.load();

  const lifecycle = new ContainerLifecycle(paths.composeFile, preset, log, dataRoot);
  const proxy = new ProxyProcessManager(repoRoot, log, env);
  const sandbox    = new SandboxContainerManager(lifecycle, log, 'sandbox',     preset);
  const sandboxDev = new SandboxContainerManager(lifecycle, log, 'sandbox-dev', preset);

  const runtimeConfig = new RuntimeConfig(path.join(dataRoot, 'aether-config.json'));
  proxy.setMineruUrl((await runtimeConfig.load()).mineruUrl);

  const browserServer = new BrowserServer(
    path.join(repoRoot, 'frontend'),
    dataRoot,
    repoRoot,
    log,
  );
  const panel = ChatPanelV2.open(proxy, lifecycle, preset, paths, log, env, runtimeConfig, sandbox, sandboxDev);
  const port = await browserServer.start(panel);
  const host = process.env.AETHER_HOST || '127.0.0.1';
  log.info(`[aether] listening at http://${host}:${port} — open this in a browser`);

  // No provider connected yet on a fresh install — that's expected. The
  // proxy starts lazily on first chat send (ChatPanelV2's constructor
  // already calls proxy.ensure() opportunistically); nothing to force here.

  const shutdown = async (signal: string) => {
    log.info(`[aether] ${signal} — shutting down`);
    try { panel.dispose(); } catch { /* ignore */ }
    try { browserServer.dispose(); } catch { /* ignore */ }
    try { proxy.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('[aether] fatal:', e);
  process.exit(1);
});
