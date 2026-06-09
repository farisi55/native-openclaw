import { isApplicationDebugRequest } from '../agents/application-debug-intent';
import { isSimpleChatIntent } from '../agents/simple-chat-intent';
import { looksLikeSchedulerRequest } from '../scheduler/scheduler-intent';
import { buildSelfUpgradeInstruction, isInformationalCapabilityQuestion, isSelfUpgradeIntent } from '../self-healing';
import { redactSecrets } from '../self-healing';
import { classifyMcpConfigurationIntent } from '../mcp-agent';
import type { OptimizedIntent, PromptReviewResult } from './prompt-optimizer-types';

const EMAIL_SEND_RE =
  /\b(?:kirim(?:kan)?(?:\s+[\s\S]{0,80})?\s+ke\s+email|kirim\s+email|kirimkan\s+email|ke\s+email\s+saya|email\s+saya|send\s+(?:[\s\S]{0,80})?(?:email|to\s+my\s+email)|email\s+it\s+to\s+me)\b/i;

const EMAIL_DRAFT_ONLY_RE = /\b(?:buat|create|tulis|write)\s+(?:draft\s+)?email\b/i;
const WORKSPACE_RE = /\b(?:workspace|MEMORY\.md|WORKFLOW\.md|USER\.md|baca\s+file|tulis\s+file|update\s+WORKFLOW|update\s+MEMORY)\b/i;
const API_RE = /\b(?:api|endpoint|http\s+request|post\s+to|get\s+from\s+api|internal\s+api)\b/i;
const MCP_RE = /\b(?:mcp|model\s+context\s+protocol)\b/i;
const TOOL_RE = /\b(?:web\s+search|cari\s+web|fetch\s+url|ambil\s+data|run\s+command|jalankan\s+command|execute|docker\s+logs)\b/i;
const SELF_HEALING_RE =
  /\b(?:fix\s+bug|perbaiki\s+(?:bug|error)|hilangkan\s+(?:log|notif|notifikasi)\s+error|build\s+gagal|test\s+gagal|runtime\s+error|fix\s+log\s+spam|repair\s+build|solve\s+this\s+error)\b/i;
const EXPLICIT_SYSTEM_COMMAND_RE =
  /\b(?:jalankan\s+command|jalankan\s+perintah|execute|run\s+command|docker\s+logs|docker\s+restart|docker\s+stop|systemctl|pm2|export\s+[A-Z_]+=|restart\s+container|kill\s+process)\b/i;
const STRONG_ACTION_RE =
  /\b(?:upgrade|self\s*upgrade|perbaiki|fix|jadwalkan|cronjob|kirim(?:kan)?\s+.*email|request\s+too\s+large)\b/i;

export function userRequiresEmail(input: string): boolean {
  if (EMAIL_DRAFT_ONLY_RE.test(input) && !/\b(?:kirim|send)\b/i.test(input)) return false;
  return EMAIL_SEND_RE.test(input);
}

function baseResult(input: string, intent: OptimizedIntent): PromptReviewResult {
  const normalizedInput = redactSecrets(input.trim().replace(/\s+/g, ' '));
  return {
    originalInput: input,
    normalizedInput,
    intent,
    taskGoal: normalizedInput || 'Handle the user request.',
    constraints: [],
    requiredTools: [],
    excludedTools: [],
    requiredActions: [],
    riskFlags: [],
    ambiguity: { isAmbiguous: false },
  };
}

