/**
 * src/index.ts
 * Bootstrap — wires all services and starts CLI.
 */

import { loadConfig } from './config';
import { createLogger, setRootLogLevel } from './utils/logger';
import { createProviderRegistry } from './providers';
import { SkillRegistry } from './skills';
import { SessionManager, SettingsManager } from './storage';
import { Orchestrator } from './agents';
import { startCLI } from './cli';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  setRootLogLevel(config.logLevel);
  const logger = createLogger('bootstrap');

  if (config.env !== 'production') {
    logger.debug('native-openclaw starting', {
      env: config.env,
      dataDir: config.storage.dataDir,
    });
  }

  // Providers
  const providers = await createProviderRegistry(config);
  if (providers.size === 0) {
    logger.warn('No providers available. Set at least one API key or start Ollama.');
  }

  // Skills
  const skillRegistry = new SkillRegistry();
  await skillRegistry.load();

  // Storage
  const sessions = new SessionManager(config.storage.dataDir);
  const settings = new SettingsManager(config.storage.dataDir);

  // Orchestrator
  const orchestrator = new Orchestrator(sessions, skillRegistry, {
    baseSystemPrompt: config.agent.systemPrompt,
    maxTurns:         config.agent.maxTurns,
    temperature:      config.agent.temperature,
    maxTokens:        config.agent.maxTokens,
  });

  // CLI
  await startCLI({ providers, skillRegistry, sessions, settings, orchestrator });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[fatal] ${message}\n\n`);
  process.exit(1);
});
