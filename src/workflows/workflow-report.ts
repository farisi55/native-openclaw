import { deflateSync } from 'zlib';
import type {
  WorkflowDefinition,
  WorkflowGeneratedFile,
  WorkflowRunResult,
  WorkflowToolResult,
} from './workflow-types';

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'workflow-report';
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s)"'<>]+/g) ?? []).slice(0, 20))];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(text: string, max = 3000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function summarizeResults(results: WorkflowToolResult[]): string {
  const successful = results.filter((result) => result.ok);
  if (successful.length === 0) {
    return 'No successful external data collection results were available. The report is limited to workflow instructions and execution diagnostics.';
  }

  return successful
    .slice(0, 6)
    .map((result) => `${result.goal}: ${truncate(result.output.replace(/\s+/g, ' '), 500)}`)
    .join('\n\n');
}

export function buildWorkflowHtmlReport(args: {
  workflow: WorkflowDefinition;
  date: string;
  results: WorkflowToolResult[];
  analysisText: string;
  chartPath: string | null;
  generatedFiles: WorkflowGeneratedFile[];
  errors: string[];
  missingCapabilities: string[];
}): string {
  const sources = [...new Set(args.results.flatMap((result) => result.sources))];
  const dataPoints = summarizeResults(args.results);

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(args.workflow.title)} - ${escapeHtml(args.date)}</title>`,
    '<style>body{font-family:Arial,sans-serif;color:#18202a;line-height:1.55;max-width:960px;margin:0 auto;padding:24px}h1,h2{color:#111827}.card{border:1px solid #d7dde7;padding:16px;margin:14px 0}pre{white-space:pre-wrap;background:#f5f7fa;padding:12px;overflow:auto}a{color:#1455b8}</style>',
    '</head><body>',
    `<h1>${escapeHtml(args.workflow.title)}</h1>`,
    `<p><strong>Date/time:</strong> ${escapeHtml(args.date)}</p>`,
    `<p><strong>Topic:</strong> ${escapeHtml(args.workflow.topic)}</p>`,
    '<div class="card"><h2>Executive Summary</h2>',
    `<p>${escapeHtml(args.analysisText.split('\n')[0] || 'Workflow executed. Review detailed sections below for data, analysis, limitations, and sources.')}</p>`,
    '</div>',
    '<div class="card"><h2>Key Data Points</h2>',
    `<pre>${escapeHtml(dataPoints)}</pre>`,
    '</div>',
    '<div class="card"><h2>Analysis, Projection, Recommendation</h2>',
    `<pre>${escapeHtml(args.analysisText || 'Analysis unavailable.')}</pre>`,
    '</div>',
    args.chartPath
      ? `<div class="card"><h2>Generated Chart</h2><p>Saved as <code>${escapeHtml(args.chartPath)}</code>.</p><img src="${escapeHtml(args.chartPath.split('/').pop() ?? args.chartPath)}" alt="Generated chart" style="max-width:100%;height:auto"></div>`
      : '<div class="card"><h2>Generated Chart</h2><p>No chart was generated.</p></div>',
    '<div class="card"><h2>Source Links</h2>',
    sources.length > 0
      ? `<ul>${sources.map((source) => `<li><a href="${escapeHtml(source)}">${escapeHtml(source)}</a></li>`).join('')}</ul>`
      : '<p>No source URLs were available from tool output.</p>',
    '</div>',
    '<div class="card"><h2>Limitations</h2>',
    args.missingCapabilities.length > 0
      ? `<p><strong>Missing capabilities:</strong> ${escapeHtml(args.missingCapabilities.join('; '))}</p>`
      : '<p>No missing capabilities reported.</p>',
    args.errors.length > 0
      ? `<p><strong>Errors:</strong> ${escapeHtml(args.errors.join('; '))}</p>`
      : '<p>No execution errors reported.</p>',
    '</div>',
    '</body></html>',
  ].filter(Boolean).join('\n');
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function setPixel(raw: Buffer, width: number, x: number, y: number, color: [number, number, number]): void {
  const rowLength = 1 + width * 3;
  const offset = y * rowLength + 1 + x * 3;
  if (x < 0 || y < 0 || x >= width || offset < 1 || offset + 2 >= raw.length) return;
  raw[offset] = color[0];
  raw[offset + 1] = color[1];
  raw[offset + 2] = color[2];
}

function drawLine(raw: Buffer, width: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  while (true) {
    setPixel(raw, width, x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function extractNumericSeries(text: string): number[] {
  return [...text.matchAll(/(?:[$]|USD|Rp\.?)?\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]{4,}(?:[.,][0-9]{1,2})?)/g)]
    .map((match) => {
      const raw = match[1] ?? '';
      const normalized = raw.includes('.') && raw.includes(',')
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
      return Number(normalized);
    })
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 12);
}

export function createTrendPng(values: number[]): Buffer {
  const width = 640;
  const height = 360;
  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * height, 255);
  for (let y = 0; y < height; y++) raw[y * rowLength] = 0;

  const left = 56;
  const right = width - 32;
  const top = 32;
  const bottom = height - 48;
  drawLine(raw, width, left, bottom, right, bottom, [120, 130, 145]);
  drawLine(raw, width, left, top, left, bottom, [120, 130, 145]);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const points = values.map((value, index) => ({
    x: left + Math.round((index / Math.max(1, values.length - 1)) * (right - left)),
    y: bottom - Math.round(((value - min) / span) * (bottom - top)),
  }));

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const next = points[i]!;
    drawLine(raw, width, prev.x, prev.y, next.x, next.y, [25, 92, 190]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildWorkflowFinalSummary(result: WorkflowRunResult): string {
  return [
    `Workflow: ${result.title}`,
    `Topic: ${result.topic}`,
    '',
    'Tools used:',
    ...(result.toolsUsed.length > 0 ? result.toolsUsed.map((tool) => `- ${tool}`) : ['- None']),
    '',
    'Sources:',
    ...(result.sources.length > 0 ? result.sources.map((source) => `- ${source}`) : ['- None']),
    '',
    'Result highlights:',
    ...(result.rawResults.length > 0
      ? result.rawResults.slice(0, 3).map((item) => `- ${truncate(item.output.replace(/\s+/g, ' '), 500)}`)
      : ['- None']),
    '',
    'Generated files:',
    ...(result.generatedFiles.length > 0 ? result.generatedFiles.map((file) => `- ${file.path}`) : ['- None']),
    '',
    `Email status: ${result.emailStatus.sent ? 'sent' : result.emailStatus.attempted ? 'not sent' : 'skipped'} (${result.emailStatus.method})`,
    result.emailStatus.detail,
    ...(result.missingCapabilities.length > 0 ? ['', 'Missing capabilities:', ...result.missingCapabilities.map((item) => `- ${item}`)] : []),
    ...(result.errors.length > 0 ? ['', 'Errors:', ...result.errors.map((item) => `- ${item}`)] : []),
  ].join('\n');
}
