const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeHtml } = require('../dist/utils/html-sanitizer');

test('strips script tags', () => {
  assert.equal(sanitizeHtml('<p>hello</p><script>alert(1)</script>'), '<p>hello</p>');
});

test('strips on* event handlers', () => {
  assert.ok(!sanitizeHtml('<a href="#" onclick="steal()">click</a>').includes('onclick'));
});

test('strips javascript: href', () => {
  assert.ok(!sanitizeHtml('<a href="javascript:void(0)">x</a>').includes('javascript:'));
});

test('preserves allowed tags and attributes', () => {
  const out = sanitizeHtml('<p><a href="https://example.com">link</a></p>');
  assert.ok(out.includes('<a href="https://example.com">'));
});
