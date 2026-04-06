import AIClient, { AIClientFactory } from '../core/ai-client.js';
import { countMessagesTokens, estimateTokens } from '../core/token-counter.js';
import TokenDashboard from './TokenDashboard.js';
import { escapeHtml } from '../core/utils.js';

/* ═══════════════════════════════════════════════
   Particle burst effect for send button
   ═══════════════════════════════════════════════ */
function particleBurst(el) {
  try {
    const rect = el.getBoundingClientRect();
    const colors = ['#818cf8', '#34d399', '#22d3ee', '#f472b6', '#fbbf24'];
    for (let i = 0; i < 20; i++) {
      const dot = document.createElement('span');
      dot.style.cssText = `
        position: fixed; pointer-events: none; z-index: 9999;
        width: ${3 + Math.random() * 6}px; height: ${3 + Math.random() * 6}px;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        border-radius: 50%; left: ${rect.left + rect.width / 2}px;
        top: ${rect.top}px; opacity: 1; transition: all 0.6s ease-out;
        box-shadow: 0 0 6px currentColor;
      `;
      document.body.appendChild(dot);
      const angle = (Math.PI * 2 * i) / 20 + (Math.random() - 0.5) * 0.5;
      const dist = 30 + Math.random() * 60;
      requestAnimationFrame(() => {
        dot.style.left = `${parseInt(dot.style.left) + Math.cos(angle) * dist}px`;
        dot.style.top = `${parseInt(dot.style.top) + Math.sin(angle) * dist}px`;
        dot.style.opacity = '0';
        dot.style.transform = `scale(0.2)`;
      });
      setTimeout(() => dot.remove(), 700);
    }
  } catch (_e) {}
}

/* ═══════════════════════════════════════════════
   Typing indicator element
   ═══════════════════════════════════════════════ */
function createTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'message assistant typing-indicator-msg';
  el.innerHTML = `
    <div class="typing-indicator">
      <span></span><span></span><span></span><span></span>
    </div>
  `;
  return el;
}

export default class ChatUI {
  constructor(settings) {
    this.settings = settings;
    this.messagesEl = document.getElementById('chat-messages');
    this.inputEl = document.getElementById('chat-input');
    this.sendBtn = document.getElementById('btn-send');
    this.stopBtn = document.getElementById('btn-stop');
    this.statusText = document.getElementById('status-text');

    this.chatHistory = [];
    this.isLoading = false;
    this.client = null;
    this.toastContainer = null;
    this.tokenDashboard = new TokenDashboard();

    this.initToastContainer();
    this.bindEvents();
  }

