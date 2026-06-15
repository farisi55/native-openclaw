function extractNpmPackage(message: string): string | undefined {
  return /(?:404\b[\s\S]*?|not\s+found[\s\S]*?)(@[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)@\*|npm\s+view\s+([^\s]+)/i
    .exec(message)
    ?.slice(1)
    .find(Boolean);
}

export function normalizeMcpStartError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/npm(?:\s+error)?\s+(?:code\s+)?E404|\b404\s+Not\s+Found|is not in this registry/i.test(message)) {
    const packageName = extractNpmPackage(message);
    return new Error([
      'MCP server failed to start because the npm package was not found.',
      packageName ? `Package: ${packageName}` : '',
      'This package does not appear to exist in the npm registry.',
      'Suggested actions:',
      '- verify the package name',
      '- use a known MCP server package',
      '- for smoke testing, use @modelcontextprotocol/server-everything',
    ].filter(Boolean).join('\n'));
  }

  if (/\bEACCES\b[\s\S]*(?:\.npm|npm\s+cache)|npm\s+cache[\s\S]*not\s+writable/i.test(message)) {
    return new Error([
      'MCP server failed because npm cache is not writable.',
      'Run:',
      "docker compose exec -u root openclaw sh -lc 'chown -R 100:101 /home/openclaw/.npm'",
      'Permanent fix: ensure Dockerfile/entrypoint creates and owns /home/openclaw/.npm.',
    ].join('\n'));
  }

  if (/MCP request timed out:\s*initialize|MCP initialize timed out/i.test(message)) {
    return new Error([
      'MCP initialize timed out.',
      'Possible causes:',
      '- npx cold install is still running',
      '- npm proxy/registry is slow',
      '- server command started but did not speak MCP stdio',
      '- command wrote non-protocol output to stdout',
      'Suggested action: preinstall the MCP server and use an absolute binary path or node path.',
    ].join('\n'));
  }

  return error instanceof Error ? error : new Error(message);
}
