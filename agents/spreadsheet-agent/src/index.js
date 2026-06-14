import { createServer } from 'node:http';

const port = Number.parseInt(process.env.SPREADSHEET_AGENT_PORT || '3103', 10);
const apiKey = (process.env.SPREADSHEET_AGENT_API_KEY || '').trim();
const googleCredentials = (
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.SPREADSHEET_GOOGLE_CREDENTIALS_JSON ||
  ''
).trim();
const mcpUrl = (process.env.SPREADSHEET_MCP_URL || '').trim();
const maxBodyBytes = 64 * 1024;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'spreadsheet-agent',
      authConfigured: Boolean(googleCredentials || mcpUrl),
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/agent/run') {
    sendJson(response, 404, { ok: false, summary: 'Route not found.' });
    return;
  }
  if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`) {
    sendJson(response, 401, {
      ok: false,
      summary: 'Spreadsheet agent authentication failed.',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid spreadsheet agent API key.',
      },
    });
    return;
  }

  try {
    const input = await readJson(request);
    if (
      !input ||
      ![
        'spreadsheet.read',
        'spreadsheet.write',
        'spreadsheet.report',
      ].includes(input.capability)
    ) {
      sendJson(response, 400, {
        ok: false,
        summary: 'Unsupported spreadsheet capability.',
        error: {
          code: 'UNSUPPORTED_CAPABILITY',
          message:
            'Spreadsheet agent accepts spreadsheet.read, spreadsheet.write, or spreadsheet.report.',
        },
      });
      return;
    }
    if (!googleCredentials && !mcpUrl) {
      sendJson(response, 503, {
        ok: false,
        agentId: 'spreadsheet-agent',
        capability: input.capability,
        summary: 'Spreadsheet authentication is not configured.',
        error: {
          code: 'SPREADSHEET_AUTH_NOT_CONFIGURED',
          message:
            'Spreadsheet agent requires Google credentials or MCP Google Sheets configuration.',
        },
      });
      return;
    }
    sendJson(response, 501, {
      ok: false,
      agentId: 'spreadsheet-agent',
      capability: input.capability,
      summary: 'Spreadsheet backend adapter is not implemented.',
      error: {
        code: 'SPREADSHEET_BACKEND_NOT_IMPLEMENTED',
        message:
          'Connect Google Sheets or an MCP adapter in the optional worker image.',
      },
    });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'REQUEST_TOO_LARGE';
    sendJson(response, tooLarge ? 413 : 400, {
      ok: false,
      summary: tooLarge ? 'Request body is too large.' : 'Invalid JSON request.',
      error: {
        code: tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST',
        message: tooLarge ? 'Request body exceeds 64KB.' : 'Invalid JSON request.',
      },
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`spreadsheet-agent listening on 0.0.0.0:${port}\n`);
});
