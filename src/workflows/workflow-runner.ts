import { writeFile } from 'fs/promises';
import { WorkspaceManager } from '../workspace';
import { sendBrevoEmail } from '../tools/brevo-email';
import type {
  WorkflowDefinition,
  WorkflowExecutionPlan,
  WorkflowPlanStep,
  WorkflowRunnerDeps,
  WorkflowRunResult,
  WorkflowToolCapability,
  WorkflowToolResult,
} from './workflow-types';
import { loadWorkflowMarkdown } from './workflow-loader';
import { parseWorkflowMarkdown, validateWorkflowDefinition } from './workflow-parser';
import { buildWorkflowPlanningPrompt } from './workflow-prompts';
import {
  buildWorkflowFinalSummary,
  buildWorkflowHtmlReport,
  createTrendPng,
  extractNumericSeries,
  extractUrls,
  slugify,
  truncate,
} from './workflow-report';
import { createMessage, extractText } from '../types/message';

const WORKFLOW_RUN_RE = /jalankan\s+(?:autonomous\s+)?workflow|run\s+workflow|execute\s+workflow|jalankan\s+workflow\.md|buat\s+laporan\s+berdasarkan\s+workflow\.md|gunakan\s+workflow\s+yang\s+ada\s+di\s+workspace/i;

export function isWorkflowRunRequest(input: string): boolean {
  return WORKFLOW_RUN_RE.test(input);
}

function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dateTimeKey(now: Date): string {
  return now.toISOString();
}

function replaceDateTemplates(value: string | undefined, date: string): string | undefined {
  return value?.replace(/\{\{date\}\}/g, date);
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const raw = item as Record<string, unknown>;
          if (typeof raw['text'] === 'string') return raw['text'];
          return JSON.stringify(raw);
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return JSON.stringify(result, null, 2);
}

function hasCapability(tool: WorkflowToolCapability, capability: WorkflowToolCapability['capabilities'][number]): boolean {
  return tool.capabilities.includes(capability);
}

function chooseTool(
  tools: WorkflowToolCapability[],
  capability: WorkflowToolCapability['capabilities'][number],
  preferredServer?: RegExp
): WorkflowToolCapability | undefined {
  const candidates = tools.filter((tool) => hasCapability(tool, capability));
  if (preferredServer) {
    const preferred = candidates.find((tool) => preferredServer.test(tool.server ?? tool.name));
    if (preferred) return preferred;
  }
  return candidates[0];
}

function detectCapabilities(source: 'mcp' | 'native', server: string | undefined, name: string, description: string): WorkflowToolCapability['capabilities'] {
  const haystack = `${server ?? ''} ${name} ${description}`.toLowerCase();
  const capabilities: WorkflowToolCapability['capabilities'] = [];

  if (/tavily|search|web-fetch|browse|news|query/.test(haystack)) capabilities.push('search');
  if (/firecrawl|scrape|crawl|fetch|web-fetch|url|page/.test(haystack)) capabilities.push('scrape');
  if (/e2b|code|python|execute|run_code|analysis|analy/.test(haystack)) capabilities.push('analyze');
  if (/e2b|chart|plot|python|image|graph/.test(haystack)) capabilities.push('chart');
  if (/brevo|email|mail|smtp|send/.test(haystack)) capabilities.push('email');
  if (/workspace|write|artifact|report/.test(haystack)) capabilities.push('workspace_write');

  if (source === 'native' && name === 'brevo-email' && !capabilities.includes('email')) capabilities.push('email');
  if (source === 'native' && name === 'web-fetch' && !capabilities.includes('search')) capabilities.push('search');

  return [...new Set(capabilities)];
}

