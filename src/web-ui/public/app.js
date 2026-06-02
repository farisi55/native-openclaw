const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const clearButton = document.getElementById('clear-button');

let sessionId = null;
const history = [];

function render() {
  messagesEl.innerHTML = '';
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Start a conversation with Native OpenClaw. Your browser keeps this page history only until you clear or reload it.';
    messagesEl.appendChild(empty);
    return;
  }

  for (const item of history) {
    const bubble = document.createElement('article');
    bubble.className = `message ${item.role}${item.error ? ' error' : ''}`;
    const content = document.createElement('div');
    content.textContent = item.content;
    bubble.appendChild(content);

    if (item.meta) {
      const details = document.createElement('details');
      details.className = 'meta';
      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      details.appendChild(summary);
      const meta = document.createElement('div');
      meta.textContent = [
        item.meta.provider ? `Provider: ${item.meta.provider}` : null,
        item.meta.model ? `Model: ${item.meta.model}` : null,
        item.meta.responseTime ? `Response time: ${item.meta.responseTime}` : null,
        item.meta.tools?.length ? `Tools: ${item.meta.tools.join(', ')}` : 'Tools: none',
        item.meta.sessionId ? `Session: ${item.meta.sessionId}` : null,
      ].filter(Boolean).join('\n');
      details.appendChild(meta);
      bubble.appendChild(details);
    }

    messagesEl.appendChild(bubble);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setLoading(isLoading) {
  sendButton.disabled = isLoading;
  input.disabled = isLoading;
  sendButton.textContent = isLoading ? 'Sending...' : 'Send';
}

async function sendMessage(message) {
  history.push({ role: 'user', content: message });
  render();
  setLoading(true);

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });
    const data = await response.json();
    if (data.sessionId) sessionId = data.sessionId;

    history.push({
      role: 'assistant',
      content: data.result || data.error || 'No response.',
      error: !data.ok,
      meta: {
        model: data.model,
        provider: data.provider,
        responseTime: data.responseTime,
        tools: data.tools || [],
        sessionId: data.sessionId,
      },
    });
  } catch (err) {
    history.push({
      role: 'assistant',
      content: err instanceof Error ? err.message : String(err),
      error: true,
    });
  } finally {
    setLoading(false);
    render();
    input.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  void sendMessage(message);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

clearButton.addEventListener('click', () => {
  history.length = 0;
  render();
  input.focus();
});

render();
input.focus();
