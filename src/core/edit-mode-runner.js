import AIClient, { AIClientFactory } from './ai-client.js';

/**
 * Edit Mode Runner — il sistema AI legge il file, propone un diff
 * e l'utente approva/rifiuta la modifica.
 */
export default class EditModeRunner {
  constructor(chatUI, modeManager, editor) {
    this.chat = chatUI;
    this.modeManager = modeManager;
    this.editor = editor;
  }

  cancel() {
    if (this._activeClient) {
      this._activeClient.cancel();
    }
  }

  buildSystemPrompt() {
    return `You are a code editor assistant. The user will tell you what to change in a file.
You must output the changes as a **unified diff block** with \`filename:\` marker.

Rules:
1. ALWAYS use the exact path of the current file for the diff filename marker.
2. Use unified diff format:
   - Lines starting with "+" are new
   - Lines starting with "-" are removed
   - Context lines are unchanged
3. Include enough context lines (3+) so the diff can be applied unambiguously.
4. If creating a new file, use the diff marker with an empty file path.
5. Explain the changes in plain text after the diff block.

Example:
\`\`\`diff filename:src/utils.js
  function greet(name) {
-   console.log("Hello " + name)
+   return \`Hello \${name}\`;
+ }
+
+ function farewell(name) {
+   console.log(\`Goodbye \${name}\`);

Explanation: Changed greet to return instead of console.log, added farewell function.
\`\`\``;
  }

