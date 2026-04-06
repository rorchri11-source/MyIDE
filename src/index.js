import SettingsManager from './core/settings.js';
import ChatUI from './ui/ChatUI.js';
import EditorUI from './ui/EditorUI.js';
import FileTree from './ui/FileTree.js';
import SplitView from './ui/SplitView.js';
import { buildEffortPrompt } from './core/effort-prompts.js';
import TerminalUI from './ui/TerminalUI.js';
import ModeManager from './modes/ModeManager.js';
import AgentRunner from './core/agent-runner.js';
import EditModeRunner from './core/edit-mode-runner.js';
import MCPClient from './core/mcp-client.js';

const PROVIDER_TEMPLATES = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-20250514',
    systemPrompt: 'You are a helpful coding assistant. Respond in the language the user writes in.',
    temperature: 0.7,
    maxTokens: 4096,
    maxContextTokens: 128000,
    thinking: false,
    thinkingBudget: 16384,
    description: 'Accesso a 100+ modelli con un\'unica API chiave. Paga per token.'
  },
  'google-ai-studio': {
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    systemPrompt: 'You are a helpful coding assistant. Respond in the language the user writes in.',
    temperature: 0.7,
    maxTokens: 8192,
    maxContextTokens: 1048576,
    thinking: false,
    thinkingBudget: 16384,
    description: 'API gratuita di Google. Gemini 2.5 ha 1M token di contesto.'
  }
};

/**
 * Preset automatici per modelli noti — impostano maxContextTokens in base al modello.
 * Se il modello non e' riconosciuto, usa un default di 128000.
 * Chiavi: pattern (regex) o matching esatto sul nome del modello.
 */
const MODEL_CONTEXT_PRESETS = [
  { pattern: /qwen.*3\.6.*plus/i, maxContextTokens: 1000000, label: 'Qwen 3.6 Plus (1M)' },
  { pattern: /qwen.*3\.6/i, maxContextTokens: 256000, label: 'Qwen 3.6 (256K)' },
  { pattern: /qwen.*2\.5.*coder/i, maxContextTokens: 131072, label: 'Qwen 2.5 Coder (128K)' },
  { pattern: /qwen/i, maxContextTokens: 131072, label: 'Qwen (128K)' },
  { pattern: /claude.*opus/i, maxContextTokens: 200000, label: 'Claude Opus (200K)' },
  { pattern: /claude.*sonnet/i, maxContextTokens: 200000, label: 'Claude Sonnet (200K)' },
  { pattern: /claude/i, maxContextTokens: 200000, label: 'Claude (200K)' },
  { pattern: /gpt-4o/i, maxContextTokens: 128000, label: 'GPT-4o (128K)' },
  { pattern: /gpt-4/i, maxContextTokens: 8192, label: 'GPT-4 (8K)' },
  { pattern: /gemini.*2\.5/i, maxContextTokens: 1048576, label: 'Gemini 2.5 (1M)' },
  { pattern: /gemini/i, maxContextTokens: 32768, label: 'Gemini (32K)' },
  { pattern: /llama.*3/i, maxContextTokens: 131072, label: 'Llama 3 (128K)' },
  { pattern: /deepseek/i, maxContextTokens: 131072, label: 'DeepSeek (128K)' },
  { pattern: /mistral/i, maxContextTokens: 32768, label: 'Mistral (32K)' },
];

function detectModelPreset(modelName) {
  if (!modelName) return null;
  for (const preset of MODEL_CONTEXT_PRESETS) {
    if (preset.pattern.test(modelName)) return preset;
  }
  return null;
}

/**
 * Global error handler - previene crash del renderer
 */
window.addEventListener('error', (e) => {
  console.error('Global error:', e.message, e.filename, e.lineno);
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  e.preventDefault();
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = `Async error: ${e.reason?.message || 'unknown'}`;
  e.preventDefault();
});

class App {
  constructor() {
    this.settings = new SettingsManager();
    this.chat = null;
    this.modeManager = null;
    this.editor = null;
    this.splitView = null;
    this.terminal = null;
    this.agent = null;
  }

