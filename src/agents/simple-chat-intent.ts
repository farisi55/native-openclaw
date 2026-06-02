const SIMPLE_CHAT_PATTERNS: RegExp[] = [
  /^(?:halo|hai|hi|hello|hey|ping|test|apa\s+kabar)\s*[.!?]*$/i,
  /^(?:halo|hai|hi|hello|hey)\s+(?:kamu\s+siapa|siapa\s+kamu)\s*[.!?]*$/i,
  /^(?:kamu\s+siapa|siapa\s+kamu|who\s+are\s+you)\s*[.!?]*$/i,
  /^(?:siapa\s+saya|who\s+am\s+i)\s*[.!?]*$/i,
];

export function isSimpleChatIntent(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 60) return false;
  return SIMPLE_CHAT_PATTERNS.some((pattern) => pattern.test(trimmed));
}
