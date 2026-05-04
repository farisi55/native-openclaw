/**
 * message.ts
 * Core message schema — provider-agnostic conversation primitives.
 */

import { z } from 'zod';
import type { JsonObject } from './global';

// ─── Role ────────────────────────────────────────────────────────────────────

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

// ─── Content Parts ────────────────────────────────────────────────────────────

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().optional().default(false),
});
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

// ─── Message ─────────────────────────────────────────────────────────────────

export const MessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRoleSchema,
  /**
   * Content is either a plain string (shorthand for a single TextPart)
   * or a structured array of ContentParts.
   */
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// ─── Conversation ─────────────────────────────────────────────────────────────

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  messages: z.array(MessageSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Build a validated Message object.
 * Throws ZodError if data is invalid.
 */
export function createMessage(
  data: Omit<Message, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  }
): Message {
  return MessageSchema.parse({
    id: data.id ?? crypto.randomUUID(),
    createdAt: data.createdAt ?? new Date().toISOString(),
    ...data,
  });
}

/** Extract plain text from any message content. */
export function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Narrow content to structured parts, normalising plain strings. */
export function toContentParts(content: Message['content']): ContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

/** Cast arbitrary metadata safely. */
export function getMetadata<T extends JsonObject>(
  msg: Message,
  key: string
): T | undefined {
  return msg.metadata?.[key] as T | undefined;
}
