import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { isAbsolute } from 'path';
import { assertMcpCommandAllowed, type McpServerConfig } from './mcp-config';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class McpClient {
  private readonly name: string;
  private readonly config: McpServerConfig;
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrTail = '';

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      assertMcpCommandAllowed(this.config.command);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectAll(error);
      return;
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !isAbsolute(this.config.command),
      windowsHide: true,
    });

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf-8')).slice(-4_000);
    });
    this.process.on('error', (err) => this.rejectAll(err));
    this.process.on('exit', (code, signal) => {
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${detail}` : '';
      this.rejectAll(new Error(`MCP server "${this.name}" exited (${code ?? signal ?? 'unknown'})${suffix}`));
      this.process = null;
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'native-openclaw',
        version: '1.0.0',
      },
    });

    this.notify('notifications/initialized', {});
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    this.rejectAll(new Error(`MCP server "${this.name}" stopped.`));
    child.kill();
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];

    return tools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === 'object')
      .filter((tool) => typeof tool['name'] === 'string')
      .map((tool) => {
        const item: McpTool = { name: String(tool['name']) };
        if (typeof tool['description'] === 'string') item.description = tool['description'];
        if (tool['inputSchema'] && typeof tool['inputSchema'] === 'object') {
          item.inputSchema = tool['inputSchema'] as Record<string, unknown>;
        }
        return item;
      });
  }

  async callTool(toolName: string, args: unknown): Promise<McpCallResult> {
    const result = await this.request('tools/call', {
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
    });
    return result as McpCallResult;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.process) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, DEFAULT_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.process) return;
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (!this.process) return;
    const body = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf-8');
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        this.handleMessage(JSON.parse(body) as JsonRpcResponse);
      } catch (err) {
        this.rejectAll(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') return;

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `MCP request failed: ${message.id}`));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