export class PromptReviewEngine {
  review(input: string): PromptReviewResult {
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (!trimmed) {
      return {
        ...baseResult(input, 'unknown'),
        taskGoal: 'Empty request.',
        riskFlags: ['empty-input'],
        ambiguity: {
          isAmbiguous: true,
          clarificationQuestion: 'Apa yang ingin kamu lakukan?',
        },
      };
    }

    const explicitSelfUpgradeSlash = /^\/(?:upgrade|self-upgrade)\b/i.test(trimmed);
    if (!explicitSelfUpgradeSlash && isInformationalCapabilityQuestion(trimmed)) {
      return {
        ...baseResult(input, 'chat'),
        routingHint: 'explain-capability',
        taskGoal: 'Explain Native OpenClaw self-improvement, self-healing, and self-upgrade capabilities without running autonomous engines.',
        constraints: [
          'Answer as normal chat.',
          'Do not run SelfUpgradeEngine or SelfHealingEngine.',
          'Do not use system-execute.',
        ],
        excludedTools: ['system-execute', 'SelfUpgradeEngine', 'SelfHealingEngine'],
        requiredActions: ['explain the mentioned capability features clearly'],
      };
    }

    if (isSimpleChatIntent(trimmed)) {
      return {
        ...baseResult(input, 'chat'),
        routingHint: 'simple-chat',
        taskGoal: redactSecrets(trimmed),
        constraints: [
          'Answer briefly and directly.',
          'Do not use tools or autonomous engines.',
          'Do not inject unrelated memory, workspace context, or skills.',
        ],
        excludedTools: ['system-execute', 'SelfUpgradeEngine', 'SelfHealingEngine'],
        requiredActions: ['answer as normal short chat'],
      };
    }

    const mcpConfigurationIntent = classifyMcpConfigurationIntent(trimmed);
    if (mcpConfigurationIntent) {
      const isRead = mcpConfigurationIntent === 'mcp-config-read';
      return {
        ...baseResult(input, mcpConfigurationIntent),
        routingHint: 'self-configuration',
        taskGoal: isRead
          ? 'Read and report the self-configured MCP servers from mcp_agent.config.yaml.'
          : 'Safely update mcp_agent.config.yaml through the MCP Agent self-configuration service.',
        constraints: [
          'Use the deterministic MCP Agent configuration service.',
          'Do not route this request to SelfHealingEngine or SelfUpgradeEngine.',
          'Do not use system-execute to edit the YAML file.',
          'Preserve existing MCP server entries.',
        ],
        requiredTools: isRead ? [] : ['mcp-agent.configure-server'],
        excludedTools: ['SelfHealingEngine', 'SelfUpgradeEngine', 'system-execute'],
        requiredActions: [
          isRead ? 'read and validate MCP YAML' : 'parse, update, write, and validate MCP YAML',
          'return a clear configuration report',
        ],
      };
    }

    if (isSelfUpgradeIntent(trimmed)) {
      return {
        ...baseResult(input, 'self-upgrade'),
        taskGoal: buildSelfUpgradeInstruction(trimmed),
        constraints: [
          'Do not answer with generic advice only.',
          'Do not use system-execute directly.',
          'Preserve existing Native OpenClaw architecture.',
        ],
        requiredTools: ['SelfUpgradeEngine'],
        excludedTools: ['system-execute'],
        requiredActions: [
          'run SelfUpgradeEngine',
          'implement token budget/context compression/tool result truncation when relevant',
          'run build and tests through the upgrade QA pipeline',
        ],
        riskFlags: /request\s+too\s+large|token|context|konteks/i.test(trimmed)
          ? ['token-budget-risk']
          : [],
      };
    }

    if (isApplicationDebugRequest(trimmed) || SELF_HEALING_RE.test(trimmed)) {
      const telegram = /telegram\s+polling|polling\s+recovered|getupdates|409/i.test(trimmed);
      return {
        ...baseResult(input, 'self-healing'),
        taskGoal: telegram
          ? 'Diagnose and fix Native OpenClaw Telegram polling log suppression.'
          : redactSecrets(trimmed),
        constraints: [
          'Analyze Native OpenClaw application/config/logging behavior first.',
          'Do not use system-execute unless the user explicitly asks to run a command.',
        ],
        requiredTools: ['SelfHealingEngine'],
        excludedTools: EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed) ? [] : ['system-execute'],
        requiredActions: telegram
          ? [
              'inspect Telegram polling error suppression',
              'respect TELEGRAM_LOG_POLLING_ERRORS and TELEGRAM_RECOVERY_LOG_ENABLED',
              'run build and tests through self-healing when enabled',
            ]
          : ['run SelfHealingEngine when enabled'],
        riskFlags: telegram ? ['telegram-log-noise'] : [],
      };
    }

    if (looksLikeSchedulerRequest(trimmed)) {
      return {
        ...baseResult(input, 'scheduler'),
        taskGoal: `Create or manage a scheduled task while preserving timing: ${redactSecrets(trimmed)}`,
        constraints: ['Preserve relative/absolute schedule text exactly.', 'Do not drop email requirements.'],
        requiredTools: ['scheduler'],
        excludedTools: EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed) ? [] : ['system-execute'],
        requiredActions: ['route to scheduler action handler'],
      };
    }

    if (userRequiresEmail(trimmed)) {
      return {
        ...baseResult(input, 'email'),
        taskGoal: `Send requested content by email: ${redactSecrets(trimmed)}`,
        constraints: [
          'Use web-fetch/search first when current information is requested.',
          'Call brevo-email before claiming the email was sent.',
          'If no explicit recipient is present, let brevo-email use the configured default recipient.',
        ],
        requiredTools: ['web-fetch', 'brevo-email'],
        excludedTools: EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed) ? [] : ['system-execute'],
        requiredActions: ['web-fetch if current data is needed', 'brevo-email', 'verify Brevo success'],
      };
    }

    if (WORKSPACE_RE.test(trimmed)) {
      return {
        ...baseResult(input, 'workspace'),
        requiredTools: ['workspace'],
        requiredActions: ['route workspace request without unnecessary external calls'],
      };
    }

    if (MCP_RE.test(trimmed)) {
      return {
        ...baseResult(input, 'mcp'),
        requiredTools: ['mcp'],
        requiredActions: ['route MCP management or MCP tool request'],
      };
    }

    if (API_RE.test(trimmed)) {
      return {
        ...baseResult(input, 'api'),
        requiredTools: ['internal-api'],
        requiredActions: ['use API tooling only when needed'],
      };
    }

    if (TOOL_RE.test(trimmed)) {
      return {
        ...baseResult(input, 'tool'),
        requiredTools: EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed) ? ['system-execute'] : ['web-fetch'],
        excludedTools: EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed) ? [] : ['system-execute'],
        requiredActions: ['use tool only if the task cannot be answered from current context'],
      };
    }

    const result = baseResult(input, 'chat');
    if (STRONG_ACTION_RE.test(lower)) {
      result.riskFlags = ['strong-action-unclassified'];
      result.ambiguity = {
        isAmbiguous: true,
        clarificationQuestion: 'Apakah ini harus dijalankan sebagai action atau cukup dijawab sebagai chat?',
      };
    }
    return result;
  }
}
