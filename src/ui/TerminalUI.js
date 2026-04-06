/**
 * Pannello terminale integrato (output comandi)
 */
export default class TerminalUI {
  constructor() {
    this.outputEl = null;
    this.inputEl = null;
    this.container = null;
    this.isVisible = false;
    this.history = [];
    this.historyIndex = -1;
    this.cwd = '';
  }

  createPanel() {
    const container = document.createElement('div');
    container.id = 'terminal-panel';
    container.className = 'terminal-panel';
    container.innerHTML = `
      <div class="terminal-header">
        <span class="terminal-title">Terminal</span>
        <div class="terminal-actions">
          <button id="btn-clear-terminal" class="btn-terminal-small">Clear</button>
          <button id="btn-close-terminal" class="btn-terminal-small">x</button>
        </div>
      </div>
      <div id="terminal-output" class="terminal-output"></div>
      <div class="terminal-input-line">
        <span id="terminal-prompt" class="terminal-prompt">$ </span>
        <input id="terminal-input" class="terminal-input" type="text" placeholder="Enter command..." autocomplete="off" spellcheck="false">
      </div>
    `;

    // Add the panel to the document
    const appEl = document.getElementById('app');
    const bottomBar = document.getElementById('bottombar');
    if (!appEl || !bottomBar) {
      console.error('TerminalUI: #app or #bottombar element not found');
      return;
    }
    appEl.insertBefore(container, bottomBar);

    this.container = container;
    this.outputEl = container.querySelector('#terminal-output');
    this.inputEl = container.querySelector('#terminal-input');
    this.promptEl = container.querySelector('#terminal-prompt');

    // Bind events
    container.querySelector('#btn-close-terminal').addEventListener('click', () => this.hide());
    container.querySelector('#btn-clear-terminal').addEventListener('click', () => this.clear());

    this.inputEl.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const cmd = this.inputEl.value.trim();
        if (cmd) {
          this.history.push(cmd);
          this.historyIndex = this.history.length;
          await this.execute(cmd);
        }
        this.inputEl.value = '';
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.inputEl.value = this.history[this.historyIndex];
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.inputEl.value = this.history[this.historyIndex];
        } else {
          this.historyIndex = this.history.length;
          this.inputEl.value = '';
        }
      }
    });

    // Focus input on click
    container.addEventListener('click', () => this.inputEl.focus());
  }

  show() {
    if (!this.container) this.createPanel();
    this.container.classList.remove('hidden');
    this.isVisible = true;
    this.inputEl.focus();
  }

  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
    }
    this.isVisible = false;
  }

  toggle() {
    if (this.isVisible) this.hide();
    else this.show();
  }

  async execute(command) {
    this.appendLine(`$ ${command}`, 'command');

    if (command === 'clear' || command === 'cls') {
      this.clear();
      return;
    }

    if (command.startsWith('cd ')) {
      const dir = command.slice(3).trim();
      if (dir) {
        if (/^[a-zA-Z]:[\\/]/.test(dir)) {
          // Absolute Windows path — use directly
          this.cwd = dir;
        } else if (dir.startsWith('\\') && /^[a-zA-Z]:[\\/]/.test(this.cwd)) {
          // Windows relative from drive — use directly
          this.cwd = dir;
        } else if (/^\/$/.test(dir)) {
          // `cd /` on any platform — reset to project cwd
          // (project cwd is stored in this.cwd before any cd navigation)
          // We can't know the original cwd here, so just use drive root or /
          this.cwd = this.cwd ? (this.cwd.includes('\\') ? this.cwd.slice(0, 3) : '/') : '/';
        } else {
          // Relative path — resolve against current cwd
          const sep = this.cwd.includes('\\') ? '\\' : '/';
          const parts = this.cwd ? this.cwd.split(sep).filter(Boolean) : [];
          const segs = dir.split(sep).filter(Boolean);
          for (const seg of segs) {
            if (seg === '..') {
              if (parts.length > 1) parts.pop();
            } else {
              parts.push(seg);
            }
          }
          // Restore leading separator for root (e.g. C:\)
          if (this.cwd.includes('\\') && /^[a-zA-Z]:/.test(this.cwd)) {
            this.cwd = parts[0] + '\\' + parts.slice(1).join(sep);
          } else {
            this.cwd = '/' + parts.join(sep);
          }
        }
        this.updatePrompt();
      }
      return;
    }

    if (!window.api) {
      this.appendLine('Terminal API not available (running in browser)', 'error');
      return;
    }

    try {
      const result = await window.api.execCommand(command, this.cwd || null);
      if (result.stdout) this.appendLine(result.stdout, 'output');
      if (result.stderr) this.appendLine(result.stderr, 'error');
      if (!result.ok && !result.stdout && !result.stderr) {
        this.appendLine(`Command exited with code ${result.exitCode}`, 'error');
      }
    } catch (error) {
      this.appendLine(`Execution error: ${error.message}`, 'error');
    }
  }

  appendLine(text, type = 'output') {
    const line = document.createElement('div');
    line.className = `terminal-line terminal-msg-${type}`;
    line.textContent = text;
    this.outputEl.appendChild(line);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  clear() {
    this.outputEl.innerHTML = '';
  }

  updatePrompt() {
    this.promptEl.textContent = this.cwd ? `${this.cwd}> ` : '$ ';
  }
}