  async init() {
    try {
      await this.settings.load();
      this.terminal = new TerminalUI();
      this.editor = new EditorUI();
      this.fileTree = new FileTree(async (filePath) => {
        if (this.editor) await this.editor.openFile(filePath);
      });
      this.chat = new ChatUI(this.settings);
      this.modeManager = new ModeManager(this.settings, this.editor, this.chat);
      this.chat.setModeManager(this.modeManager);
      this.mcp = new MCPClient();
      this.agent = new AgentRunner(this.chat, this.modeManager, this.settings, this.mcp);
      this.chat.setAgent(this.agent);
      this.editMode = new EditModeRunner(this.chat, this.modeManager, this.editor);
      this.chat.setEditMode(this.editMode);

      const self = this;
      this.chat.onFileCreated(async (filePath, content) => {
        if (window.api && self.editor) {
          try {
            const exists = await window.api.fsExists(filePath);
            if (exists) await self.editor.openFile(filePath);
          } catch (e) { /* ignore */ }
        }
      });

      this.bindTopbarEvents();
      this.bindSettingsModal();
      this.bindProviderModal();
      this.bindKeyboardShortcuts();
      this.updateProviderSelect();
      this.updateModeSelect();

      // Show help modal on first run if no providers configured
      if (Object.keys(this.settings.getProviders()).length === 0) {
        setTimeout(() => this.showFirstRunHelp(), 500);
      }

      const chatPanel = document.getElementById('chat-panel');

      const editorContainer = document.getElementById('editor-container');
      if (chatPanel && editorContainer) {
        this.splitView = new SplitView(chatPanel, editorContainer);
      } else {
        console.warn('[App] SplitView elements missing');
      }
    } catch (error) {
      console.error('App init error:', error);
      const statusEl = document.getElementById('status-text');
      if (statusEl) statusEl.textContent = `Error: ${error.message}`;
    }
  }