  async processRequest(userMessage) {
    let client = null;
    try {
      if (!this.editor.currentFile) {
        this.chat.addMessage('system', 'Errore: nessun file aperto. Apri un file prima di usare la modalita Edit.');
        return;
      }

      this.chat.setLoading(true);

      // Snapshot per undo
      const fileSnapshot = {
        path: this.editor.currentFile,
        content: this.editor.getContent(),
        timestamp: Date.now()
      };

      const contextMessages = await this.modeManager.getContextMessages();
      const systemMsg = contextMessages.find(m => m.role === 'system');
      if (systemMsg) {
        systemMsg.content = this.buildSystemPrompt() + '\n\n' + systemMsg.content;
      }

      this.chat.chatHistory.push({ role: 'user', content: userMessage });
      this.chat.addMessage('user', userMessage);

      client = await AIClientFactory.createFromSettings();
      this._activeClient = client;
      const messages = [
        ...contextMessages,
        ...this.chat.chatHistory
      ];

      // Show typing indicator
      const typingEl = document.createElement('div');
      typingEl.className = 'message assistant typing-indicator-msg';
      typingEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span><span></span></div>';
      if (this.chat.messagesEl) this.chat.messagesEl.appendChild(typingEl);
      typingEl.scrollIntoView({ behavior: 'smooth' });

      let accumulatedText = '';
      const assistantEl = this.chat.addMessage('assistant', '');

      const fullResponse = await client.send(messages, (chunk, full) => {
        accumulatedText = full;
        this.chat.updateMessageStreaming(assistantEl, full);
      });

      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);

      const finalText = fullResponse || accumulatedText;

      // Enforce reasoning: auto-retry se il reasoning manca in edit mode (se supportato da modeManager)
      let finalResponseChecked = finalText;
      if (this.modeManager && !this.modeManager.validateReasoning(finalText)) {
        let reasoningRetries = 0;
        const maxRetries = this.modeManager?.maxReasoningRetries ?? 2;

        while (reasoningRetries < maxRetries) {
          reasoningRetries++;
          this.chat.setLoading(true, `🔄 Reasoning mancante — reinvio (${reasoningRetries}/${maxRetries})...`);

          const correction = this.modeManager.buildReasoningCorrection();
          const retryMessages = [
            ...messages,
            { role: 'assistant', content: finalResponseChecked },
            correction
          ];

          const retryResult = await client.send(retryMessages, (chunk, full) => {
             accumulatedText = full;
             this.chat.updateMessageStreaming(assistantEl, full);
          });

          finalResponseChecked = retryResult || accumulatedText;
          if (this.modeManager.validateReasoning(finalResponseChecked)) {
            break;
          }
        }
      }

      this.finalizeResponse(assistantEl, finalResponseChecked, fileSnapshot);
    } catch (error) {
      console.error('Edit mode error:', error);
      this.chat.addMessage('system', `Errore: ${error.message}`);
    } finally {
      this._activeClient = null;
      if (client && typeof client.destroy === 'function') {
        client.destroy();
      }
      this.chat.setLoading(false);
    }
  }

  finalizeResponse(assistantEl, content, snapshot) {
    this.chat.finalizeMessage(assistantEl, content);
    this.chat.chatHistory.push({ role: 'assistant', content });

    // Parse diff dal contenuto
    const diffs = this.parseDiffs(content);

    if (diffs.length > 0) {
      this.showDiffConfirmation(diffs, snapshot);
    }
  }

  parseDiffs(content) {
    const diffs = [];
    // Match fenced diff code blocks with filename marker
    const pattern = /```diff\s+(?:filename[:\s=]+)([^\n"`]+)\s*\n([\s\S]*?)```/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const filePath = match[1].trim();
      const diffText = match[2].trim();
      if (filePath && diffText) {
        diffs.push({ filePath, diffText });
      }
    }

    // Fallback: match any code block with filename and diff-like content
    if (diffs.length === 0) {
      const fallbackPattern = /```(?:[\w.+-]+\s+)?(?:filename[:\s=]+)([^\n"`]+)`*\n([\s\S]*?)```/gi;
      while ((match = fallbackPattern.exec(content)) !== null) {
        const filePath = match[1].trim();
        const codeBlock = match[2].trim();
        if (codeBlock.includes('+') || codeBlock.includes('-')) {
          // Check if it looks like a diff
          if (codeBlock.startsWith('---') || codeBlock.startsWith('+++')) {
            diffs.push({ filePath, diffText: codeBlock });
          } else {
            // Treat as inline replacement
            const lines = codeBlock.split('\n');
            const newContent = lines.filter(l => !l.startsWith('-')).join('\n');
            diffs.push({ filePath, diffText: codeBlock, newContent });
          }
        }
      }
    }

    return diffs;
  }

  showDiffConfirmation(diffs, snapshot) {
    for (const diff of diffs) {
      const msgEl = document.createElement('div');
      msgEl.className = 'message system diff-confirm-msg';
      msgEl.innerHTML = `
        <div style="padding: 8px 0;">
          <strong>Modifica proposta per:</strong> <code>${this.chat.escapeHtml(diff.filePath)}</code>
          <pre class="diff-preview" style="font-size: 11px; margin: 8px 0; max-height: 300px; overflow: auto; background: #111; padding: 10px; border-radius: 6px; border: 1px solid var(--border);">${this.renderDiffPreview(diff)}</pre>
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <button class="diff-apply-btn" data-file="${this.chat.escapeHtml(diff.filePath)}">✔ Applica</button>
            <button class="diff-reject-btn" data-file="${this.chat.escapeHtml(diff.filePath)}">✖ Rifiuta</button>
          </div>
        </div>`;
      this.chat.messagesEl.appendChild(msgEl);
      msgEl.scrollIntoView({ behavior: 'smooth' });

      msgEl.querySelector('.diff-apply-btn').addEventListener('click', async () => {
        await this.applyDiff(diff, snapshot);
        msgEl.innerHTML = `<span style="color: var(--green);">Modifica applicata a ${this.chat.escapeHtml(diff.filePath)}</span>`;
      });

      msgEl.querySelector('.diff-reject-btn').addEventListener('click', () => {
        msgEl.innerHTML = `<span style="color: var(--text-muted);">Modifica rifiutata per ${this.chat.escapeHtml(diff.filePath)}</span>`;
      });
    }
  }

  renderDiffPreview(diff) {
    const lines = diff.diffText.split('\n');
    return lines.map(line => {
      if (line.startsWith('+')) return `<span style="color: #4ade80;">${this.chat.escapeHtml(line)}</span>`;
      if (line.startsWith('-')) return `<span style="color: #f87171;">${this.chat.escapeHtml(line)}</span>`;
      return `<span style="color: var(--text-muted);">${this.chat.escapeHtml(line)}</span>`;
    }).join('\n');
  }

  validateFilePath(filePath) {
    if (!filePath || !filePath.trim()) {
      return { ok: false, error: 'Path vuoto' };
    }
    // Allow the exact current file (normalized comparison)
    const normalize = p => p.replace(/\\/g, '/').toLowerCase();
    const currentFile = this.editor?.currentFile;
    if (currentFile && normalize(filePath) === normalize(currentFile)) {
      return { ok: true };
    }
    // Reject path traversal components
    if (filePath.includes('..')) {
      return { ok: false, error: `Path rifiutata: path traversal rilevato in '${filePath}'` };
    }
    // Reject absolute paths that don't match the current file
    if (/^[a-zA-Z]:/.test(filePath) || filePath.startsWith('/')) {
      return { ok: false, error: `Path rifiutata: percorso assoluto '${filePath}'` };
    }
    return { ok: true };
  }

  async applyDiff(diff, snapshot) {
    try {
      // Validate file path against path traversal
      const validation = this.validateFilePath(diff.filePath);
      if (!validation.ok) {
        this.chat.addMessage('system', `Sicurezza: ${validation.error}`);
        return;
      }

      // Get the new content: if diff has newContent, use it directly
      if (diff.newContent) {
        await window.api.fsWriteFile(diff.filePath, diff.newContent);
        if (this.editor.currentFile === diff.filePath) {
          this.editor.setContent(diff.newContent);
        }
        return;
      }

      // Otherwise, apply unified diff manually
      const currentContent = snapshot.content;
      const result = await this.applyUnifiedDiff(currentContent, diff.diffText);

      if (result.error) {
        this.chat.addMessage('system', `Errore applicazione diff: ${result.error}`);
        return;
      }

      await window.api.fsWriteFile(diff.filePath, result.content);
      if (this.editor.currentFile === diff.filePath) {
        this.editor.setContent(result.content);
      }
    } catch (e) {
      this.chat.addMessage('system', `Errore: ${e.message}`);
    }
  }

  applyUnifiedDiff(originalContent, diffText) {
    try {
      const originalLines = originalContent.split('\n');
      const diffLines = diffText.split('\n');
      const resultLines = [...originalLines];
      const hunks = []; // { startIndex, deleteCount, newLines[] }
      let currentHunk = null;
      let originalLineNum = -1;

      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];

        if (line.startsWith('@@')) {
          const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (match) {
            originalLineNum = parseInt(match[1]) - 1; // 0-based
            currentHunk = { startIndex: originalLineNum, deleteCount: 0, newLines: [] };
            hunks.push(currentHunk);
          }
          continue;
        }

        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
          continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('-')) {
          currentHunk.deleteCount++;
          originalLineNum++;
        } else if (line.startsWith('+')) {
          currentHunk.newLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
          // Context line: counts as both a deletion and an insertion to preserve it
          currentHunk.deleteCount++;
          currentHunk.newLines.push(line.substring(1));
          originalLineNum++;
        } else if (line === '\\ No newline at end of file') {
          continue;
        }
      }

      // Apply hunks in reverse order so later hunks don't shift earlier indices
      for (let i = hunks.length - 1; i >= 0; i--) {
        const hunk = hunks[i];
        resultLines.splice(hunk.startIndex, hunk.deleteCount, ...hunk.newLines);
      }

      return { content: resultLines.join('\n') };
    } catch (e) {
      return { error: e.message };
    }
  }

  undo(snapshot) {
    window.api?.fsWriteFile(snapshot.path, snapshot.content);
    if (this.editor.currentFile === snapshot.path) {
      this.editor.setContent(snapshot.content);
    }
    this.chat.addMessage('system', `Undo: ripristinato ${snapshot.path}`);
  }
}
