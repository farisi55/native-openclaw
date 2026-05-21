const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { runSystemTool } = require('../dist/tools');

test('runSystemTool with query=time returns current time string', () => {
  const result = runSystemTool({ query: 'time' });

  assert.equal(result.ok, true);
  assert.match(result.content, /\b\d{1,2}:\d{2}/);
});

test('runSystemTool with query=date returns current date string', () => {
  const result = runSystemTool({ query: 'date' });
  const currentYear = String(new Date().getFullYear());

  assert.equal(result.ok, true);
  assert.match(result.content, new RegExp(currentYear));
});

test('runSystemTool with query=uptime returns uptime info', () => {
  const result = runSystemTool({ query: 'uptime' });

  assert.equal(result.ok, true);
  assert.equal(typeof result.content, 'string');
  assert.notEqual(result.content.trim(), '');
  assert.match(result.content, /uptime/i);
});

test('runSystemTool with query=platform returns OS info', () => {
  const result = runSystemTool({ query: 'platform' });

  assert.equal(result.ok, true);
  assert.match(result.content, /(linux|darwin|win32|Windows|Linux|macOS)/i);
});
