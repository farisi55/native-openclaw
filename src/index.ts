/**
 * src/index.ts
 * Bootstrap v8 - wires router, semantic memory, scheduler, and autonomous maintenance.
 */

import { loadConfig } from './config';
import { getEnvBool, getEnvInt, getOptionalEnv, SELF_IMPROVING, SELF_IMPROVING_EVAL_THRESHOLD } from './config/env';
import { createLogger, setRootLogLevel } from './utils/logger';
import { createProviderRegistry } from './providers';
import { SkillRegistry } from './skills';
import { SessionManager, SettingsManager, MemoryManager } from './storage';
import { ToolRegistry } from './tools/tool-registry';
import { ProviderRouter } from './router/provider-router';
import { SemanticMemory } from './memory/semantic-memory';
import { ContextCompressor } from './memory/context-compressor';
import { Orchestrator } from './agents';
import { createMessage, extractText } from './types/message';
import type { IProvider, ChatOptions, ChatResponse, ModelInfo } from './types/provider';
import { startCLI } from './cli';
import { WorkspaceManager } from './workspace';
import { createApiRuntimeState, startApiServerIfEnabled } from './api';
import { startTelegramIntegrationIfEnabled, type TelegramIntegration } from './integrations';
import { configureDnsDefaults, setupGlobalProxy } from './network';
import { McpManager } from './mcp';
import { createMcpAgentConfigureTool, McpAgentService } from './mcp-agent';
import { SchedulerEngine, SchedulerStore, type SchedulerActionContext } from './scheduler';
import { jobRequiresEmail } from './scheduler/scheduler-engine';
import { startWebUiServerIfEnabled, type StartedWebUiServer } from './web-ui';
import {
  SelfHealingEngine,
  SelfUpgradeEngine,
  type HealingEngineConfig,
  type SelfHealingActionContext,
  type UpgradeEngineConfig,
} from './self-healing';
import { LifecycleManager } from './runtime/lifecycle-manager';
import { sendPendingRestartNotificationIfAny } from './runtime/restart-notifier';

const autonomousLogger = createLogger('bootstrap:autonomous');

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parseEmailContentJson(raw: string): { subject: string; htmlContent: string } | null {
  try {
    const parsed = JSON.parse(stripJsonFences(raw)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const subject = typeof record['subject'] === 'string' ? record['subject'].trim() : '';
    const htmlContent = typeof record['htmlContent'] === 'string' ? record['htmlContent'].trim() : '';
    return subject && htmlContent ? { subject, htmlContent } : null;
  } catch {
    return null;
  }
}

function parsePreferredModel(value: string): { providerId?: string; modelId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      providerId: trimmed.slice(0, slash).trim().toLowerCase(),
      modelId: trimmed.slice(slash + 1).trim(),
    };
  }
  return { modelId: trimmed };
}

async function defaultModelForProvider(provider: IProvider): Promise<string> {
  const envModel = process.env[`${provider.id.toUpperCase()}_DEFAULT_MODEL`];
  if (envModel?.trim()) return envModel.trim();
  const models = await provider.listModels();
  return models[0]?.id ?? 'default';
}

function modelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    contextWindow: 0,
    supportsTools: false,
    supportsVision: false,
  };
}

function createAutonomousProvider(
  router: ProviderRouter,
  envKey: 'SELF_HEALING_MODEL' | 'SELF_UPGRADE_MODEL',
  displayName: string
): IProvider | undefined {
  const fallbackProvider = router.bestProvider();
  if (!fallbackProvider) return undefined;

  let selectionPromise: Promise<{ provider: IProvider; model: string }> | null = null;
  const fallback = async (): Promise<{ provider: IProvider; model: string }> => ({
    provider: fallbackProvider,
    model: await defaultModelForProvider(fallbackProvider),
  });

  const resolveSelection = async (): Promise<{ provider: IProvider; model: string }> => {
    const preferred = parsePreferredModel(getOptionalEnv(envKey) ?? '');
    if (!preferred) return fallback();

    if (preferred.providerId) {
      const provider = router.getProvider(preferred.providerId);
      if (!provider) {
        autonomousLogger.warn(`${envKey} provider not found; using default router`, { provider: preferred.providerId });
        return fallback();
      }
      return { provider, model: preferred.modelId };
    }

    const matches: IProvider[] = [];
    for (const provider of router.allProviders()) {
      try {
        const models = await provider.listModels();
        if (models.some((model) => model.id === preferred.modelId)) matches.push(provider);
      } catch {
        // Skip providers that cannot list models during bootstrap.
      }
    }

    if (matches.length === 1) return { provider: matches[0]!, model: preferred.modelId };
    if (matches.length > 1) {
      autonomousLogger.warn(`${envKey} is ambiguous; using default router`, {
        model: preferred.modelId,
        providers: matches.map((provider) => provider.id),
      });
      return fallback();
    }

    autonomousLogger.warn(`${envKey} model not found; using default router`, { model: preferred.modelId });
    return fallback();
  };

  const getSelection = (): Promise<{ provider: IProvider; model: string }> => {
    selectionPromise ??= resolveSelection();
    return selectionPromise;
  };

  return {
    id: `${envKey.toLowerCase().replace(/_/g, '-')}-router`,
    displayName,
    async listModels() {
      const selection = await getSelection();
      return [modelInfo(selection.model)];
    },
    async chat(options: ChatOptions): Promise<ChatResponse> {
      const selection = await getSelection();
      const routed = await router.chat(
        selection.provider,
        selection.model,
        { ...options, model: selection.model },
        displayName
      );
      return routed.response;
    },
  };
}

