import type { WorkflowDefinition, WorkflowEmailConfig } from './workflow-types';

const REQUIRED_SECTIONS = ['Topic', 'Data Requirements', 'Analysis Requirements', 'Output Requirements'];

function sectionTitle(line: string): string | null {
  const match = /^##\s+(.+?)\s*$/.exec(line.trim());
  return match?.[1]?.trim() ?? null;
}

function parseTitle(markdown: string): string {
  const match = /^#\s+Workflow:\s*(.+)$/im.exec(markdown) ?? /^#\s+(.+)$/im.exec(markdown);
  return match?.[1]?.trim() || 'Autonomous Workflow';
}

function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const title = sectionTitle(line);
    if (title) {
      if (current) sections.set(current, lines.join('\n').trim());
      current = title;
      lines = [];
    } else if (current) {
      lines.push(line);
    }
  }

  if (current) sections.set(current, lines.join('\n').trim());
  return sections;
}

function section(sections: Map<string, string>, title: string): string {
  return sections.get(title)?.trim() ?? '';
}

function bulletList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function replaceEnvTemplates(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] ?? '');
}

function parseEmail(text: string): WorkflowEmailConfig {
  const config: WorkflowEmailConfig = { sendEmail: false };

  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    const key = match[1].toLowerCase();
    const raw = replaceEnvTemplates(match[2].trim().replace(/^["']|["']$/g, ''));

    if (key === 'sendemail') config.sendEmail = ['true', '1', 'yes', 'ya'].includes(raw.toLowerCase());
    if (key === 'subject') config.subject = raw;
    if (key === 'recipient') config.recipient = raw;
    if (key === 'sender') config.sender = raw;
  }

  return config;
}

export function parseWorkflowMarkdown(markdown: string): WorkflowDefinition {
  const sections = splitSections(markdown);

  return {
    title: parseTitle(markdown),
    role: section(sections, 'Role'),
    objective: section(sections, 'Objective'),
    topic: section(sections, 'Topic'),
    dataRequirements: bulletList(section(sections, 'Data Requirements')),
    toolsToUse: bulletList(section(sections, 'Tools To Use')),
    analysisRequirements: bulletList(section(sections, 'Analysis Requirements')),
    outputRequirements: bulletList(section(sections, 'Output Requirements')),
    email: parseEmail(section(sections, 'Email')),
    safetyRules: bulletList(section(sections, 'Safety Rules')),
    rawMarkdown: markdown,
  };
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  if (!workflow.title.trim()) errors.push('Missing workflow title.');
  if (!workflow.topic.trim()) errors.push('Missing required section: Topic.');
  if (workflow.dataRequirements.length === 0) errors.push('Missing required section: Data Requirements.');
  if (workflow.analysisRequirements.length === 0) errors.push('Missing required section: Analysis Requirements.');
  if (workflow.outputRequirements.length === 0) errors.push('Missing required section: Output Requirements.');
  return errors;
}

export function workflowSummary(workflow: WorkflowDefinition): string {
  return [
    `Title: ${workflow.title}`,
    `Topic: ${workflow.topic || '(missing)'}`,
    `Role: ${workflow.role || '(not specified)'}`,
    `Data requirements: ${workflow.dataRequirements.length}`,
    `Analysis requirements: ${workflow.analysisRequirements.length}`,
    `Output requirements: ${workflow.outputRequirements.length}`,
    `Email: ${workflow.email.sendEmail ? 'enabled' : 'disabled'}`,
    '',
    `Required sections: ${REQUIRED_SECTIONS.join(', ')}`,
  ].join('\n');
}
