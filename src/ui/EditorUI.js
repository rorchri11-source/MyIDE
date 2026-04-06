/**
 * Editor con CodeMirror 6 — syntax highlighting, auto-indent, tema scuro.
 */
import CodeEditor from './CodeEditor.js';
import { escapeHtml } from '../core/utils.js';

export default class EditorUI {
  constructor() {
    this.tabsEl = document.getElementById('editor-tabs');
    this.editorEl = document.getElementById('code-editor');
    this.fileInfoEl = document.getElementById('file-info');
    this.codeMirror = null;
    this.content = '';
    this.openTabs = {};
    this.activeTab = null;
    this.currentFile = null;
    this.onTabChange = null;
  }

  renderEditor() {
    this.codeMirror = new CodeEditor(this.editorEl);
  }

  getLanguageExt(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    return ext;
  }

  async openFile(filePath) {
    if (this.openTabs[filePath]) {
      this.switchTab(filePath);
      return;
    }

    try {
      let content = '';
      if (window.api) {
        const result = await window.api.fsReadFile(filePath);
        if (result.ok) {
          content = result.content;
        } else {
          const statusEl = document.getElementById('status-text');
          if (statusEl) statusEl.textContent = `Error: ${result.error}`;
          console.error(`Error reading file ${filePath}: ${result.error}`);
          return;
        }
      }

      this.openTabs[filePath] = { content, error: null };
      this.renderTabs();
      this.switchTab(filePath);
    } catch (e) {
      const statusEl = document.getElementById('status-text');
      if (statusEl) statusEl.textContent = `Error: ${e.message}`;
      console.error(`Error reading file ${filePath}: ${e.message}`);
      return;
    }
  }

  switchTab(filePath) {
    if (!this.tabsEl) return;
    if (this.currentFile && this.openTabs[this.currentFile] && this.codeMirror) {
      this.openTabs[this.currentFile].content = this.content;
    }

    this.currentFile = filePath;
    this.activeTab = filePath;

    document.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('active'));
    const tabEl = this.tabsEl.querySelector(`[data-path="${filePath}"]`);
    if (tabEl) tabEl.classList.add('active');

    this.content = this.openTabs[filePath].content;

    const ext = this.getLanguageExt(filePath);
    if (this.fileInfoEl) this.fileInfoEl.textContent = `${filePath} (${ext})`;

    // Destroy and recreate CodeMirror for new language
    if (this.codeMirror) this.codeMirror.destroy();
    this.codeMirror = new CodeEditor(this.editorEl);
    this.codeMirror.create(this.content, filePath);
    this.codeMirror.onChanged((doc) => {
      this.content = doc;
      if (this.openTabs[this.currentFile]) {
        this.openTabs[this.currentFile].content = doc;
      }
    });

    if (this.onTabChange) this.onTabChange(filePath);
  }

  closeTab(filePath) {
    delete this.openTabs[filePath];
    this.renderTabs();

    if (this.currentFile === filePath) {
      this.currentFile = null;
      this.activeTab = null;
      if (Object.keys(this.openTabs).length > 0) {
        this.switchTab(Object.keys(this.openTabs)[0]);
        return;
      }
      this.content = '';
      if (this.codeMirror) {
        this.codeMirror.destroy();
        this.codeMirror = null;
      }
      if (this.fileInfoEl) this.fileInfoEl.textContent = '';
      if (this.onTabChange) this.onTabChange(null);
      return;
    }

    // If we closed a background tab, and it wasn't the active one,
    // the active tab's fileInfoEl shouldn't be cleared, but it was being cleared previously.
    // The previous code did: `if (this.fileInfoEl) this.fileInfoEl.textContent = '';`
    // which was wrong, it cleared info of the STILL ACTIVE tab.
  }

  renderTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = '';
    for (const filePath of Object.keys(this.openTabs)) {
      const name = filePath.split(/[\\/]/).pop();
      const tab = document.createElement('button');
      tab.className = 'editor-tab' + (this.activeTab === filePath ? ' active' : '');
      tab.dataset.path = filePath;
      tab.innerHTML = `<span>${escapeHtml(name)}</span><span class="tab-close" data-close="${escapeHtml(filePath)}">x</span>`;
      tab.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.tab-close');
        if (closeBtn) {
          this.closeTab(closeBtn.dataset.close);
        } else {
          this.switchTab(filePath);
        }
      });
      this.tabsEl.appendChild(tab);
    }
  }

  getContent() {
    return this.codeMirror ? this.codeMirror.getDoc() : '';
  }

  setContent(text) {
    if (!this.codeMirror) return;
    this.codeMirror.setDoc(text);
    this.content = text;
    if (this.openTabs[this.currentFile]) {
      this.openTabs[this.currentFile].content = text;
    }
  }

  async saveFile() {
    if (!this.currentFile) return;
    const content = this.getContent();
    this.openTabs[this.currentFile].content = content;
    if (window.api) {
      const result = await window.api.fsWriteFile(this.currentFile, content);
      return result;
    }
  }

  destroy() {
    if (this.codeMirror) {
      this.codeMirror.destroy();
      this.codeMirror = null;
    }
    this.openTabs = {};
    this.activeTab = null;
    this.currentFile = null;
    if (this.fileInfoEl) this.fileInfoEl.textContent = '';
  }
}
