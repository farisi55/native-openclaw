/**
 * skills/skill-extractor.ts
 * Uses LLM to extract a reusable skill from a completed interaction.
 */

import type { IProvider } from '../types/provider';
import { createMessage, extractText } from '../types/message';
import { getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:extractor');

const EXTRACTION_SYSTEM_PROMPT = `You are a skill extraction engine. Analyze the completed agent interaction and determine if it represents a reusable workflow or procedure.

If YES, respond with ONLY valid JSON (no markdown fences, no explanation):
{
  "shouldExtract": true,
  "name": "<concise skill name, max 50 chars>",
  "description": "<one sentence describing when to use this skill, max 120 chars>",
  "tags": ["<tag1>", "<tag2>"],
  "body": "<markdown body: step-by-step procedure the agent should follow, max 800 chars>"
}

If the interaction is NOT worth extracting (simple Q&A, single-step, no reusable pattern), respond ONLY with:
{ "shouldExtract": false }

Extraction criteria - extract ONLY if ALL are true:
- The task required more than one reasoning step OR used at least one tool
- The workflow could be reused for similar future tasks
- The skill adds value beyond what the agent already knows from training

Special focus: If the user used an unusual or informal phrase to trigger a scheduled task (for example, "nanti kamu kirim ya", "bangunkan saya", "balas email nanti"), extract a skill that documents this phrase pattern so the agent can recognize it in future sessions.`;

const SCHEDULER_PHRASE_EXTRACTION_PROMPT = `You are a scheduler phrase learning engine for an AI agent.

The user just successfully created a scheduled task using an informal or unusual phrase.
Extract this phrase pattern as a reusable skill so the agent can recognize it in future sessions.

Respond with ONLY valid JSON (no markdown fences, no explanation):
{
  "shouldExtract": true,
  "name": "<concise skill name, max 50 chars>",
  "description": "<one sentence: describe the phrase pattern and what it means, max 120 chars>",
  "tags": ["scheduler", "phrase-pattern"],
  "body": "<markdown: explain the phrase pattern and how to handle it. Include: 1) The trigger phrase, 2) What it means (create a scheduled task), 3) How to parse the timing, 4) Example variations>"
}

Only respond with { "shouldExtract": false } if the user used an already-standard phrase like "jadwalkan", "kirimkan saya", "ingatkan saya", or "schedule".
Always extract for informal phrases like "nanti kamu kirim ya", "bangunkan saya", "balas nanti", "kabari saya", "follow up besok", etc.`;

export interface SkillExtractionInput {
  userInput: string;
  agentResponse: string;
  toolsUsed: string[];
  stepCount: number;
  sessionId: string;
  wasSchedulerAction?: boolean;
}

export interface ExtractedSkill {
  name: string;
  description: string;
  tags: string[];
  body: string;
}

function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export class SkillExtractor {
  private model: string | null = null;

  constructor(private readonly provider: IProvider) {}

  private async resolveModel(): Promise<string> {
    if (this.model) return this.model;
    const configured = getOptionalEnv('SELF_IMPROVING_MODEL');
    if (configured?.trim()) {
      this.model = configured.trim();
      return this.model;
    }
    const models = await this.provider.listModels();
    this.model = models[0]?.id ?? 'default';
    return this.model;
  }

  async extract(input: SkillExtractionInput): Promise<ExtractedSkill | null> {
    const isComplex = input.toolsUsed.length > 0 || input.stepCount > 1;
    const isSchedulerAction = input.wasSchedulerAction === true;
    if (!isComplex && !isSchedulerAction) {
      logger.debug('skipping extraction: interaction too simple', {
        sessionId: input.sessionId,
        toolsUsed: input.toolsUsed.length,
        stepCount: input.stepCount,
      });
      return null;
    }

    try {
      const model = await this.resolveModel();
      const response = await this.provider.chat({
        model,
        systemPrompt: isSchedulerAction ? SCHEDULER_PHRASE_EXTRACTION_PROMPT : EXTRACTION_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 512,
        messages: [
          createMessage({
            role: 'user',
            content: [
              `User input:\n${input.userInput}`,
              `Agent response:\n${input.agentResponse}`,
              `Tools used: ${input.toolsUsed.join(', ') || 'none'}`,
              `Step count: ${input.stepCount}`,
              `Session id: ${input.sessionId}`,
            ].join('\n\n'),
          }),
        ],
      });

      const parsed = JSON.parse(stripMarkdownFences(extractText(response.message.content))) as unknown;
      if (!isRecord(parsed) || parsed['shouldExtract'] !== true) return null;

      const name = boundedString(parsed['name'], 50);
      const description = boundedString(parsed['description'], 120);
      const body = boundedString(parsed['body'], 800);
      const tagsRaw = parsed['tags'];
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 8)
        : [];

      if (!name || !description || !body) return null;
      return { name, description, tags, body };
    } catch (err) {
      logger.debug('skill extraction skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
