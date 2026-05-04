/**
 * src/index.ts
 * Bootstrap entry point — Part 4: Full integration with CLI.
 *
 * Flow:
 *   loadConfig → providers → skills → storage → orchestrator → CLI
 */

import { loadConfig } from './config';
import { createLogger, setRootLogLevel } from './utils/logger';
import { createProviderRegistry } from './providers';
import { SkillRegistry } from './skills';
import { SessionManager } from './storage';
import { Orchestrator } from './agents';
import { startCLI } from './cli';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  setRootLogLevel(config.logLevel);

  const logger = createLogger('bootstrap');

  if (config.env !== 'production') {
    logger.debug('native-openclaw starting', {
      env: config.env,
      logLevel: config.logLevel,
      storageBackend: config.storage.backend,
      dataDir: config.storage.dataDir,
    });
  }

  // ── Providers ───────────────────────────────────────────────────────────────
  const providers = await createProviderRegistry(config);

  if (providers.size === 0) {
    logger.warn('No providers available. Set at least one API key or start Ollama.');
  } else {
    logger.debug(`Providers ready: ${[...providers.keys()].join(', ')}`);
  }

  // ── Skills ──────────────────────────────────────────────────────────────────
  const skillRegistry = new SkillRegistry();
  await skillRegistry.load();

  if (skillRegistry.size > 0) {
    logger.debug(`Skills loaded: ${skillRegistry.all().map((s) => s.id).join(', ')}`);
  }

  // ── Storage ─────────────────────────────────────────────────────────────────
  const sessions = new SessionManager(config.storage.dataDir);

  // ── Orchestrator ─────────────────────────────────────────────────────────────
  const orchestrator = new Orchestrator(sessions, skillRegistry, {
    baseSystemPrompt: config.agent.systemPrompt,
    maxTurns:   config.agent.maxTurns,
    temperature: config.agent.temperature,
    maxTokens:  config.agent.maxTokens,
  });

  // ── CLI ─────────────────────────────────────────────────────────────────────
  await startCLI({ providers, skillRegistry, sessions, orchestrator });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[fatal] ${message}\n\n`);
  process.exit(1);
});