  bindTopbarEvents() {
    const setListener = (id, event, handler) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener(event, handler);
      } else {
        console.warn(`[App] Element #${id} not found`);
      }
    };

    setListener('btn-open-folder', 'click', async () => {
      try {
        const result = await window.api.fsOpenFolder();
        if (result.ok) {
          await this.fileTree.loadFolder(result.path);
          const folderEl = document.getElementById('current-folder');
          if (folderEl) folderEl.textContent = result.path;
          const sidebar = document.getElementById('sidebar');
          if (sidebar) sidebar.classList.remove('hidden');
          if (this.terminal) this.terminal.cwd = result.path;
          if (window.api.fsSetProjectRoot) {
            await window.api.fsSetProjectRoot(result.path);
          }
        }
      } catch (e) {
        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.textContent = 'Open folder error';
      }
    });

    setListener('btn-close-sidebar', 'click', () => {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.add('hidden');
    });

    setListener('provider-select', 'change', (e) => {
      const newProvider = e.target.value || null;
      this.settings.setActiveProvider(newProvider);
      this.settings.save().catch(() => {});
      if (this.chat) this.chat.resetClient();
    });

    setListener('mode-select', 'change', (e) => {
      try {
        const newMode = e.target.value;
        this.modeManager.setMode(newMode);
        document.getElementById('status-text').textContent = `Mode: ${this.modeManager.getInfo().name}`;
        setTimeout(() => { document.getElementById('status-text').textContent = 'Ready'; }, 2000);
      } catch (e) { /* ignore */ }
    });

    setListener('template-select', 'change', (e) => {
      if (this.modeManager) {
        this.modeManager.setTemplate(e.target.value);
      }
    });

    setListener('effort-select', 'change', (e) => {
      if (this.modeManager) {
        this.modeManager.setEffort(e.target.value);
      }
    });

    setListener('btn-font-increase', 'click', () => this.changeFontSize(1));
    setListener('btn-font-decrease', 'click', () => this.changeFontSize(-1));

    setListener('btn-new-chat', 'click', () => {
      if (this.chat) this.chat.clear();
    });

    setListener('btn-chat-history', 'click', () => {
      if (this.chat) this.chat.showChatHistory();
    });

    setListener('btn-token-info', 'click', () => {
      this.showTokenPanel();
    });

    setListener('btn-close-token-panel', 'click', () => {
      document.getElementById('token-panel')?.classList.add('hidden');
    });

    setListener('btn-help', 'click', () => {
      document.getElementById('help-modal')?.classList.remove('hidden');
    });

    setListener('btn-close-help', 'click', () => {
      document.getElementById('help-modal')?.classList.add('hidden');
    });

    setListener('token-display', 'click', () => {
      if (this.chat) this.chat.showTokenDashboard();
    });

    // ─── Effort Editor ───
    setListener('btn-effort-editor', 'click', () => {
      this.openEffortEditor();
    });

    setListener('btn-close-effort-editor', 'click', () => {
      document.getElementById('effort-editor-modal')?.classList.add('hidden');
    });

    setListener('btn-apply-effort', 'click', () => {
      this.applyEffortConfig();
    });

    setListener('btn-reset-effort', 'click', () => {
      this.resetEffortToDefault();
    });

    setListener('effort-preset-select', 'change', (e) => {
      this.updateEffortPreview(e.target.value);
    });

    setListener('effort-use-custom', 'change', (e) => {
      document.getElementById('effort-custom-textarea').disabled = !e.target.checked;
      document.getElementById('effort-preview-textarea').disabled = e.target.checked;
    });
  }

  openEffortEditor() {
    const modal = document.getElementById('effort-editor-modal');
    if (!modal) return;

    // Populate preset preview
    const presetSelect = document.getElementById('effort-preset-select');
    this.updateEffortPreview(presetSelect?.value || 'medium');

    // Check if custom effort is active
    const isCustom = this.modeManager?.selectedEffort === 'custom';
    document.getElementById('effort-use-custom').checked = !!isCustom;
    document.getElementById('effort-custom-textarea').value = this.modeManager?.customEffortText || '';
    document.getElementById('effort-custom-textarea').disabled = !isCustom;
    document.getElementById('effort-preview-textarea').disabled = isCustom;

    modal.classList.remove('hidden');
  }

  updateEffortPreview(level) {
    const preview = document.getElementById('effort-preview-textarea');
    if (!preview) return;

    if (level === 'custom') {
      preview.value = document.getElementById('effort-custom-textarea')?.value || '';
    } else {
      preview.value = buildEffortPrompt(level);
    }
  }

  applyEffortConfig() {
    const useCustom = document.getElementById('effort-use-custom')?.checked;
    const customText = document.getElementById('effort-custom-textarea')?.value?.trim();

    if (useCustom && customText) {
      this.modeManager?.setEffort('custom');
      this.modeManager?.setCustomEffortText(customText);
      this.chat?.showToast('Custom prompt applied', 'success');
    } else {
      const level = document.getElementById('effort-preset-select')?.value || 'medium';
      this.modeManager?.setEffort(level);
      this.modeManager?.setCustomEffortText('');
      const label = document.querySelector(`#effort-preset-select option[value="${level}"]`)?.textContent || level;
      this.chat?.showToast(`Effort: ${label}`, 'success');
    }

    document.getElementById('effort-editor-modal')?.classList.add('hidden');
  }

  resetEffortToDefault() {
    this.modeManager?.setEffort('medium');
    this.modeManager?.setCustomEffortText('');
    document.getElementById('effort-preset-select') && (document.getElementById('effort-preset-select').value = 'medium');
    document.getElementById('effort-use-custom') && (document.getElementById('effort-use-custom').checked = false);
    document.getElementById('effort-custom-textarea') && (document.getElementById('effort-custom-textarea').value = '');
    document.getElementById('effort-custom-textarea') && (document.getElementById('effort-custom-textarea').disabled = true);
    this.updateEffortPreview('medium');
    this.chat?.showToast('Effort reset to default', 'info');
  }

  changeFontSize(delta) {
    const editor = document.querySelector('.code-textarea');
    if (!editor) return;
    let size = parseInt(getComputedStyle(editor).fontSize, 10);
    size = Math.max(10, Math.min(24, size + delta));
    editor.style.fontSize = `${size}px`;
    const style = document.getElementById('dynamic-font-style');
    if (style) style.remove();
    const s = document.createElement('style');
    s.id = 'dynamic-font-style';
    s.textContent = `.code-textarea { font-size: ${size}px !important; } .message { font-size: ${Math.max(11, size - 2)}px !important; }`;
    document.head.appendChild(s);
  }

  bindSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const openBtn = document.getElementById('btn-settings');
    const closeBtn = document.getElementById('btn-close-settings');

    if (!openBtn) {
      console.warn('[App] Element #btn-settings not found');
    } else {
      openBtn.addEventListener('click', () => {
        modal?.classList.remove('hidden');
        this.updateProviderList();
      });
    }

    if (!closeBtn) {
      console.warn('[App] Element #btn-close-settings not found');
    } else {
      closeBtn.addEventListener('click', () => modal?.classList.add('hidden'));
    }

    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const el = document.getElementById(`tab-${tab.dataset.tab}`);
        if (el) el.classList.add('active');
        if (tab.dataset.tab === 'providers') this.updateProviderList();
        if (tab.dataset.tab === 'mcp') this.updateMCPTab();
      });
    });

    const prefs = this.settings.getPreferences();
    const modeEl = document.getElementById('pref-default-mode');
    const autoEl = document.getElementById('pref-auto-apply');
    if (modeEl && prefs.defaultMode) modeEl.value = prefs.defaultMode;
    if (autoEl && prefs.autoApply) autoEl.value = prefs.autoApply;

    modeEl?.addEventListener('change', async (e) => {
      this.settings.setPreferences({ defaultMode: e.target.value });
      await this.settings.save().catch(() => {});
    });
    autoEl?.addEventListener('change', async (e) => {
      this.settings.setPreferences({ autoApply: e.target.value });
      await this.settings.save().catch(() => {});
    });
  }

  updateMCPTab() {
    const listEl = document.getElementById('mcp-servers-list');
    const statusEl = document.getElementById('mcp-status');
    if (!listEl) return;

    listEl.innerHTML = '';
    const mcpServers = this.settings.getPreferences().mcpServers || {};

    for (const [id, config] of Object.entries(mcpServers)) {
      const item = document.createElement('div');
      item.className = 'provider-item';
      item.dataset.mcpId = id;
      item.innerHTML = `
        <div class="provider-info">
          <div class="provider-name">${this._esc(config.name || id)}</div>
          <div class="provider-model">${this._esc(config.command + ' ' + (config.args || []).join(' '))}</div>
        </div>
        <button class="btn-small mcp-remove-btn" data-mcp-id="${this._esc(id)}">Remove</button>
      `;
      item.querySelector('.mcp-remove-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        delete mcpServers[id];
        this.settings.setPreferences({ mcpServers });
        await this.settings.save().catch(() => {});
        await window.api.mcpDisconnect(id).catch(() => {});
        item.remove();
      });
      listEl.appendChild(item);
    }

    if (Object.keys(mcpServers).length === 0) {
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted)">No MCP servers. Add one to extend AI capabilities.</div>';
    }

    const addMcpBtn = document.getElementById('btn-add-mcp');
    if (!addMcpBtn) return;
    addMcpBtn.replaceWith(addMcpBtn.cloneNode(true));
    document.getElementById('btn-add-mcp').addEventListener('click', () => {
      const name = prompt('Server name (e.g. filesystem, web-search):');
      if (!name) return;
      const command = prompt('Command to run server (e.g. npx, node):');
      if (!command) return;
      const args = prompt('Args (comma separated, leave empty for none):') || '';
      const updated = this.settings.getPreferences().mcpServers || {};
      updated[name] = { name, command, args: args.split(',').map(a => a.trim()).filter(Boolean) };
      this.settings.setPreferences({ mcpServers: updated });
      this.settings.save();
      this.updateMCPTab();
    });

    const connectAllBtn = document.getElementById('btn-mcp-connect-all');
    if (!connectAllBtn) return;
    connectAllBtn.replaceWith(connectAllBtn.cloneNode(true));
    document.getElementById('btn-mcp-connect-all').addEventListener('click', async () => {
      for (const config of Object.values(mcpServers)) {
        this.mcp.addServer(config.name || config.command, config);
      }
      await this.mcp.connect();
      const status = this.mcp.getStatus();
      statusEl.textContent = 'Status: ' + JSON.stringify(status, null, 2);
    });
  }

  bindProviderModal() {
    const modal = document.getElementById('provider-modal');
    const addBtn = document.getElementById('btn-add-provider');
    const closeBtn = document.getElementById('btn-close-provider-modal');
    const saveBtn = document.getElementById('btn-save-provider');
    const deleteBtn = document.getElementById('btn-delete-provider');

    // Guard: if critical buttons are missing, the modal will be non-functional but won't crash
    if (!addBtn) {
      console.warn('[App] Element #btn-add-provider not found');
      return;
    }
    if (!closeBtn) {
      console.warn('[App] Element #btn-close-provider-modal not found');
      return;
    }
    if (!saveBtn) {
      console.warn('[App] Element #btn-save-provider not found');
      return;
    }

    addBtn.addEventListener('click', () => {
      document.getElementById('provider-modal-title').textContent = 'Add Provider';
      document.getElementById('cfg-template').value = '';
      document.getElementById('provider-edit-id').value = '';
      document.getElementById('cfg-name').value = '';
      document.getElementById('cfg-base-url').value = 'https://openrouter.ai/api/v1';
      document.getElementById('cfg-api-key').value = '';
      document.getElementById('cfg-model').value = '';
      document.getElementById('cfg-system-prompt').value = '';
      document.getElementById('cfg-temperature').value = '0.7';
      document.getElementById('cfg-max-tokens').value = '4096';
      document.getElementById('cfg-max-context-tokens').value = '128000';
      document.getElementById('cfg-thinking').checked = false;
      document.getElementById('cfg-thinking-budget').value = '16384';
      deleteBtn.classList.add('hidden');
      modal.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

    saveBtn.addEventListener('click', async () => {
      try {
        const id = document.getElementById('provider-edit-id').value || `provider_${Date.now()}`;
        const config = {
          name: document.getElementById('cfg-name').value,
          baseUrl: document.getElementById('cfg-base-url').value,
          apiKey: document.getElementById('cfg-api-key').value,
          model: document.getElementById('cfg-model').value,
          systemPrompt: document.getElementById('cfg-system-prompt').value,
          temperature: parseFloat(document.getElementById('cfg-temperature').value) || 0.7,
          maxTokens: parseInt(document.getElementById('cfg-max-tokens').value) || 4096,
          maxContextTokens: (() => {
          const val = document.getElementById('cfg-max-context-tokens').value;
          if (val && val !== '') return parseInt(val); // user typed something, trust it
          const preset = detectModelPreset(document.getElementById('cfg-model').value);
          return preset ? preset.maxContextTokens : 128000;
        })(),
          thinking: document.getElementById('cfg-thinking').checked,
          thinkingBudget: parseInt(document.getElementById('cfg-thinking-budget').value) || 16384
        };
        if (!config.name) return alert('Provider name is required');

        this.settings.setProvider(id, config);
        this.settings.setActiveProvider(id);

        console.log('[Settings] Before save - providers:', Object.keys(this.settings.getProviders()));
        console.log('[Settings] Before save - active:', this.settings.getActiveProvider());

        await this.settings.save();

        this.updateProviderList();
        this.updateProviderSelect();
        modal.classList.add('hidden');
        if (this.chat) this.chat.resetClient();
      } catch (e) {
        alert('Error saving provider: ' + e.message);
      }
    });

    deleteBtn.addEventListener('click', async () => {
      try {
        const id = document.getElementById('provider-edit-id').value;
        if (id && confirm('Delete this provider?')) {
          this.settings.deleteProvider(id);
          await this.settings.save();
          this.updateProviderList();
          this.updateProviderSelect();
          modal.classList.add('hidden');
          if (this.chat) this.chat.resetClient();
        }
      } catch (e) { /* ignore */ }
    });

    // Template auto-fill
    const templateSelect = document.getElementById('cfg-template');
    templateSelect?.addEventListener('change', () => {
      const tmpl = templateSelect.value;
      if (!tmpl || !PROVIDER_TEMPLATES[tmpl]) return;
      const t = PROVIDER_TEMPLATES[tmpl];
      document.getElementById('cfg-name').value = t.name;
      document.getElementById('cfg-base-url').value = t.baseUrl;
      document.getElementById('cfg-model').value = t.model;
      document.getElementById('cfg-system-prompt').value = t.systemPrompt;
      document.getElementById('cfg-temperature').value = String(t.temperature);
      document.getElementById('cfg-max-tokens').value = String(t.maxTokens);
      document.getElementById('cfg-max-context-tokens').value = String(t.maxContextTokens);
      document.getElementById('cfg-thinking').checked = t.thinking;
      document.getElementById('cfg-thinking-budget').value = String(t.thinkingBudget);
      const preset = detectModelPreset(t.model);
      if (preset) console.log('[Template] Auto-set context tokens:', preset.label);
    });

    // Auto-detect model preset quando l'utente digita il modello
    const modelInput = document.getElementById('cfg-model');
    const ctxInput = document.getElementById('cfg-max-context-tokens');
    modelInput?.addEventListener('input', () => {
      const preset = detectModelPreset(modelInput.value);
      if (preset) {
        ctxInput.value = String(preset.maxContextTokens);
        ctxInput.style.borderColor = 'var(--green)';
        ctxInput.style.boxShadow = '0 0 4px var(--green)';
        setTimeout(() => { ctxInput.style.borderColor = ''; ctxInput.style.boxShadow = ''; }, 2000);
      }
    });
  }

  updateProviderList() {
    try {
      const listEl = document.getElementById('providers-list');
      if (!listEl) return;
      const providers = this.settings.getProviders();
      const activeId = this.settings.getActiveProvider();
      listEl.innerHTML = '';

      for (const [id, provider] of Object.entries(providers)) {
        const item = document.createElement('div');
        item.className = 'provider-item' + (id === activeId ? ' active-provider' : '');
        item.innerHTML = `
          <div class="provider-info">
            <div class="provider-name">${this._esc(provider.name)}</div>
            <div class="provider-model">${this._esc(provider.model || 'no model set')}</div>
          </div>
          <button class="btn-small delete-provider-btn" style="background:var(--red);color:#fff;border:none;padding:4px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:11px;">Delete</button>
        `;
        item.querySelector('.delete-provider-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Delete provider "${provider.name}"?`)) {
            this.settings.deleteProvider(id);
            await this.settings.save();
            this.updateProviderList();
            this.updateProviderSelect();
            if (this.chat) this.chat.resetClient();
          }
        });
        item.addEventListener('click', async () => {
          this.settings.setActiveProvider(id);
          await this.settings.save().catch(() => {});
          this.updateProviderList();
          this.updateProviderSelect();
        });
        item.addEventListener('dblclick', () => this.editProvider(id));
        listEl.appendChild(item);
      }

      if (Object.keys(providers).length === 0) {
        listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted)">No providers. Click "+ Add Provider".</div>';
      }
    } catch (e) { /* ignore */ }
  }

  editProvider(id) {
    try {
      const providers = this.settings.getProviders();
      const provider = providers[id];
      if (!provider) return;

      document.getElementById('provider-modal-title').textContent = 'Edit Provider';
      document.getElementById('provider-edit-id').value = id;
      document.getElementById('cfg-name').value = provider.name || '';
      document.getElementById('cfg-base-url').value = provider.baseUrl || '';
      document.getElementById('cfg-api-key').value = provider.apiKey || '';
      document.getElementById('cfg-model').value = provider.model || '';
      document.getElementById('cfg-system-prompt').value = provider.systemPrompt || '';
      document.getElementById('cfg-temperature').value = provider.temperature ?? 0.7;
      document.getElementById('cfg-max-tokens').value = provider.maxTokens ?? 4096;
      document.getElementById('cfg-max-context-tokens').value = provider.maxContextTokens ?? 128000;
      document.getElementById('cfg-thinking').checked = provider.thinking ?? false;
      document.getElementById('cfg-thinking-budget').value = provider.thinkingBudget ?? 16384;
      document.getElementById('btn-delete-provider').classList.remove('hidden');
      document.getElementById('provider-modal').classList.remove('hidden');
    } catch (e) { /* ignore */ }
  }

  updateProviderSelect() {
    try {
      const select = document.getElementById('provider-select');
      if (!select) return;
      const providers = this.settings.getProviders();
      const activeId = this.settings.getActiveProvider();
      select.innerHTML = '<option value="">-- Select Provider --</option>';
      for (const [id, provider] of Object.entries(providers)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = provider.name;
        if (id === activeId) opt.selected = true;
        select.appendChild(opt);
      }
      if (activeId && providers[activeId]) {
        const modelEl = document.getElementById('model-input');
        if (modelEl) modelEl.value = providers[activeId].model || '';
      }
    } catch (e) { /* ignore */ }
  }

  updateModeSelect() {
    const select = document.getElementById('mode-select');
    if (select) select.value = 'chat';
    const tmplSelect = document.getElementById('template-select');
    if (tmplSelect) tmplSelect.value = 'none';
  }

  _esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showTokenPanel() {
    const panel = document.getElementById('token-panel');
    const content = document.getElementById('token-panel-content');
    if (!panel || !content) return;

    const provider = this.settings?.getActiveProviderConfig();
    const history = this.chat?.chatHistory || [];
    const modelTokens = history.reduce((sum, m) => sum + ((m.role === 'assistant' ? m.content?.length || 0 : 0)), 0);
    const approxTokens = Math.round(modelTokens / 4);

    let html = `<div style="margin-bottom:12px;">`;
    html += `<p><strong>Provider:</strong> ${this._esc(provider?.name || 'Nessuno selezionato')}</p>`;
    html += `<p><strong>Modello:</strong> ${this._esc(provider?.model || 'Non impostato')}</p>`;
    html += `<p><strong>Max Context Tokens:</strong> ${provider?.maxContextTokens?.toLocaleString() || '128,000'}</p>`;
    html += `<p><strong>Messaggi in chat:</strong> ${history.length}</p>`;
    html += `<p><strong>Tokens stimati (output):</strong> ~${approxTokens.toLocaleString()} (${(approxTokens / 1000).toFixed(1)}K)</p>`;
    if (provider?.maxContextTokens) {
      const pct = Math.round((approxTokens / provider.maxContextTokens) * 100);
      const color = pct > 80 ? 'var(--red-light)' : pct > 50 ? 'var(--amber)' : 'var(--green)';
      html += `<p style="color:${color}"><strong>Utilizzo:</strong> ${pct}%</p>`;
    }
    html += `</div>`;
    html += `<div style="font-size:12px;color:var(--text-muted);">
      <p><strong>Nota:</strong> I token sono stimati (~4 caratteri/token). Il conteggio preciso dipende dal modello.</p>
    </div>`;

    content.innerHTML = html;
    panel.classList.remove('hidden');
  }

  showFirstRunHelp() {
    document.getElementById('help-modal')?.classList.remove('hidden');
  }

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (this.editor) this.editor.saveFile().catch(() => {});
        document.getElementById('status-text').textContent = 'File saved';
        setTimeout(() => { document.getElementById('status-text').textContent = 'Ready'; }, 2000);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        if (this.chat) this.chat.clear();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        this.terminal.toggle();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        document.getElementById('sidebar').classList.toggle('hidden');
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        if (this.chat) this.chat.exportChatAsMd();
      }
    });
  }
}

const app = new App();
app.init().catch(err => {
  console.error('Failed to initialize app:', err);
  const status = document.getElementById('status-text');
  if (status) status.textContent = 'Initialization failed: ' + err.message;
});
