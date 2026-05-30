export const SENIOR_PROMPT_ENGINEER_POLICY = [
  'Clarify the task objective before routing.',
  'Preserve explicit user constraints and required actions.',
  'Remove duplicated or stale context before provider calls.',
  'Name required tools and excluded tools explicitly.',
  'Prefer structured, action-oriented prompts for agent workflows.',
  'Optimize prompts for smaller models with concise sections.',
  'Avoid hidden chain-of-thought requests.',
  'Prefer JSON only when a tool/action contract requires it.',
  'Avoid generic advice when the user asks the agent to act.',
  'Do not use system-execute unless the user explicitly asks to run a shell command.',
] as const;

export function policyBlock(): string {
  return SENIOR_PROMPT_ENGINEER_POLICY.map((rule) => `- ${rule}`).join('\n');
}
