/**
 * src/index.ts
 * Bootstrap v8 — wires router, semantic memory, reasoning engine.
 */

import { loadConfig } from './config';
import { createLogger, setRootLogLevel } from './utils/logger';
import { createProviderRegistry } from './providers';
import { SkillRegistry } from './skills';
import { SessionManager, SettingsManager, MemoryManager } from './storage';
import { ToolRegistry } from './tools/tool-registry';
import { ProviderRouter } from './router/provider-router';
import { SemanticMemory } from './memory/semantic-memory';
import { ContextCompressor } from './memory/context-compressor';
import { Orchestrator } from './agents';
import { startCLI } from './cli';
import { WorkspaceManager } from './workspace';
import { startApiServerIfEnabled } from './api';
import { startTelegramIntegrationIfEnabled } from './integrations';
import { configureDnsDefaults } from './network';
import { McpManager } from './mcp';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  setRootLogLevel(config.logLevel);
  configureDnsDefaults();

  const logger = createLogger('bootstrap');

  if (config.env !== 'production') {
    logger.debug('native-openclaw v8 starting', {
      env: config.env,
      dataDir: config.storage.dataDir,
    });
  }

  // Providers
  const providers = await createProviderRegistry(config);

  if (providers.size === 0) {
    logger.warn('No providers available. Set at least one API key or start Ollama.');
  }

  // Settings
  const settings = new SettingsManager(config.storage.dataDir);

  // Router
  const routerEnabled = await settings.getRouterEnabled();
  const autoFallback = await settings.getAutoFallback();

  const router = new ProviderRouter(providers, {
    enabled: routerEnabled,
    autoFallback,
    autoSwitch: process.env['AUTO_SWITCH'] !== 'false',
    maxAttempts: 4,
    dataDir: config.storage.dataDir,
  });

  await router.init();

  logger.info(`Router: ${routerEnabled ? 'enabled' : 'disabled'}, autoFallback: ${autoFallback}`);

  // Skills
  const skillRegistry = new SkillRegistry();
  await skillRegistry.load();

  // Storage
  const sessions = new SessionManager(config.storage.dataDir);
  const memory = new MemoryManager(config.storage.dataDir);

  // Semantic memory + context compressor
  const semanticMemory = new SemanticMemory(config.storage.dataDir);
  await semanticMemory.load();

  const contextCompressor = new ContextCompressor(semanticMemory);

  logger.info(`Semantic memory: ${semanticMemory.size()} chunks loaded`);

  // Restore agent identity
  const agentName = await memory.getGlobalValue('agentName');

  if (agentName) {
    logger.info(`Agent identity restored: "${String(agentName)}"`);
  }

  // Plugin tool registry
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();
  logger.info(`Workspace ready: ${workspace.rootDir}`);

  const toolRegistry = new ToolRegistry(process.cwd());
  await toolRegistry.loadTools();

  let mcpManager: McpManager | undefined;
  if (config.mcp.enabled) {
    mcpManager = new McpManager({
      configPath: config.mcp.configPath,
      toolRegistry,
    });
    await mcpManager.init();
    const mcpResults = await mcpManager.startAllConfigured();
    const failed = mcpResults.filter((result) => !result.ok);
    if (failed.length > 0) {
      logger.warn('Some MCP servers failed to start', { failed });
    }
    logger.info('MCP ready', {
      servers: mcpResults.length,
      tools: mcpManager.listTools().map((tool) => tool.runtimeName),
    });
  }

  logger.info(`Tools ready (${toolRegistry.size})`, {
    tools: toolRegistry.listTools().map((tool) => tool.manifest.name),
  });

  // Orchestrator
  const orchestrator = new Orchestrator(
    sessions,
    skillRegistry,
    memory,
    toolRegistry,
    router,
    contextCompressor,
    {
      baseSystemPrompt: config.agent.systemPrompt,
      maxTurns: config.agent.maxTurns,
      temperature: config.agent.temperature,
      maxTokens: config.agent.maxTokens,
      useReasoning: process.env['REASONING_ENABLED'] !== 'false',
      useSemanticCompression: process.env['SEMANTIC_MEMORY'] !== 'false',
      ...(mcpManager ? { mcpManager } : {}),
    }
  );

  await startApiServerIfEnabled({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
  });

  await startTelegramIntegrationIfEnabled({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
  }, config.storage.dataDir);

  // CLI
  await startCLI({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
  });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  process.stderr.write(`\n[fatal] ${message}\n\n`);
  process.exit(1);
});
