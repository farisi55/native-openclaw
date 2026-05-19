const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { sendBrevoEmail } = require('../dist/tools/brevo-email');

const originalFetch = global.fetch;

function clearBrevoEnv() {
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  delete process.env.BREVO_RECIPIENT_EMAIL;
  delete process.env.BREVO_SENDER_NAME;
  delete process.env.BREVO_RECIPIENT_NAME;
}

test.afterEach(() => {
  global.fetch = originalFetch;
  clearBrevoEnv();
});

test('sendBrevoEmail returns error when BREVO_API_KEY missing', async () => {
  clearBrevoEnv();
  const result = await sendBrevoEmail({
    subject: 'Test',
    htmlContent: '<p>Hello</p>',
  });
  assert.equal(result.ok, false);
  assert.match(result.content, /Missing/);
  assert.ok(result.missingEnv?.includes('BREVO_API_KEY'));
});

test('sendBrevoEmail returns error when subject missing', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
  process.env.BREVO_RECIPIENT_EMAIL = 'recipient@test.com';

  const result = await sendBrevoEmail({ htmlContent: '<p>Hello</p>' });
  assert.equal(result.ok, false);
  assert.ok(result.missingEnv?.includes('subject'));
});

test('sendBrevoEmail returns error when htmlContent missing', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
  process.env.BREVO_RECIPIENT_EMAIL = 'recipient@test.com';

  const result = await sendBrevoEmail({ subject: 'Hello' });
  assert.equal(result.ok, false);
  assert.ok(result.missingEnv?.includes('htmlContent'));
});

test('sendBrevoEmail sends correctly without attachments', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'fake-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
  process.env.BREVO_RECIPIENT_EMAIL = 'recipient@test.com';

  let capturedBody = null;
  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 201,
      async json() {
        return { messageId: '<test-message-id@brevo.com>' };
      },
    };
  };

  const result = await sendBrevoEmail({
    subject: 'Unit Test Email',
    htmlContent: '<h1>Test</h1>',
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /sent/i);
  assert.equal(capturedBody.subject, 'Unit Test Email');
  assert.equal(capturedBody.htmlContent, '<h1>Test</h1>');
  assert.equal(capturedBody.to[0].email, 'recipient@test.com');
  assert.equal(capturedBody.sender.email, 'sender@test.com');
  assert.equal(capturedBody.attachment, undefined, 'no attachment field when none given');
});

test('sendBrevoEmail ignores placeholder recipient and uses env recipient', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'fake-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
  process.env.BREVO_SENDER_NAME = 'Configured Sender';
  process.env.BREVO_RECIPIENT_EMAIL = 'configured@test.com';
  process.env.BREVO_RECIPIENT_NAME = 'Boss';

  let capturedBody = null;
  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 201,
      async json() {
        return { messageId: '<configured-recipient@brevo.com>' };
      },
    };
  };

  const result = await sendBrevoEmail({
    subject: 'Placeholder Recipient',
    htmlContent: '<p>Hello</p>',
    recipientEmail: 'email@example.com',
    recipientName: 'Nama Penerima',
  });

  assert.equal(result.ok, true);
  assert.equal(result.recipientEmail, 'configured@test.com');
  assert.equal(capturedBody.to[0].email, 'configured@test.com');
  assert.equal(capturedBody.to[0].name, 'Boss');
  assert.equal(capturedBody.sender.name, 'Configured Sender');
});

test('sendBrevoEmail rejects placeholder recipient when env recipient is missing', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'fake-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';

  const result = await sendBrevoEmail({
    subject: 'Missing Recipient',
    htmlContent: '<p>Hello</p>',
    recipientEmail: 'recipient@example.com',
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingEnv?.includes('BREVO_RECIPIENT_EMAIL'));
});

test('sendBrevoEmail includes base64 attachment when file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brevo-attach-test-'));
  try {
    const attachPath = join(dir, 'report.txt');
    await writeFile(attachPath, 'Hello attachment content', 'utf-8');

    clearBrevoEnv();
    process.env.BREVO_API_KEY = 'fake-key';
    process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
    process.env.BREVO_RECIPIENT_EMAIL = 'recipient@test.com';

    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        async json() {
          return { messageId: '<attach-test@brevo.com>' };
        },
      };
    };

    const result = await sendBrevoEmail({
      subject: 'With Attachment',
      htmlContent: '<p>See attached</p>',
      attachments: [{ path: attachPath, name: 'report.txt' }],
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(capturedBody.attachment), 'attachment must be array');
    assert.equal(capturedBody.attachment.length, 1);
    assert.equal(capturedBody.attachment[0].name, 'report.txt');

    // Verify base64 decodes back to original content
    const decoded = Buffer.from(capturedBody.attachment[0].content, 'base64').toString('utf-8');
    assert.equal(decoded, 'Hello attachment content');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sendBrevoEmail handles Brevo API error response gracefully', async () => {
  clearBrevoEnv();
  process.env.BREVO_API_KEY = 'bad-key';
  process.env.BREVO_SENDER_EMAIL = 'sender@test.com';
  process.env.BREVO_RECIPIENT_EMAIL = 'recipient@test.com';

  global.fetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return { message: 'Key not found', code: 'unauthorized' };
    },
  });

  const result = await sendBrevoEmail({
    subject: 'Fail Test',
    htmlContent: '<p>Will fail</p>',
  });

  assert.equal(result.ok, false);
  assert.match(result.content, /not sent/i);
});