  bindEvents() {
    if (this.sendBtn) this.sendBtn.addEventListener('click', () => this.sendMessage().catch(e => this.handleError(e)));
    if (this.inputEl) {
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          this.sendMessage().catch(e => this.handleError(e));
        }
      });
    }
    if (this.stopBtn) this.stopBtn.addEventListener('click', () => this.stopGeneration());
  }

  setModeManager(modeManager) {
    this.modeManager = modeManager;
  }

  setAgent(agent) {
    this.agent = agent;
  }

  setEditMode(editMode) {
    this.editMode = editMode;
  }

  addToolCallMessage(toolName, args) {
    const icons = { fs_read: '📖', fs_write: '✏️', cmd_run: '⚡' };
    const msgEl = document.createElement('div');
    msgEl.className = 'message system tool-call-msg';
    msgEl.innerHTML = `<div class="tool-call-display"><span class="tool-call-icon">${icons[toolName] || '🔧'}</span> <strong>${escapeHtml(toolName)}</strong><br/><span class="tool-call-args">${escapeHtml(JSON.stringify(args, null, 2))}</span></div>`;
    this.messagesEl.appendChild(msgEl);
    msgEl.scrollIntoView({ behavior: 'smooth' });
  }

  addToolResultMessage(toolName, result) {
    const okStyle = result.error ? 'var(--red-light)' : 'var(--green)';
    const msgEl = document.createElement('div');
    msgEl.className = 'message system tool-result-msg';
    const preview = (result.output || result.message || '').slice(0, 200);
    msgEl.innerHTML = `<div style="color: ${result.error ? 'var(--red-light)' : 'var(--text-muted)'}; font-size: 12px;"><strong>→ ${escapeHtml(toolName)}:</strong> ${result.error ? 'Error: ' + escapeHtml(String(result.error)) : escapeHtml(preview)}</div>`;
    this.messagesEl.appendChild(msgEl);
    msgEl.scrollIntoView({ behavior: 'smooth' });
  }

  showToolConfirmation(id, fnName, args, callback) {
    const isDestructive = fnName === 'cmd_run';
    const msgEl = document.createElement('div');
    msgEl.className = 'message system tool-confirmation-msg';
    msgEl.innerHTML = `
      <div style="padding: 6px 0;">
        <strong>⚠️ Conferma tool:</strong> <code>${escapeHtml(fnName)}</code>
        <pre style="font-size: 11px; margin: 4px 0; max-height: 120px; overflow: auto;">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button class="confirm-allow-btn" data-id="${escapeHtml(id)}">✔ Esegui</button>
          <button class="confirm-deny-btn" data-id="${escapeHtml(id)}">✖ Annulla</button>
        </div>
      </div>`;
    this.messagesEl.appendChild(msgEl);
    msgEl.querySelector('.confirm-allow-btn').addEventListener('click', () => {
      msgEl.innerHTML = `<span style="color: var(--green);">Eseguito: ${escapeHtml(fnName)}</span>`;
      callback(true);
    });
    msgEl.querySelector('.confirm-deny-btn').addEventListener('click', () => {
      msgEl.innerHTML = `<span style="color: var(--text-muted);">Annullato: ${escapeHtml(fnName)}</span>`;
      callback(false);
    });
    msgEl.scrollIntoView({ behavior: 'smooth' });
  }

  onFileCreated(callback) {
    this.onFileCreatedCallback = callback;
  }

  addMessage(role, content) {
    if (!this.messagesEl) {
      console.warn('ChatUI: messagesEl not available');
      return null;
    }
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;
    msgEl.textContent = content;

    this.messagesEl.appendChild(msgEl);
    msgEl.scrollIntoView({ behavior: 'smooth' });
    return msgEl;
  }

  /**
   * Durante lo streaming usa textContent (sicuro, nessun crash).
   * Uses requestAnimationFrame to throttle rendering and improve performance on fast streams.
   */
  updateMessageStreaming(msgEl, text) {
    if (!msgEl._pendingText) {
      msgEl._pendingText = text;
      requestAnimationFrame(() => {
        try {
          msgEl.textContent = msgEl._pendingText;
        } catch (e) {
          msgEl.innerText = msgEl._pendingText;
        }
        msgEl._pendingText = null;
      });
    } else {
      msgEl._pendingText = text;
    }
  }

  finalizeMessage(msgEl, content) {
    try {
      msgEl.innerHTML = this.renderMarkdown(content);
      this.highlightCodeBlocks(msgEl);
    } catch (e) {
      // Se il rendering markdown fallisce, mostra il testo raw
      msgEl.textContent = content;
    }
  }

  /** Strip dangerous HTML elements to prevent XSS from malicious markdown */
  sanitizeHtml(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[\s\S]*?<\/embed>/gi, '')
      .replace(/<link[\s>]/gi, '')
      .replace(/<meta[\s>]/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/on\w+\s*=\s*\S+/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/data\s*:/gi, '');
  }

  renderMarkdown(text) {
    try {
      if (typeof marked === 'undefined') {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      }

      marked.setOptions({
        breaks: true,
        silent: true
      });

      return this.sanitizeHtml(marked.parse(text));
    } catch (e) {
      console.error('Markdown render error:', e);
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }
  }

  highlightCodeBlocks(container) {
    if (typeof hljs === 'undefined') return;
    try {
      container.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });
      // Add copy buttons
      container.querySelectorAll('pre').forEach((pre) => {
        if (!pre.querySelector('.code-copy-btn')) {
          const btn = document.createElement('button');
          btn.className = 'code-copy-btn';
          btn.textContent = 'Copy';
          btn.addEventListener('click', async () => {
            const code = pre.querySelector('code');
            const text = code ? code.textContent : pre.textContent;
            try {
              await navigator.clipboard.writeText(text);
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            } catch (e) {
              btn.textContent = 'Error';
            }
          });
          pre.appendChild(btn);
        }
      });
    } catch (e) {
      // Ignore highlighting errors
    }
  }

  async detectAndCreateFiles(fullResponse) {
    try {
      // Match fenced code blocks that have an explicit filename marker
      const filePattern = /```(?:[\w.+-]+\s+)?(?:filename[:\s=]+)([^\n"`]+)`*\n([\s\S]*?)```/g;
      let match;
      const writePromises = [];

      while ((match = filePattern.exec(fullResponse)) !== null) {
        const filePath = match[1].trim();
        const content = match[2].trim();

        if (filePath && content && !filePath.includes('`')) {
          const prefs = this.settings.getPreferences();
          if (prefs.autoApply === 'auto') {
            writePromises.push(this.writeFile(filePath, content));
          } else {
            this.addSystemFileConfirmation(filePath, content);
          }
        }
      }
      if (writePromises.length > 0) {
        await Promise.all(writePromises);
      }
    } catch (e) {
      console.error('File detection error:', e);
    }
  }

  addSystemFileConfirmation(filePath, content) {
    try {
      const msgEl = document.createElement('div');
      msgEl.className = 'message system';
      msgEl.innerHTML = `
        <div style="padding: 4px 0;">
          <strong>File pronto per la creazione:</strong> <code>${escapeHtml(filePath)}</code>
          <div style="margin-top: 6px; display: flex; gap: 6px;">
            <button class="file-apply-btn btn-primary" style="font-size: 11px; padding: 3px 8px;">Crea file</button>
            <button class="file-discard-btn btn-danger" style="font-size: 11px; padding: 3px 8px;">Ignora</button>
          </div>
        </div>
      `;

      msgEl.querySelector('.file-apply-btn').addEventListener('click', async () => {
        await this.writeFile(filePath, content);
        msgEl.innerHTML = `<span style="color: var(--green);">File created: ${escapeHtml(filePath)}</span>`;
      });

      msgEl.querySelector('.file-discard-btn').addEventListener('click', () => {
        msgEl.innerHTML = `<span style="color: var(--text-muted);">File ignored: ${escapeHtml(filePath)}</span>`;
      });

      this.messagesEl.appendChild(msgEl);
      msgEl.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      console.error('File confirmation error:', e);
    }
  }

  async writeFile(filePath, content) {
    if (!window.api) return;
    try {
      const result = await window.api.fsWriteFile(filePath, content);
      if (result.ok && this.onFileCreatedCallback) {
        this.onFileCreatedCallback(filePath, content);
      }
    } catch (e) {
      this.addMessage('system', `Error writing file: ${e.message}`);
    }
  }

  async sendMessage(overrideContext) {
    const text = this.inputEl.value.trim();
    if (!text || this.isLoading) return;

    // Particle burst on send
    particleBurst(this.sendBtn);

    // Agent mode — delegate to agent runner
    if (this.modeManager && this.modeManager.getCurrentMode() === 'agent' && this.agent) {
      this.inputEl.value = '';
      this.agent.start(text);
      return;
    }

    // Edit mode — delegate to edit mode runner
    if (this.modeManager && this.modeManager.getCurrentMode() === 'edit' && this.editMode) {
      this.inputEl.value = '';
      this.editMode.processRequest(text);
      return;
    }

    this.inputEl.value = '';
    this.addMessage('user', text);
    this.chatHistory.push({ role: 'user', content: text });

    this.setLoading(true);

    // Show typing indicator
    const typingEl = createTypingIndicator();
    this.messagesEl.appendChild(typingEl);
    typingEl.scrollIntoView({ behavior: 'smooth' });

    try {
      await this.ensureClient();

      let contextMessages = overrideContext;
      if (!contextMessages && this.modeManager) {
        contextMessages = await this.modeManager.getContextMessages();
      }

      if (!contextMessages) {
        const systemPrompt = this.client.getSystemPrompt();
        contextMessages = [{ role: 'system', content: systemPrompt }];
      }

      // Enforce reasoning: inject reminder into system message (zero history token cost)
      if (this.modeManager) {
        const reminder = this.modeManager.getEnforcementReminder(this.chatHistory);
        if (reminder && contextMessages && contextMessages[0]) {
          contextMessages[0].content += reminder;
        }
      }

      const messages = [
        ...contextMessages,
        ...this.chatHistory
      ];

      // Smart token-based truncation
      const maxTokens = this.modeManager?.getMaxContextTokens() ?? 128000;
      if (messages.length > 1 && countMessagesTokens(messages) > maxTokens) {
        const { truncateMessages } = await import('../core/token-counter.js');
        const truncated = truncateMessages(messages, maxTokens);
        messages.length = 0;
        messages.push(...truncated);
      }

      // Update token display
      this.updateTokenDisplay(messages, maxTokens);

      // Remove typing indicator and add real message
      typingEl.remove();
      const assistantEl = this.addMessage('assistant', '');
      assistantEl.style.border = '1px solid rgba(129, 140, 248, 0.15)';
      let accumulatedText = '';

      const fullResponse = await this.client.send(messages, (chunk, full) => {
        accumulatedText = full;
        this.updateMessageStreaming(assistantEl, full);
      });

      // Enforce reasoning: auto-retry se il reasoning manca
      let reasoningRetries = 0;
      const maxRetries = this.modeManager?.maxReasoningRetries ?? 2;
      let finalResponse = fullResponse || accumulatedText;

      if (this.modeManager && !this.modeManager.validateReasoning(finalResponse)) {
        assistantEl.remove();
        this.chatHistory.pop(); // rimuovi risposta senza reasoning

        while (reasoningRetries < maxRetries) {
          reasoningRetries++;
          this.setLoading(true, `🔄 Missing reasoning — resending (${reasoningRetries}/${maxRetries})...`);

          // Aggiungi messaggio di correzione alla history
          const correction = this.modeManager.buildReasoningCorrection();
          this.chatHistory.push(correction);

          const retryMessages = [...messages, ...this.chatHistory];
          const retryResult = await this.client.send(retryMessages, (chunk, full) => {
            accumulatedText = full;
            this.updateMessageStreaming(assistantEl, full);
          });

          finalResponse = retryResult || accumulatedText;

          if (this.modeManager.validateReasoning(finalResponse)) {
            break; // Reasoning OK, esci dal loop
          }

          // Se ancora non ha reasoning, rimuovi e riprova
          assistantEl.remove();
          this.chatHistory.pop(); // rimuovi correzione
          this.chatHistory.pop(); // rimuovi risposta senza reasoning
        }
      }

      if (!finalResponse || !finalResponse.trim()) {
        finalResponse = '(No response from AI)';
      }

      // Finalizza con markdown rendering + glow effect
      this.finalizeMessage(assistantEl, finalResponse);

      this.chatHistory.push({ role: 'assistant', content: finalResponse });
      this.tokenDashboard.recordMessage('assistant', estimateTokens(finalResponse));

      // Animate code blocks appearing
      assistantEl.querySelectorAll('pre').forEach((pre, i) => {
        pre.style.animation = `slideUp 0.4s ease ${i * 0.1}s both`;
      });

      // Rileva file
      await this.detectAndCreateFiles(finalResponse);

    } catch (error) {
      if (typingEl && typingEl.parentNode) typingEl.remove();
      if (typeof assistantEl !== 'undefined' && assistantEl && !assistantEl.textContent.trim()) {
        assistantEl.remove();
      }
      this.handleError(error);
    } finally {
      this.setLoading(false);
    }
  }

  handleError(error) {
    console.error('Chat error:', error);
    this.addMessage('system', `Error: ${error.message || 'Unknown error'}`);
    this.setLoading(false);
  }

  async ensureClient() {
    if (!this.client) {
      this.client = await AIClientFactory.createFromSettings();
    }
    return this.client;
  }

  async resetClient() {
    if (this.client && typeof this.client.destroy === 'function') {
      this.client.destroy();
    }
    this.client = null;
  }

  stopGeneration() {
    if (this.agent && this.agent.running) {
      this.agent.stop();
    }
    if (this.client) {
      this.client.cancel();
    }
    if (this.editMode && typeof this.editMode.cancel === 'function') {
      this.editMode.cancel();
    }
    this.setLoading(false);
  }

  setLoading(loading, hint) {
    this.isLoading = loading;
    this.sendBtn.classList.toggle('hidden', loading);
    this.stopBtn.classList.toggle('hidden', !loading);
    this.statusText.textContent = loading ? (hint || 'Generating...') : 'Ready';
    this.inputEl.disabled = loading;
  }

  clear() {
    if (this.agent && this.agent.running) {
      this.agent.stop();
    }
    if (this.client && typeof this.client.destroy === 'function') {
      this.client.destroy();
    }
    this.client = null;
    this.chatHistory = [];
    this.messagesEl.innerHTML = '';
    const tokenEl = document.getElementById('token-display');
    if (tokenEl) tokenEl.textContent = '';
    this.tokenDashboard.reset();
  }

  showTokenDashboard() {
    this.tokenDashboard.show();
  }

  updateTokenDisplay(messages, maxTokens) {
    const totalTokens = countMessagesTokens(messages);
    const pct = Math.round((totalTokens / maxTokens) * 100);
    const tokenEl = document.getElementById('token-display');
    if (tokenEl) {
      const kTokens = (totalTokens / 1000).toFixed(1);
      tokenEl.textContent = `${kTokens}k tokens | ${pct}%`;
      if (pct > 90) tokenEl.style.color = 'var(--red-light)';
      else if (pct > 70) tokenEl.style.color = 'var(--amber)';
      else tokenEl.style.color = '';
    }
    this._lastMessageTokens = totalTokens;
  }

  initToastContainer() {
    this.toastContainer = document.createElement('div');
    this.toastContainer.className = 'toast-container';
    document.body.appendChild(this.toastContainer);
  }

  showToast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    this.toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-exit');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  exportChatAsMd() {
    let md = '# MyIDE Chat Session\n\n';
    for (const msg of this.chatHistory) {
      let roleLabel = 'User';
      if (msg.role === 'assistant') roleLabel = 'Assistant';
      else if (msg.role === 'system') roleLabel = 'System';
      else if (msg.role === 'tool') roleLabel = `Tool Result (${msg.name})`;

      md += `## ${roleLabel}\n\n${msg.content || ''}\n\n`;
      if (msg.tool_calls) {
        md += `### Tool Calls:\n\`\`\`json\n${JSON.stringify(msg.tool_calls, null, 2)}\n\`\`\`\n\n`;
      }
    }

    // Save current session
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sessions = this.loadChatSessions();
    sessions.unshift({ name: `Chat ${timestamp}`, date: timestamp, messages: [...this.chatHistory] });
    this.saveChatSessions(sessions);

    // Download
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `myide-chat-${timestamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast('Chat exported!', 'success');
  }

  saveChatSessions(sessions) {
    try {
      const data = JSON.stringify(sessions);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('myide-chat-sessions', data);
      }
    } catch (e) { /* ignore */ }
  }

  loadChatSessions() {
    try {
      const data = typeof localStorage !== 'undefined' ? localStorage.getItem('myide-chat-sessions') : null;
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  loadChatSession(index) {
    const sessions = this.loadChatSessions();
    const session = sessions[index];
    if (session) {
      this.chatHistory = [...session.messages];
      this.messagesEl.innerHTML = '';
      for (const msg of session.messages) {
        if (msg.role === 'tool' && msg.name) {
          if (msg.content === 'CANCELLED BY USER: operation not executed.') {
             this.addMessage('system', `Tool ${msg.name} cancelled by user.`);
             continue;
          }
          this.addToolResultMessage(msg.name, { output: msg.content, error: msg.content?.startsWith('Error:') ? msg.content : null });
          continue;
        }

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            const el = this.addMessage('assistant', '');
            this.finalizeMessage(el, msg.content);
          }
          for (const tc of msg.tool_calls) {
             let args;
             try { args = JSON.parse(tc.function.arguments); } catch (e) { args = tc.function.arguments; }
             this.addToolCallMessage(tc.function.name, args);
          }
          continue;
        }

        const el = this.messagesEl.appendChild(document.createElement('div'));
        el.className = `message ${msg.role}`;
        if (msg.role === 'assistant') {
          this.finalizeMessage(el, msg.content || '');
        } else {
          el.textContent = msg.content || '';
        }
      }
      this.saveChatSessions(sessions);
    }
  }

  deleteChatSession(index) {
    const sessions = this.loadChatSessions();
    sessions.splice(index, 1);
    this.saveChatSessions(sessions);
    this.showToast('Session deleted', 'info');
  }

  _bindSessionListEvents(msgEl, sessions) {
    msgEl.querySelectorAll('.chat-session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (!e.target.classList.contains('chat-session-delete')) {
          const idx = el.dataset.index;
          this.loadChatSession(parseInt(idx));
          msgEl.innerHTML = `<span style="color: var(--green);">Session loaded: ${escapeHtml(sessions[idx].name)}</span>`;
        }
      });
      el.querySelector('.chat-session-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.index);
        this.deleteChatSession(idx);
        // Re-render the session list to update all indices
        const updatedSessions = this.loadChatSessions();
        if (updatedSessions.length === 0) {
          msgEl.innerHTML = '<span style="color: var(--text-muted);">No saved sessions</span>';
        } else {
          let html = '<div style="padding: 4px 0;"><strong>Chat History</strong></div>';
          updatedSessions.forEach((s, i) => {
            html += `<div class="chat-session-item" data-index="${i}"><span class="chat-session-name">${escapeHtml(s.name)} (${escapeHtml(String(s.messages.length))} msg)</span><span class="chat-session-date">${escapeHtml(s.date)}</span><button class="chat-session-delete" data-index="${i}">&#10005;</button></div>`;
          });
          msgEl.innerHTML = html;
          this._bindSessionListEvents(msgEl, updatedSessions);
        }
      });
    });
  }

  showChatHistory() {
    const sessions = this.loadChatSessions();
    if (sessions.length === 0) {
      this.showToast('No saved sessions', 'info');
      return;
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'message system';
    let html = '<div style="padding: 4px 0;"><strong>Chat History</strong></div>';
    sessions.forEach((s, i) => {
      html += `<div class="chat-session-item" data-index="${i}"><span class="chat-session-name">${escapeHtml(s.name)} (${escapeHtml(String(s.messages.length))} msg)</span><span class="chat-session-date">${escapeHtml(s.date)}</span><button class="chat-session-delete" data-index="${i}">&#10005;</button></div>`;
    });
    msgEl.innerHTML = html;
    this._bindSessionListEvents(msgEl, sessions);
    this.messagesEl.appendChild(msgEl);
    msgEl.scrollIntoView({ behavior: 'smooth' });
  }
}
