import { createServer } from 'node:http';

const port = Number.parseInt(process.env.BROWSER_AGENT_PORT || '3101', 10);
const apiKey = (process.env.BROWSER_AGENT_API_KEY || '').trim();
const maxBodyBytes = 64 * 1024;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  if (!apiKey) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
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
      service: 'browser-agent',
      runtimeImplemented: false,
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/agent/run') {
    sendJson(response, 404, { ok: false, summary: 'Route not found.' });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, {
      ok: false,
      summary: 'Browser agent authentication failed.',
      error: { code: 'UNAUTHORIZED', message: 'Invalid browser agent API key.' },
    });
    return;
  }

  try {
    const input = await readJson(request);
    if (
      !input ||
      !['browser.automation', 'browser.ui-test'].includes(input.capability)
    ) {
      sendJson(response, 400, {
        ok: false,
        summary: 'Unsupported browser capability.',
        error: {
          code: 'UNSUPPORTED_CAPABILITY',
          message: 'Browser agent accepts browser.automation or browser.ui-test.',
        },
      });
      return;
    }
    sendJson(response, 501, {
      ok: false,
      agentId: 'browser-agent',
      capability: input.capability,
      summary: 'Browser runtime is not implemented in the lightweight scaffold.',
      error: {
        code: 'BROWSER_RUNTIME_NOT_IMPLEMENTED',
        message:
          'Browser runtime is optional and not implemented in this scaffold yet.',
      },
      metadata: {
        taskId: input.taskId,
        artifactRoot: `/workspace/artifacts/browser-agent/${input.taskId}`,
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
  process.stdout.write(`browser-agent listening on 0.0.0.0:${port}\n`);
});
