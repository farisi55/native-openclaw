const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  isGoldReportWorkflowRequest,
  isWorkflowRunRequest,
  runGoldReportWorkflow,
  runWorkflowFromWorkspace,
  shouldEmailGoldReport,
} = require('../dist/workflows');
const { ToolRegistry } = require('../dist/tools/tool-registry');
const { WorkspaceManager } = require('../dist/workspace');
const { sendBrevoEmail } = require('../dist/tools/brevo-email');

async function withTempWorkspace(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-openclaw-gold-workflow-'));
  const previousWorkspace = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function clearBrevoEnv() {
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  delete process.env.BREVO_RECIPIENT_EMAIL;
}

async function testTriggerDetection() {
  assert.strictEqual(isGoldReportWorkflowRequest('tolong buat daily gold report'), true);
  assert.strictEqual(isGoldReportWorkflowRequest('analisis harga emas dan kirim email'), true);
  assert.strictEqual(isGoldReportWorkflowRequest('hello biasa saja'), false);
  assert.strictEqual(isWorkflowRunRequest('jalankan workflow'), true);
  assert.strictEqual(isWorkflowRunRequest('buat laporan berdasarkan WORKFLOW.md'), true);
  assert.strictEqual(shouldEmailGoldReport('daily gold report'), false);
  assert.strictEqual(shouldEmailGoldReport('analisis harga emas dan kirim email'), true);
}

async function testMissingMcpStillWritesReport() {
  await withTempWorkspace(async (dir) => {
    clearBrevoEnv();
    const workflow = await runGoldReportWorkflow(
      'Perintah Otonom: Laporan Komoditas Emas Harian. Kirim laporan HTML via Brevo ke email konfigurasi',
      {
        toolRegistry: new ToolRegistry(process.cwd()),
        workspace: new WorkspaceManager({ rootDir: dir }),
        now: new Date('2026-05-16T00:00:00.000Z'),
      }
    );

    assert.match(workflow.content, /Workflow: Daily Market Intelligence Report/);
    assert.ok(workflow.missingCapabilities.some((item) => item.includes('/mcp add tavily')));
    assert.ok(workflow.missingCapabilities.some((item) => item.includes('BREVO_API_KEY')));
    assert.strictEqual(workflow.emailStatus.sent, false);

    const html = await fs.readFile(path.join(dir, 'reports', 'daily-market-intelligence-report-2026-05-16.html'), 'utf-8');
    const json = JSON.parse(await fs.readFile(path.join(dir, 'reports', 'daily-market-intelligence-report-2026-05-16.json'), 'utf-8'));
    assert.match(html, /Harga emas dan proyeksi pasar harian/);
    assert.strictEqual(json.workflow.topic, 'Harga emas dan proyeksi pasar harian');
  });
}

async function testDynamicOilWorkflowDoesNotUseGoldAssumptions() {
  await withTempWorkspace(async (dir) => {
    clearBrevoEnv();
    const workspace = new WorkspaceManager({ rootDir: dir });
    await workspace.ensureWorkspace();
    await workspace.write('WORKFLOW.md', `# Workflow: Daily Oil Price Report

## Role
You are an autonomous energy market analyst.

## Topic
Harga minyak Brent dan WTI hari ini

## Data Requirements
- Search Brent crude oil price today
- Search WTI crude oil price today
- Search OPEC news

## Analysis Requirements
- Compare Brent vs WTI
- Summarize trend
- Generate tomorrow projection

## Output Requirements
- Generate professional HTML report
- Save report to workspace/reports

## Email
sendEmail: false
subject: "[LAPORAN HARIAN] Harga Minyak Dunia - {{date}}"
`);

    const workflow = await runWorkflowFromWorkspace({
      toolRegistry: new ToolRegistry(process.cwd()),
      workspace,
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    assert.match(workflow.content, /Daily Oil Price Report/);
    assert.match(workflow.topic, /Brent dan WTI/);
    assert.doesNotMatch(workflow.content, /XAU|Antam|emas_trend/);
    const html = await fs.readFile(path.join(dir, 'reports', 'daily-oil-price-report-2026-05-16.html'), 'utf-8');
    assert.match(html, /Harga minyak Brent dan WTI hari ini/);
  });
}

async function testBrevoMissingEnvDoesNotClaimSent() {
  clearBrevoEnv();
  const result = await sendBrevoEmail({
    subject: 'Test',
    htmlContent: '<p>Hello</p>',
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.content, /Missing/);
}

async function run() {
  await testTriggerDetection();
  await testMissingMcpStillWritesReport();
  await testDynamicOilWorkflowDoesNotUseGoldAssumptions();
  await testBrevoMissingEnvDoesNotClaimSent();
  console.log('dynamic workflow tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
