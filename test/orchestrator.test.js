const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { Orchestrator } = require('../dist/agents/orchestrator');
const { WorkspaceManager } = require('../dist/workspace');

test('Orchestrator uses the injected workspace instance', () => {
  const workspace = new WorkspaceManager();
  const orchestrator = new Orchestrator(
    {},
    { activeIds: [], has: () => false },
    {},
    { listTools: () => [] },
    {},
    {},
    workspace
  );

  assert.strictEqual(orchestrator.workspace, workspace);
});
