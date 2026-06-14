export function providerEnvPrefix(providerId: string): string {
  return providerId
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function providerDefaultModelFromEnv(providerId: string): string | undefined {
  const value = process.env[`${providerEnvPrefix(providerId)}_DEFAULT_MODEL`]?.trim();
  return value || undefined;
}

export function parseProviderModels(value: string | undefined, defaultModel: string): string[] {
  const models = (value ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return [...new Set([defaultModel, ...models])];
}
