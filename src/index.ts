/**
 * src/index.ts
 * Bootstrap v8 — wires router, semantic memory, reasoning engine.
 */

import { loadConfig } from './config';
import { SELF_IMPROVING, SELF_IMPROVING_EVAL_THRESHOLD } from './config/env';
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
import { createApiRuntimeState, startApiServerIfEnabled } from './api';
import { startTelegramIntegrationIfEnabled, type TelegramIntegration } from './integrations';
import { configureDnsDefaults, setupGlobalProxy } from './network';
import { McpManager } from './mcp';
import { SchedulerEngine, SchedulerStore, type SchedulerActionContext } from './scheduler';
import { jobRequiresEmail } from './scheduler/scheduler-engine';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  setRootLogLevel(config.logLevel);
  setupGlobalProxy();
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

  let schedulerEngine: SchedulerEngine | undefined;
  let telegramIntegration: TelegramIntegration | null = null;

  // Graceful shutdown — flush pending semantic memory writes
  const gracefulShutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[shutdown] ${signal} received — flushing memory...\n`);
    schedulerEngine?.stop();
    await semanticMemory.forceSave();
    process.exit(0);
  };

  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('uncaughtException', async (err) => {
    process.stderr.write(`\n[fatal:uncaughtException] ${err.message}\n${err.stack ?? ''}\n`);
    try {
      await semanticMemory.forceSave();
      process.stderr.write('[shutdown] semantic memory flushed\n');
    } catch (saveErr) {
      process.stderr.write(`[shutdown] semantic memory flush failed: ${String(saveErr)}\n`);
    }
    process.exit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`\n[fatal:unhandledRejection] ${message}\n`);
    try {
      await semanticMemory.forceSave();
    } catch {
      // Best effort only during fatal shutdown.
    }
    process.exit(1);
  });
  process.on('exit', () => {
    if (semanticMemory.isDirty) {
      semanticMemory.saveSyncBestEffort();
    }
  });

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
    installedDir: toolRegistry.installedToolsDir,
  });

  const schedulerStore = new SchedulerStore(config.storage.dataDir);
  const scheduler: SchedulerActionContext = {
    store: schedulerStore,
    runJobNow: async (idOrName: string) => {
      if (!schedulerEngine) throw new Error('Scheduler engine is not initialized.');
      return schedulerEngine.runNow(idOrName);
    },
  };

  // Orchestrator
  const orchestrator = new Orchestrator(
    sessions,
    skillRegistry,
    memory,
    toolRegistry,
    router,
    contextCompressor,
    workspace,
    {
      baseSystemPrompt: config.agent.systemPrompt,
      maxTurns: config.agent.maxTurns,
      temperature: config.agent.temperature,
      maxTokens: config.agent.maxTokens,
      useReasoning: process.env['REASONING_ENABLED'] !== 'false',
      useSemanticCompression: process.env['SEMANTIC_MEMORY'] !== 'false',
      selfImproving: SELF_IMPROVING,
      selfImprovingEvalThreshold: SELF_IMPROVING_EVAL_THRESHOLD,
      ...(mcpManager ? { mcpManager } : {}),
      scheduler,
    }
  );

  schedulerEngine = new SchedulerEngine({
    store: schedulerStore,
    workspace,
    onJobComplete: (job, run) => {
      if (!run.output) return;
      const body = run.output.length > 1500
        ? `${run.output.slice(0, 1500)}\n...(output terpotong)`
        : run.output;
      const message = `[${job.name}]\n${body}`;
      process.stdout.write(`\n  \x1b[36mscheduler\x1b[0m  ${message}\n\n`);

      if (telegramIntegration) {
        void telegramIntegration.notifyAllActive(message).catch((err: unknown) => {
          logger.warn('scheduler: telegram notify failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
    executor: async (job, context) => {
      const state = await createApiRuntimeState({
        providers,
        skillRegistry,
        sessions,
        settings,
        toolRegistry,
        orchestrator,
        ...(mcpManager ? { mcpManager } : {}),
        scheduler,
      });

      let sessionId = context.sessionMode === 'last_active'
        ? state.activeSessionId ?? undefined
        : context.sessionId;

      if (context.sessionMode === 'new_each_run' || (context.sessionMode === 'dedicated' && !sessionId)) {
        const created = await sessions.create({
          providerId: state.activeProvider.id,
          model: state.activeModel,
          activeSkills: skillRegistry.activeIds,
          metadata: { scheduledJobId: job.id, scheduledJobName: job.name },
        });
        if (!created.ok) throw created.error;
        sessionId = created.value.id;
      }

      const result = await orchestrator.turn({
        userInput: `[Scheduled job: ${job.name}]\n${job.prompt}`,
        provider: state.activeProvider,
        model: state.activeModel,
        ...(sessionId ? { sessionId } : {}),
        maxToolSteps: 5,
        isScheduledEmailJob: jobRequiresEmail(job),
      });

      return {
        output: result.assistantText,
        ...(result.toolsUsed ? { toolsUsed: result.toolsUsed } : {}),
        ...(result.toolResults ? { toolResults: result.toolResults } : {}),
        sessionId: result.session.id,
      };
    },
  });
  await schedulerEngine.start();

  await startApiServerIfEnabled({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
    scheduler,
  });

  telegramIntegration = await startTelegramIntegrationIfEnabled({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
    scheduler,
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
    scheduler,
  });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  process.stderr.write(`\n[fatal] ${message}\n\n`);
  process.exit(1);
});
