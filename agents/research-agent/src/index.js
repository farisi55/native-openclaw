import { createServer } from 'node:http';

const port = Number.parseInt(process.env.RESEARCH_AGENT_PORT || '3102', 10);
const apiKey = (process.env.RESEARCH_AGENT_API_KEY || '').trim();
const backendUrl = (process.env.RESEARCH_AGENT_BACKEND_URL || '').trim();
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
      service: 'research-agent',
      backendConfigured: Boolean(backendUrl),
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
      summary: 'Research agent authentication failed.',
      error: { code: 'UNAUTHORIZED', message: 'Invalid research agent API key.' },
    });
    return;
  }

  try {
    const input = await readJson(request);
    if (!input || !['research.web', 'research.market'].includes(input.capability)) {
      sendJson(response, 400, {
        ok: false,
        summary: 'Unsupported research capability.',
        error: {
          code: 'UNSUPPORTED_CAPABILITY',
          message: 'Research agent accepts research.web or research.market.',
        },
      });
      return;
    }
    if (!backendUrl) {
      sendJson(response, 503, {
        ok: false,
        agentId: 'research-agent',
        capability: input.capability,
        summary: 'Research backend is not configured.',
        error: {
          code: 'RESEARCH_BACKEND_NOT_CONFIGURED',
          message:
            'Set RESEARCH_AGENT_BACKEND_URL to a trusted research backend.',
        },
      });
      return;
    }
    sendJson(response, 501, {
      ok: false,
      agentId: 'research-agent',
      capability: input.capability,
      summary: 'Research backend adapter is not implemented in this scaffold.',
      error: {
        code: 'RESEARCH_BACKEND_NOT_IMPLEMENTED',
        message:
          'The lightweight scaffold does not include a crawler or research framework.',
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
  process.stdout.write(`research-agent listening on 0.0.0.0:${port}\n`);
});