async function startRequestedMcpServers(workflow: WorkflowDefinition, deps: WorkflowRunnerDeps, errors: string[], missing: string[]): Promise<void> {
  if (!deps.mcpManager) return;

  const servers = await deps.mcpManager.listServers();
  const configured = new Set(servers.map((server) => server.name));
  const requested = workflow.toolsToUse
    .map((line) => line.split(':')[0]?.trim().toLowerCase())
    .filter((name): name is string => Boolean(name));

  for (const name of requested) {
    if (['native', 'workspace', 'web-fetch'].includes(name)) continue;
    if (!configured.has(name)) {
      missing.push(`Missing MCP server "${name}". Add it with: /mcp add ${name}`);
      continue;
    }
    try {
      if (deps.mcpManager.listTools(name).length === 0) {
        await deps.mcpManager.startServer(name);
      }
    } catch (err) {
      errors.push(`Could not start MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function discoverTools(deps: WorkflowRunnerDeps): WorkflowToolCapability[] {
  const tools: WorkflowToolCapability[] = [];

  for (const tool of deps.mcpManager?.listTools() ?? []) {
    const description = tool.description ?? '';
    const capabilities = detectCapabilities('mcp', tool.server, tool.name, description);
    tools.push({
      name: tool.name,
      source: 'mcp',
      server: tool.server,
      toolName: tool.name,
      runtimeName: tool.runtimeName,
      description,
      capabilities,
    });
  }

  for (const native of deps.toolRegistry.listTools()) {
    const capabilities = detectCapabilities('native', undefined, native.manifest.name, native.manifest.description);
    if (capabilities.length === 0) continue;
    tools.push({
      name: native.manifest.name,
      source: 'native',
      runtimeName: native.manifest.name,
      description: native.manifest.description,
      capabilities,
    });
  }

  return tools;
}

function extractJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizePlanStep(step: unknown, index: number, tools: WorkflowToolCapability[]): WorkflowPlanStep | null {
  if (!step || typeof step !== 'object') return null;
  const raw = step as Record<string, unknown>;
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';
  if (!['search', 'scrape', 'analyze', 'chart', 'report', 'email', 'workspace_write'].includes(type)) return null;
  const tool = typeof raw['tool'] === 'string' && tools.some((candidate) => candidate.runtimeName === raw['tool'])
    ? raw['tool']
    : null;

  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : `step-${index + 1}`,
    type: type as WorkflowPlanStep['type'],
    tool,
    goal: typeof raw['goal'] === 'string' ? raw['goal'] : `${type} workflow step`,
    input: raw['input'] && typeof raw['input'] === 'object' && !Array.isArray(raw['input'])
      ? raw['input'] as Record<string, unknown>
      : {},
  };
}

async function planWithLlm(workflow: WorkflowDefinition, tools: WorkflowToolCapability[], deps: WorkflowRunnerDeps): Promise<WorkflowExecutionPlan | null> {
  if (!deps.provider || !deps.model) return null;

  try {
    const response = await deps.provider.chat({
      model: deps.model,
      temperature: 0,
      maxTokens: 1600,
      systemPrompt: 'You produce strict JSON only. Do not include markdown.',
      messages: [
        createMessage({
          role: 'user',
          content: buildWorkflowPlanningPrompt(workflow, tools),
        }),
      ],
    });
    const parsed = extractJsonObject(extractText(response.message.content));
    if (!parsed || typeof parsed !== 'object') return null;
    const raw = parsed as Record<string, unknown>;
    const steps = Array.isArray(raw['steps'])
      ? raw['steps'].map((step, index) => normalizePlanStep(step, index, tools)).filter((step): step is WorkflowPlanStep => Boolean(step))
      : [];
    if (steps.length === 0) return null;
    return {
      title: typeof raw['title'] === 'string' ? raw['title'] : workflow.title,
      topic: typeof raw['topic'] === 'string' ? raw['topic'] : workflow.topic,
      steps,
      requiresEmail: raw['requiresEmail'] === true || workflow.email.sendEmail,
      requiresChart: raw['requiresChart'] === true || workflow.analysisRequirements.some((item) => /chart|grafik|plot/i.test(item)),
      missingTools: Array.isArray(raw['missingTools']) ? raw['missingTools'].filter((item): item is string => typeof item === 'string') : [],
    };
  } catch {
    return null;
  }
}

function buildHeuristicPlan(workflow: WorkflowDefinition, tools: WorkflowToolCapability[]): WorkflowExecutionPlan {
  const steps: WorkflowPlanStep[] = [];
  const missingTools: string[] = [];
  const searchTool = chooseTool(tools, 'search', /tavily/i);
  const scrapeTool = chooseTool(tools, 'scrape', /firecrawl/i);
  const analyzeTool = chooseTool(tools, 'analyze', /e2b/i);
  const chartTool = chooseTool(tools, 'chart', /e2b/i);
  const emailTool = chooseTool(tools, 'email', /brevo/i);
  const requiresChart = [...workflow.analysisRequirements, ...workflow.outputRequirements].some((item) => /chart|grafik|plot/i.test(item));

  if (!searchTool) missingTools.push('Search capability missing. Add MCP Tavily with: /mcp add tavily or enable web-fetch.');
  workflow.dataRequirements.forEach((requirement, index) => {
    steps.push({
      id: `search-${index + 1}`,
      type: 'search',
      tool: searchTool?.runtimeName ?? null,
      goal: requirement,
      input: {
        query: `${workflow.topic}: ${requirement}`,
      },
    });
  });

  if (scrapeTool && workflow.dataRequirements.some((requirement) => /scrape|crawl|detail|extract|page|halaman/i.test(requirement))) {
    steps.push({
      id: 'scrape-1',
      type: 'scrape',
      tool: scrapeTool.runtimeName,
      goal: `Collect detailed page data for ${workflow.topic}`,
      input: {
        query: workflow.topic,
      },
    });
  }

  steps.push({
    id: 'analyze-1',
    type: 'analyze',
    tool: analyzeTool?.runtimeName ?? null,
    goal: workflow.analysisRequirements.join('; ') || `Analyze ${workflow.topic}`,
    input: {},
  });
  if (!analyzeTool) missingTools.push('Code execution analysis missing. Add MCP E2B with: /mcp add e2b. Runner will use LLM/local summary fallback.');

  if (requiresChart) {
    steps.push({
      id: 'chart-1',
      type: 'chart',
      tool: chartTool?.runtimeName ?? null,
      goal: `Generate chart for ${workflow.topic}`,
      input: {},
    });
    if (!chartTool) missingTools.push('Chart generation via E2B missing. Add MCP E2B with: /mcp add e2b.');
  }

  steps.push({
    id: 'report-1',
    type: 'report',
    tool: null,
    goal: 'Generate professional HTML report and raw JSON data.',
    input: {},
  });

  if (workflow.email.sendEmail) {
    steps.push({
      id: 'email-1',
      type: 'email',
      tool: emailTool?.runtimeName ?? null,
      goal: 'Send final HTML email if configured.',
      input: {},
    });
    if (!emailTool) missingTools.push('Brevo email capability missing. Add MCP Brevo with: /mcp add brevo or enable brevo-email.');
  }

  return {
    title: workflow.title,
    topic: workflow.topic,
    steps,
    requiresEmail: workflow.email.sendEmail,
    requiresChart,
    missingTools,
  };
}

async function buildPlan(workflow: WorkflowDefinition, tools: WorkflowToolCapability[], deps: WorkflowRunnerDeps): Promise<WorkflowExecutionPlan> {
  return (await planWithLlm(workflow, tools, deps)) ?? buildHeuristicPlan(workflow, tools);
}

function capabilityForStep(type: WorkflowPlanStep['type']): WorkflowToolCapability['capabilities'][number] | null {
  if (type === 'search') return 'search';
  if (type === 'scrape') return 'scrape';
  if (type === 'analyze') return 'analyze';
  if (type === 'chart') return 'chart';
  if (type === 'email') return 'email';
  if (type === 'workspace_write') return 'workspace_write';
  return null;
}

function findToolForStep(step: WorkflowPlanStep, tools: WorkflowToolCapability[]): WorkflowToolCapability | undefined {
  if (step.tool) {
    const exact = tools.find((tool) => tool.runtimeName === step.tool);
    if (exact) return exact;
  }
  const capability = capabilityForStep(step.type);
  return capability ? chooseTool(tools, capability, step.type === 'email' ? /brevo/i : undefined) : undefined;
}

async function runTool(tool: WorkflowToolCapability, input: Record<string, unknown>, deps: WorkflowRunnerDeps): Promise<string> {
  if (tool.source === 'mcp' && deps.mcpManager && tool.server && tool.toolName) {
    return stringifyToolResult(await deps.mcpManager.callTool(tool.server, tool.toolName, input));
  }

  const native = deps.toolRegistry.getTool(tool.runtimeName);
  if (!native) throw new Error(`Native tool "${tool.runtimeName}" is not available.`);
  return native.run(input);
}

async function executeCollectionStep(step: WorkflowPlanStep, tool: WorkflowToolCapability | undefined, deps: WorkflowRunnerDeps): Promise<WorkflowToolResult> {
  if (!tool) {
    return {
      stepId: step.id,
      type: step.type,
      tool: null,
      goal: step.goal,
      ok: false,
      output: '',
      sources: [],
      error: `No available tool for ${step.type}.`,
    };
  }

  try {
    const query = typeof step.input['query'] === 'string' ? step.input['query'] : step.goal;
    const output = await runTool(tool, { query, url: step.input['url'], max_results: 5, maxResults: 5 }, deps);
    return {
      stepId: step.id,
      type: step.type,
      tool: tool.runtimeName,
      goal: step.goal,
      ok: true,
      output,
      sources: extractUrls(output),
    };
  } catch (err) {
    return {
      stepId: step.id,
      type: step.type,
      tool: tool.runtimeName,
      goal: step.goal,
      ok: false,
      output: '',
      sources: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeAnalysis(step: WorkflowPlanStep, tool: WorkflowToolCapability | undefined, workflow: WorkflowDefinition, collected: WorkflowToolResult[], deps: WorkflowRunnerDeps): Promise<WorkflowToolResult> {
  const context = collected.map((result) => `${result.goal}\n${truncate(result.output, 1600)}`).join('\n\n');

  if (tool) {
    try {
      const code = [
        'print("Workflow topic:", ' + JSON.stringify(workflow.topic) + ')',
        'print("Data sample:")',
        'print(' + JSON.stringify(truncate(context, 4000)) + ')',
        'print("Analysis should identify key data points, sentiment, trend, and recommendation.")',
      ].join('\n');
      const output = await runTool(tool, { code, language: 'python', confirm: true }, deps);
      return {
        stepId: step.id,
        type: step.type,
        tool: tool.runtimeName,
        goal: step.goal,
        ok: true,
        output,
        sources: extractUrls(output),
      };
    } catch (err) {
      return {
        stepId: step.id,
        type: step.type,
        tool: tool.runtimeName,
        goal: step.goal,
        ok: false,
        output: '',
        sources: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (deps.provider && deps.model) {
    try {
      const response = await deps.provider.chat({
        model: deps.model,
        temperature: 0.2,
        maxTokens: 1200,
        systemPrompt: 'You are an autonomous workflow analyst. Do not fabricate missing data. Cite limitations.',
        messages: [
          createMessage({
            role: 'user',
            content: [
              `Role: ${workflow.role}`,
              `Topic: ${workflow.topic}`,
              `Analysis requirements: ${workflow.analysisRequirements.join('; ')}`,
              'Collected data:',
              context || '(no collected data)',
              '',
              'Write concise analysis, projection/recommendation, and limitations.',
            ].join('\n'),
          }),
        ],
      });
      return {
        stepId: step.id,
        type: step.type,
        tool: null,
        goal: step.goal,
        ok: true,
        output: String(response.message.content),
        sources: [],
      };
    } catch (err) {
      return {
        stepId: step.id,
        type: step.type,
        tool: null,
        goal: step.goal,
        ok: false,
        output: '',
        sources: [],
        error: `LLM fallback analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    stepId: step.id,
    type: step.type,
    tool: null,
    goal: step.goal,
    ok: true,
    output: [
      `Topic: ${workflow.topic}`,
      'Analysis fallback:',
      context ? truncate(context, 2200) : 'No collected data was available. Report limitations clearly.',
    ].join('\n'),
    sources: extractUrls(context),
  };
}

async function executeEmail(args: {
  step: WorkflowPlanStep;
  tool: WorkflowToolCapability | undefined;
  workflow: WorkflowDefinition;
  html: string;
  date: string;
  deps: WorkflowRunnerDeps;
}): Promise<WorkflowRunResult['emailStatus']> {
  if (!args.workflow.email.sendEmail) {
    return {
      attempted: false,
      sent: false,
      method: 'skipped',
      detail: 'sendEmail is false in WORKFLOW.md.',
    };
  }

  const subject = replaceDateTemplates(args.workflow.email.subject, args.date) ?? `${args.workflow.title} - ${args.date}`;
  const recipient = args.workflow.email.recipient || process.env['BREVO_RECIPIENT_EMAIL'];
  const sender = args.workflow.email.sender || process.env['BREVO_SENDER_EMAIL'];

  if (args.tool?.source === 'mcp' && args.deps.mcpManager && args.tool.server && args.tool.toolName) {
    try {
      const output = stringifyToolResult(await args.deps.mcpManager.callTool(args.tool.server, args.tool.toolName, {
        subject,
        htmlContent: args.html,
        recipientEmail: recipient,
        senderEmail: sender,
        senderName: process.env['BREVO_SENDER_NAME'] ?? 'Native OpenClaw',
        recipientName: process.env['BREVO_RECIPIENT_NAME'],
      }));
      return {
        attempted: true,
        sent: !/error|failed|not sent|gagal/i.test(output),
        method: 'mcp-brevo',
        detail: output,
      };
    } catch (err) {
      return {
        attempted: true,
        sent: false,
        method: 'mcp-brevo',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const result = await sendBrevoEmail({
    subject,
    htmlContent: args.html,
    recipientEmail: recipient,
    senderEmail: sender,
    senderName: process.env['BREVO_SENDER_NAME'] ?? 'Native OpenClaw',
    recipientName: process.env['BREVO_RECIPIENT_NAME'],
  });

  return {
    attempted: true,
    sent: result.ok,
    method: 'internal-brevo',
    detail: result.content,
  };
}

export async function runWorkflowFromDefinition(
  workflow: WorkflowDefinition,
  deps: WorkflowRunnerDeps
): Promise<WorkflowRunResult> {
  const workspace = deps.workspace ?? new WorkspaceManager();
  const now = deps.now ?? new Date();
  const date = dateKey(now);
  const errors = validateWorkflowDefinition(workflow);
  const missingCapabilities: string[] = [];

  await workspace.ensureWorkspace();
  await workspace.mkdir('reports');
  await startRequestedMcpServers(workflow, deps, errors, missingCapabilities);

  const tools = discoverTools(deps);
  const plan = await buildPlan(workflow, tools, deps);
  missingCapabilities.push(...plan.missingTools);

  const results: WorkflowToolResult[] = [];
  let analysisText = '';
  let html = '';
  let chartPath: string | null = null;
  const generatedFiles = [];
  const slug = slugify(workflow.title || workflow.topic);
  const htmlPath = `reports/${slug}-${date}.html`;
  const jsonPath = `reports/${slug}-${date}.json`;
  const chartFile = `reports/${slug}-chart.png`;

  for (const step of plan.steps) {
    const tool = findToolForStep(step, tools);

    if (step.type === 'search' || step.type === 'scrape') {
      const result = await executeCollectionStep(step, tool, deps);
      results.push(result);
      if (result.error) errors.push(`${step.id}: ${result.error}`);
      continue;
    }

    if (step.type === 'analyze') {
      const result = await executeAnalysis(step, tool, workflow, results, deps);
      results.push(result);
      if (result.ok) analysisText = result.output;
      if (result.error) errors.push(`${step.id}: ${result.error}`);
      continue;
    }

    if (step.type === 'chart') {
      if (!tool) {
        errors.push(`${step.id}: chart skipped because E2B/chart tool is unavailable.`);
        continue;
      }
      const series = extractNumericSeries(results.map((result) => result.output).join('\n'));
      if (series.length < 2) {
        errors.push(`${step.id}: chart skipped because numeric historical data was incomplete.`);
        continue;
      }
      await writeFile(workspace.resolvePath(chartFile), createTrendPng(series));
      chartPath = chartFile;
      generatedFiles.push({ path: chartFile, type: 'png' as const });
      results.push({
        stepId: step.id,
        type: step.type,
        tool: tool.runtimeName,
        goal: step.goal,
        ok: true,
        output: `Chart generated from ${series.length} numeric observations.`,
        sources: [],
      });
      continue;
    }
  }

  if (!analysisText) {
    analysisText = results.length > 0
      ? `Collected ${results.filter((result) => result.ok).length} successful result(s). Review key data points and limitations.`
      : 'No data collection succeeded. The workflow report is limited to execution diagnostics.';
  }

  html = buildWorkflowHtmlReport({
    workflow,
    date: dateTimeKey(now),
    results,
    analysisText,
    chartPath,
    generatedFiles,
    errors,
    missingCapabilities,
  });
  await workspace.write(htmlPath, html);
  generatedFiles.push({ path: htmlPath, type: 'html' as const });

  const emailStep = plan.steps.find((step) => step.type === 'email');
  const emailStatus = await executeEmail({
    step: emailStep ?? { id: 'email-1', type: 'email', tool: null, goal: 'Send report email', input: {} },
    tool: emailStep ? findToolForStep(emailStep, tools) : undefined,
    workflow,
    html,
    date,
    deps,
  });
  if (workflow.email.sendEmail && !emailStatus.sent) {
    missingCapabilities.push(`Email not sent: ${emailStatus.detail}`);
  }

  const sources = [...new Set(results.flatMap((result) => result.sources))];
  const rawData = {
    workflow: {
      title: workflow.title,
      topic: workflow.topic,
      role: workflow.role,
      objective: workflow.objective,
    },
    plan,
    toolResults: results,
    sources,
    errors,
    missingCapabilities,
    generatedFiles,
    emailStatus,
  };
  await workspace.write(jsonPath, JSON.stringify(rawData, null, 2));
  generatedFiles.push({ path: jsonPath, type: 'json' as const });

  const toolsUsed = [...new Set(results.map((result) => result.tool).filter((tool): tool is string => Boolean(tool)))];
  const runResult: WorkflowRunResult = {
    content: '',
    title: workflow.title,
    topic: workflow.topic,
    plan,
    toolsUsed,
    sources,
    generatedFiles,
    emailStatus,
    errors,
    missingCapabilities: [...new Set(missingCapabilities)],
    rawResults: results,
  };
  runResult.content = buildWorkflowFinalSummary(runResult);
  return runResult;
}

export async function runWorkflowFromWorkspace(deps: WorkflowRunnerDeps): Promise<WorkflowRunResult> {
  const workspace = deps.workspace ?? new WorkspaceManager();
  const loaded = await loadWorkflowMarkdown(workspace);
  const workflow = parseWorkflowMarkdown(loaded.markdown);
  const result = await runWorkflowFromDefinition(workflow, { ...deps, workspace });
  if (loaded.created) {
    result.missingCapabilities.unshift(`WORKFLOW.md was created from the default template at ${loaded.path}. Edit it to customize the workflow topic and requirements.`);
    result.content = buildWorkflowFinalSummary(result);
  }
  return result;
}
