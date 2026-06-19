import {
  cmdHelp,
  cmdModels,
  cmdModel,
  cmdSkills,
  cmdSession,
  cmdProvider,
  cmdSettings,
  cmdTools,
  cmdWorkspace,
  cmdMemory,
  cmdHeartbeat,
  cmdCron,
  cmdHeal,
  cmdPromptOptimize,
  cmdNetwork,
  cmdMcp,
  cmdWorkflow,
  cmdUpgrade,
  cmdSystemExecute,
  type CLIContext,
} from '../cli/commands';
import type { ApiDependencies, ApiRuntimeState, ChatApiResponse, ChatRequestBody } from './types';
import type { IProvider } from '../types/provider';
import { resolveStartupSession } from '../cli';
import { createLogger } from '../utils/logger';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const logger = createLogger('api:routes');

export interface ChatRouteOptions {
  signal?: AbortSignal;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function sanitizeFlowForApi(flow: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return flow.map((step) => {
    if (typeof step['reason'] !== 'string') return step;
    const cleaned = step['reason']
      .replace(/(the user is asking|from memory|i should|i need to|based on|analysis:|reasoning:)/gi, '')
      .trim();
    return cleaned ? { ...step, reason: cleaned } : { ...step, reason: undefined };
  });
}

function makeResponse(fields: Partial<ChatApiResponse>): ChatApiResponse {
  return {
    model: fields.model ?? null,
    provider: fields.provider ?? null,
    result: fields.result ?? null,
    token: fields.token ?? null,
    responseTime: fields.responseTime ?? '0 ms',
    tools: fields.tools ?? [],
    flow: fields.flow ? sanitizeFlowForApi(fields.flow) : [],
    sessionId: fields.sessionId ?? null,
    error_detail: fields.error_detail ?? [],
    ...(fields.promptOptimization ? { promptOptimization: fields.promptOptimization } : {}),
    ...(fields.preferredProvider !== undefined ? { preferredProvider: fields.preferredProvider } : {}),
    ...(fields.preferredModel !== undefined ? { preferredModel: fields.preferredModel } : {}),
    ...(fields.fallbackUsed !== undefined ? { fallbackUsed: fields.fallbackUsed } : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function defaultModelForProvider(
  provider: IProvider,
  deps: ApiDependencies
): Promise<string> {
  const configured =
    (await deps.settings.getDefaultModelForProvider(provider.id)) ??
    process.env[`${provider.id.toUpperCase()}_DEFAULT_MODEL`];
  if (configured?.trim()) return configured.trim();
  const models = await provider.listModels();
  return models[0]?.id ?? 'default';
}

async function resolveRequestProvider(
  body: ChatRequestBody,
  deps: ApiDependencies,
  state: ApiRuntimeState
): Promise<{
  provider: IProvider;
  model: string;
  preferredProvider?: string;
  preferredModel?: string;
  preferredUnavailable: boolean;
}> {
  const preferredProvider = optionalString(body.preferredProvider)?.toLowerCase();
  const preferredModel = optionalString(body.preferredModel);

  if (!preferredProvider) {
    return {
      provider: state.activeProvider,
      model: state.activeModel,
      preferredUnavailable: false,
    };
  }

  const provider = deps.providers.get(preferredProvider);
  if (!provider) {
    logger.warn('preferred provider unavailable; using active provider', {
      preferredProvider,
      activeProvider: state.activeProvider.id,
    });
    return {
      provider: state.activeProvider,
      model: state.activeModel,
      preferredProvider,
      ...(preferredModel ? { preferredModel } : {}),
      preferredUnavailable: true,
    };
  }

  return {
    provider,
    model: preferredModel ?? await defaultModelForProvider(provider, deps),
    preferredProvider,
    ...(preferredModel ? { preferredModel } : {}),
    preferredUnavailable: false,
  };
}

export async function createApiRuntimeState(deps: ApiDependencies): Promise<ApiRuntimeState> {
  const savedProvider = await deps.settings.getDefaultProvider();
  const priority = ['zai', 'groq', 'openrouter', 'mistral', 'anthropic', 'openai', 'gemini', 'llamacpp', 'ollama'];
  let activeProvider: IProvider | undefined;

  if (savedProvider && deps.providers.has(savedProvider)) {
    activeProvider = deps.providers.get(savedProvider);
  }

  if (!activeProvider) {
    for (const id of priority) {
      const provider = deps.providers.get(id);
      if (provider) {
        activeProvider = provider;
        break;
      }
    }
  }

  activeProvider ??= [...deps.providers.values()][0];
  if (!activeProvider) throw new Error('No providers available for API server.');

  const activeModel =
    (await deps.settings.getDefaultModelForProvider(activeProvider.id)) ??
    (await deps.settings.getDefaultModel()) ??
    'unknown';

  const session = await resolveStartupSession(
    deps.sessions,
    deps.settings,
    activeProvider,
    activeModel,
    deps.skillRegistry.activeIds
  );

  return {
    activeProvider,
    activeModel,
    activeSessionId: session.id,
  };
}

function createCommandContext(deps: ApiDependencies, state: ApiRuntimeState): CLIContext {
  return {
    providers: deps.providers,
    skillRegistry: deps.skillRegistry,
    sessions: deps.sessions,
    settings: deps.settings,
    toolRegistry: deps.toolRegistry,
    ...(deps.mcpManager ? { mcpManager: deps.mcpManager } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    ...(deps.selfHealing ? { selfHealing: deps.selfHealing } : {}),
    get activeProvider() { return state.activeProvider; },
    get activeModel() { return state.activeModel; },
    get activeSessionId() { return state.activeSessionId; },
    setProvider(provider: IProvider, model: string) {
      state.activeProvider = provider;
      state.activeModel = model;
    },
    setModel(model: string) {
      state.activeModel = model;
    },
    async setSession(id: string | null) {
      state.activeSessionId = id;
      if (id) {
        await deps.settings.setLastActiveSessionId(id);
      } else {
        await deps.settings.clearLastActiveSessionId();
      }
    },
  };
}

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = '';

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return stripAnsi(output).trim();
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function handleCommand(
  message: string,
  deps: ApiDependencies,
  state: ApiRuntimeState,
  startedAt: number
): Promise<{ status: number; body: ChatApiResponse }> {
  const parts = message.trim().slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);
  const ctx = createCommandContext(deps, state);

  if (['exit', 'quit', 'q'].includes(cmd)) {
    return {
      status: 400,
      body: makeResponse({
        provider: state.activeProvider.id,
        model: state.activeModel,
        responseTime: `${Date.now() - startedAt} ms`,
        sessionId: state.activeSessionId,
        error_detail: ['/exit is not available through the HTTP API.'],
      }),
    };
  }

  const result = await captureStdout(async () => {
    switch (cmd) {
      case 'help': case 'h': cmdHelp(); break;
      case 'models': case 'm': await cmdModels(ctx, args); break;
      case 'model': await cmdModel(ctx, args); break;
      case 'skills': case 'sk': cmdSkills(ctx, args); break;
      case 'session': case 's': await cmdSession(ctx, args); break;
      case 'provider': case 'providers': case 'p': await cmdProvider(ctx, args); break;
      case 'settings': await cmdSettings(ctx, args); break;
      case 'tools': case 't': await cmdTools(ctx, args); break;
      case 'workspace': case 'w': await cmdWorkspace(ctx, args); break;
      case 'memory': case 'mem': await cmdMemory(ctx, args); break;
      case 'heartbeat': case 'hb': await cmdHeartbeat(ctx, args); break;
      case 'cron': case 'jobs': case 'schedule': await cmdCron(ctx, args); break;
      case 'heal': case 'self-heal': case 'fix': case 'restart': await cmdHeal(ctx, cmd === 'fix' ? ['run', ...args] : cmd === 'restart' ? ['restart', ...args] : args); break;
      case 'upgrade': case 'self-upgrade': await cmdUpgrade(ctx, args); break;
      case 'prompt-optimize': case 'po': await cmdPromptOptimize(ctx, args); break;
      case 'system-execute': case 'exec': await cmdSystemExecute(ctx, args); break;
      case 'network': case 'net': await cmdNetwork(ctx, args); break;
      case 'mcp': await cmdMcp(ctx, args); break;
      case 'workflow': case 'wf': await cmdWorkflow(ctx, args); break;
      default:
        process.stdout.write(`Unknown command: /${cmd}. Type /help.`);
    }
  });

  return {
    status: 200,
    body: makeResponse({
      provider: state.activeProvider.id,
      model: state.activeModel,
      result,
      responseTime: `${Date.now() - startedAt} ms`,
      flow: [{ stage: 'final', type: 'command', command: `/${cmd}` }],
      sessionId: state.activeSessionId,
    }),
  };
}

export async function handleChatRoute(
  body: ChatRequestBody,
  deps: ApiDependencies,
  state: ApiRuntimeState,
  options: ChatRouteOptions = {}
): Promise<{ status: number; body: ChatApiResponse }> {
  const startedAt = Date.now();
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : undefined;
  const providerSelection = await resolveRequestProvider(body, deps, state);

  if (!message) {
    return {
      status: 400,
      body: makeResponse({
        provider: state.activeProvider.id,
        model: state.activeModel,
        responseTime: `${Date.now() - startedAt} ms`,
        sessionId: state.activeSessionId,
        error_detail: ['Request body must include a non-empty string "message".'],
      }),
    };
  }

  try {
    if (message.startsWith('/')) {
      return handleCommand(message, deps, state, startedAt);
    }

    let activeSessionId = sessionId ?? state.activeSessionId;
    if (!activeSessionId) {
      const session = await resolveStartupSession(
        deps.sessions,
        deps.settings,
        providerSelection.provider,
        providerSelection.model,
        deps.skillRegistry.activeIds
      );
      activeSessionId = session.id;
    }

    const result = await deps.orchestrator.turn({
      userInput: message,
      provider: providerSelection.provider,
      model: providerSelection.model,
      sessionId: activeSessionId,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    state.activeSessionId = result.session.id;
    await deps.settings.setLastActiveSessionId(result.session.id);

    const usage = result.chatResponse?.usage;
    return {
      status: 200,
      body: makeResponse({
        provider: result.usedFallback && result.fallbackProvider
          ? result.fallbackProvider
          : providerSelection.provider.id,
        model: result.chatResponse?.model ?? providerSelection.model,
        result: result.assistantText,
        token: usage ? `${usage.totalTokens} token` : null,
        responseTime: `${result.chatResponse?.latencyMs ?? Date.now() - startedAt} ms`,
        tools: result.toolsUsed ?? [],
        flow: result.flow,
        sessionId: result.session.id,
        ...(result.promptOptimization ? { promptOptimization: result.promptOptimization } : {}),
        ...(providerSelection.preferredProvider ? { preferredProvider: providerSelection.preferredProvider } : {}),
        ...(providerSelection.preferredModel ? { preferredModel: providerSelection.preferredModel } : {}),
        fallbackUsed: providerSelection.preferredUnavailable || Boolean(result.usedFallback),
      }),
    };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return {
      status: 500,
      body: makeResponse({
        provider: state.activeProvider.id,
        model: state.activeModel,
        responseTime: `${Date.now() - startedAt} ms`,
        sessionId: state.activeSessionId,
        error_detail: [messageText],
        ...(providerSelection.preferredProvider ? { preferredProvider: providerSelection.preferredProvider } : {}),
        ...(providerSelection.preferredModel ? { preferredModel: providerSelection.preferredModel } : {}),
        fallbackUsed: providerSelection.preferredUnavailable,
      }),
    };
  }
}
