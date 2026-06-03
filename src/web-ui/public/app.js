(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function renderInlineMarkdown(value) {
    let output = escapeHtml(value);
    output = output.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    output = output.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s<>"')]+)\)/gi,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    output = output.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return output;
  }

  function renderMarkdownBlock(block) {
    const trimmed = block.trim();
    if (!trimmed) return '';

    if (/^@@CODE_BLOCK_\d+@@$/.test(trimmed)) {
      return trimmed;
    }

    const lines = trimmed.split('\n');
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines
        .map((line) => line.replace(/^\s*[-*]\s+/, ''))
        .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }

    return `<p>${renderInlineMarkdown(trimmed).replace(/\n/g, '<br>')}</p>`;
  }

  function renderMarkdown(value) {
    const codeBlocks = [];
    const source = String(value ?? '').replace(/\r\n/g, '\n');
    const withoutCodeBlocks = source.replace(
      /```([A-Za-z0-9_-]+)?\n?([\s\S]*?)```/g,
      (_match, language, code) => {
        const index = codeBlocks.length;
        const className = language ? ` class="language-${escapeAttribute(language)}"` : '';
        const cleanedCode = String(code ?? '').replace(/\n$/, '');
        codeBlocks.push(`<pre><code${className}>${escapeHtml(cleanedCode)}</code></pre>`);
        return `\n\n@@CODE_BLOCK_${index}@@\n\n`;
      }
    );

    let rendered = withoutCodeBlocks
      .split(/\n{2,}/)
      .map((block) => renderMarkdownBlock(block))
      .join('');

    codeBlocks.forEach((block, index) => {
      rendered = rendered.replace(`@@CODE_BLOCK_${index}@@`, block);
    });

    return rendered || '';
  }

  function renderMessageContent(role, content) {
    if (role === 'assistant') return renderMarkdown(content);
    return escapeHtml(content).replace(/\r?\n/g, '<br>');
  }

  const markdownApi = {
    escapeHtml,
    renderMarkdown,
    renderMessageContent,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.NativeOpenClawMarkdown = markdownApi;
  }

  if (typeof document === 'undefined') return;

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message-input');
  const sendButton = document.getElementById('send-button');
  const clearButton = document.getElementById('clear-button');

  let sessionId = null;
  let pending = false;
  const history = [];

  function render() {
    messagesEl.innerHTML = '';
    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Start a conversation with smooth. Make your life easier. Your browser keeps this page history only until you clear or reload it.';
      messagesEl.appendChild(empty);
      return;
    }

    for (const item of history) {
      const bubble = document.createElement('article');
      bubble.className = `message ${item.role}${item.error ? ' error' : ''}${item.loading ? ' loading' : ''}`;
      const content = document.createElement('div');
      content.className = 'message-content';
      if (item.loading) {
        content.innerHTML = [
          '<div class="typing-indicator">',
          '<span>smooth is thinking</span>',
          '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>',
          '</div>',
        ].join('');
      } else {
        content.innerHTML = renderMessageContent(item.role, item.content);
      }
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
    pending = isLoading;
    sendButton.disabled = isLoading;
    input.disabled = isLoading;
    clearButton.disabled = isLoading;
    sendButton.textContent = isLoading ? 'Thinking...' : 'Send';
  }

  function replaceMessage(id, nextItem) {
    const index = history.findIndex((item) => item.id === id);
    if (index >= 0) {
      history[index] = nextItem;
    } else {
      history.push(nextItem);
    }
  }

  async function sendMessage(message) {
    if (pending) return;
    const loadingId = `loading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    history.push({ role: 'user', content: message });
    history.push({ id: loadingId, role: 'assistant', content: '', loading: true });
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

      replaceMessage(loadingId, {
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
      replaceMessage(loadingId, {
        role: 'assistant',
        content: 'Terjadi kesalahan saat memproses pesan. Silakan coba lagi.',
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
    if (pending) return;
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    void sendMessage(message);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (pending) return;
      form.requestSubmit();
    }
  });

  clearButton.addEventListener('click', () => {
    if (pending) return;
    history.length = 0;
    render();
    input.focus();
  });

  render();
  input.focus();
})();