function splitCommands(raw: string): string[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function autonomousTemperature(key: 'AUTONOMOUS_CODING_TEMPERATURE' | 'AUTONOMOUS_QA_TEMPERATURE'): number {
  const value = Number.parseFloat(getOptionalEnv(key, '0.1') ?? '0.1');
  return Number.isFinite(value) ? value : 0.1;
}

function createHealingConfig(dataDir: string): HealingEngineConfig {
  return {
    enabled: getEnvBool('SELF_HEALING_ENABLED', false),
    maxLoops: getEnvInt('SELF_HEALING_MAX_LOOPS', 3),
    autoApply: getEnvBool('SELF_HEALING_AUTO_APPLY', true),
    autoInstall: getEnvBool('SELF_HEALING_AUTO_INSTALL', true),
    autoRollback: getEnvBool('SELF_HEALING_AUTO_ROLLBACK', true),
    autoRestart: getEnvBool('SELF_HEALING_AUTO_RESTART', false),
    testCommands: splitCommands(getOptionalEnv('SELF_HEALING_TEST_COMMANDS', 'npm run build,npm test,npm run test') ?? 'npm run build,npm test,npm run test'),
    timeoutMs: getEnvInt('SELF_HEALING_TIMEOUT_MS', 120_000),
    workdir: getOptionalEnv('SELF_HEALING_WORKDIR', '.') ?? '.',
    runsDir: getOptionalEnv('SELF_HEALING_RUNS_DIR', './workspace/self-healing/runs') ?? './workspace/self-healing/runs',
    dataDir,
    redactSecrets: getEnvBool('SELF_HEALING_REDACT_SECRETS', true),
    temperature: autonomousTemperature('AUTONOMOUS_CODING_TEMPERATURE'),
  };
}

function createUpgradeConfig(healingConfig: HealingEngineConfig): UpgradeEngineConfig {
  return {
    ...healingConfig,
    enabled: getEnvBool('SELF_UPGRADE_ENABLED', false),
    maxLoops: getEnvInt('SELF_UPGRADE_MAX_LOOPS', 3),
    autoApply: getEnvBool('SELF_UPGRADE_AUTO_APPLY', true),
    autoInstall: getEnvBool('SELF_UPGRADE_AUTO_INSTALL', true),
    autoRollback: getEnvBool('SELF_UPGRADE_AUTO_ROLLBACK', true),
    autoRestart: getEnvBool('SELF_UPGRADE_AUTO_RESTART', true),
    autoRegister: getEnvBool('SELF_UPGRADE_AUTO_REGISTER', true),
    allowedTargets: (getOptionalEnv('SELF_UPGRADE_ALLOWED_TARGETS', 'repo') ?? 'repo')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    temperature: autonomousTemperature('AUTONOMOUS_CODING_TEMPERATURE'),
  };
}

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

  const providers = await createProviderRegistry(config);
  if (providers.size === 0) {
    logger.warn('No providers available. Set at least one API key or start Ollama.');
  }

  const settings = new SettingsManager(config.storage.dataDir);
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

  const skillRegistry = new SkillRegistry();
  await skillRegistry.load();

  const sessions = new SessionManager(config.storage.dataDir);
  const memory = new MemoryManager(config.storage.dataDir);
  const semanticMemory = new SemanticMemory(config.storage.dataDir);
  await semanticMemory.load();

  const contextCompressor = new ContextCompressor(semanticMemory);
  logger.info(`Semantic memory: ${semanticMemory.size()} chunks loaded`);

  let schedulerEngine: SchedulerEngine | undefined;
  let telegramIntegration: TelegramIntegration | null = null;
  let webUiServer: StartedWebUiServer | null = null;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[shutdown] ${signal} received - flushing memory...\n`);
    schedulerEngine?.stop();
    await webUiServer?.close().catch((err: unknown) => {
      logger.warn('Web UI shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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

  const agentName = await memory.getGlobalValue('agentName');
  if (agentName) {
    logger.info(`Agent identity restored: "${String(agentName)}"`);
  }

  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();
  logger.info(`Workspace ready: ${workspace.rootDir}`);

  const toolRegistry = new ToolRegistry(process.cwd());
  await toolRegistry.loadTools();

  const mcpAgent = new McpAgentService({
    enabled: getEnvBool('MCP_AGENT_ENABLED', true),
    allowConfigWrite: getEnvBool('MCP_AGENT_ALLOW_CONFIG_WRITE', true),
    projectRoot: process.cwd(),
    configPath: getOptionalEnv('MCP_AGENT_CONFIG_PATH', './mcp_agent.config.yaml') ?? './mcp_agent.config.yaml',
  });
  if (mcpAgent.enabled) {
    toolRegistry.registerRuntimeTool(createMcpAgentConfigureTool(mcpAgent));
    logger.info('MCP Agent self-configuration ready', {
      configPath: mcpAgent.configService.defaultConfigPath,
    });
  }

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

  const lifecycleManager = new LifecycleManager();
  const healingConfig = createHealingConfig(config.storage.dataDir);
  const upgradeConfig = createUpgradeConfig(healingConfig);
  const healingProvider = createAutonomousProvider(router, 'SELF_HEALING_MODEL', 'Self-Healing Router');
  const upgradeProvider = createAutonomousProvider(router, 'SELF_UPGRADE_MODEL', 'Self-Upgrade Router');
  const selfHealingEngine = new SelfHealingEngine(healingConfig, {
    ...(healingProvider ? { provider: healingProvider } : {}),
    lifecycleManager,
  });
  const selfUpgradeEngine = new SelfUpgradeEngine(upgradeConfig, {
    ...(upgradeProvider ? { provider: upgradeProvider } : {}),
    lifecycleManager,
  });
  const selfHealingContext: SelfHealingActionContext = {
    healingEnabled: healingConfig.enabled,
    upgradeEnabled: upgradeConfig.enabled,
    runsDir: healingConfig.runsDir,
    healingEngine: selfHealingEngine,
    upgradeEngine: selfUpgradeEngine,
    lifecycleManager,
  };

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
      ...(mcpAgent.enabled ? { mcpAgent } : {}),
      scheduler,
      selfHealing: selfHealingContext,
    }
  );

  const selfImprovingContext = orchestrator.getSelfImprovingActionContext();

  schedulerEngine = new SchedulerEngine({
    store: schedulerStore,
    workspace,
    toolRegistry,
    ...(selfImprovingContext.engine
      ? { selfImprovement: (input) => selfImprovingContext.engine!.processCompletedTurn(input) }
      : {}),
    emailContentGenerator: async (input) => {
      const state = await createApiRuntimeState({
        providers,
        skillRegistry,
        sessions,
        settings,
        toolRegistry,
        orchestrator,
        ...(mcpManager ? { mcpManager } : {}),
        scheduler,
        selfHealing: selfHealingContext,
      });

      const prompt = [
        'You are generating an email for a scheduled Native OpenClaw job.',
        'Output ONLY valid JSON:',
        '{ "subject": "string", "htmlContent": "string" }',
        '',
        'Rules:',
        '- Use Indonesian.',
        '- Base content on provided data.',
        '- Do not claim unsupported facts.',
        '- If data is incomplete, mention limitation.',
        '- Do not include markdown fences.',
        '- Do not include API keys.',
        '- Subject must be concise.',
        '- htmlContent must be a valid HTML snippet.',
        '',
        `Job name: ${input.job.name}`,
        `Topic: ${input.topic}`,
        `Search query: ${input.searchQuery}`,
        `Scheduled at: ${input.now.toISOString()}`,
        `Job prompt: ${input.job.prompt}`,
        input.webFetchResult ? `Fetched data:\n${input.webFetchResult}` : 'Fetched data: unavailable',
      ].join('\n');

      const response = await state.activeProvider.chat({
        model: state.activeModel,
        messages: [createMessage({ role: 'user', content: prompt })],
        temperature: 0,
        maxTokens: 1200,
      });
      const parsed = parseEmailContentJson(extractText(response.message.content));
      if (!parsed) throw new Error('Provider did not return valid email content JSON.');
      return parsed;
    },
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
        selfHealing: selfHealingContext,
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
    selfHealing: selfHealingContext,
  });

  webUiServer = await startWebUiServerIfEnabled({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
    scheduler,
    selfHealing: selfHealingContext,
  }).catch((err: unknown) => {
    logger.error('Web UI failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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
    selfHealing: selfHealingContext,
  }, config.storage.dataDir);

  await sendPendingRestartNotificationIfAny()
    .then((result) => {
      if (!result) return;
      logger.info('restart after-start notification processed', {
        ok: result.ok,
        telegram: result.telegram?.ok ?? false,
        email: result.email?.ok ?? false,
        errors: result.errors,
      });
    })
    .catch((err: unknown) => {
      logger.warn('restart after-start notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await startCLI({
    providers,
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator,
    ...(mcpManager ? { mcpManager } : {}),
    scheduler,
    selfImproving: orchestrator.getSelfImprovingActionContext(),
    selfHealing: selfHealingContext,
  });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[fatal] ${message}\n\n`);
  process.exit(1);
});
