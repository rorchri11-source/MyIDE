import { getTemplatePrompt } from '../core/prompt-templates.js';
import { buildEffortPrompt, getToolExamples } from '../core/effort-prompts.js';

/**
 * Gestisce le modalità operative dell'app.
 * Ogni modalità cambia il comportamento dell'AI e l'interfaccia.
 */
export default class ModeManager {
  constructor(settings, editor, chat) {
    this.settings = settings;
    this.editor = editor;
    this.chat = chat;
    this.currentMode = 'chat';
    this.selectedTemplate = 'none';
    this.selectedEffort = 'medium';
    this.customEffortText = '';
    this.enforceReasoning = true; // if true, auto-retry when <thinking> is missing
    this.maxReasoningRetries = 2; // max auto-retries per message

    this.modeConfigs = {
      chat: {
        name: 'Chat',
        description: 'Conversazione libera con AI',
        contextInjection: 'none'
      },
      edit: {
        name: 'Edit',
        description: 'AI legge il file aperto e aiuta con modifiche',
        contextInjection: 'file'
      },
      agent: {
        name: 'Agent',
        description: 'AI agisce autonomamente: legge, crea e modifica file',
        contextInjection: 'file-tree'
      }
    };
  }

  setMode(mode) {
    if (!this.modeConfigs[mode]) return;
    const prevMode = this.currentMode;
    this.currentMode = mode;
    // Reset template on mode switch if it's mode-specific
    if (prevMode !== mode) {
      this.selectedTemplate = 'none';
    }
  }

  setTemplate(templateId) {
    this.selectedTemplate = templateId || 'none';
  }

  setEffort(effortId) {
    this.selectedEffort = effortId || 'medium';
  }

  setCustomEffortText(text) {
    this.customEffortText = text;
  }

  getEffortPrompt() {
    if (this.selectedEffort === 'custom') {
      return this.customEffortText || '';
    }
    return buildEffortPrompt(this.selectedEffort);
  }

  /**
   * Valida se la risposta AI contiene il reasoning <thinking>.
   * Ritorna true se il reasoning e' presente o se non e' richiesto.
   */
  validateReasoning(response) {
    if (this.selectedEffort === 'off') return true;
    if (!this.enforceReasoning) return true;
    // For custom effort, we should bypass validation completely since we don't know if the user asked for reasoning.
    if (this.selectedEffort === 'custom') return true;
    return response.includes('<thinking>') || response.includes('</thinking>');
  }

  /**
   * Se l'enforcement e' attivo, inietta un reminder PERSISTENTE
   * nel system prompt. Solo 1x per richiesta, NON si accumula in history.
   * Quando un messaggio con reasoning appare, rimuove il reminder.
   */
  getEnforcementReminder(chatHistory) {
    if (this.selectedEffort === 'off' || !this.enforceReasoning) return '';

    // Check ONLY assistant messages with actual text content
    const assistantMessages = (chatHistory || []).filter(m =>
      m.role === 'assistant' && (m.content || '').length > 0
    );
    if (assistantMessages.length === 0) return '';

    const missingCount = assistantMessages.filter(m => !this.validateReasoning(m.content || '')).length;
    if (missingCount === 0) return '';

    // Return a concise, persistent reminder — injected into system prompt, not history
    return `\n\n⚠️ MANDATORY: You have missed <thinking> reasoning in ${missingCount} of your previous responses.\nEvery response MUST contain <thinking> reasoning before any code or answer.\nNo exceptions. Include reasoning NOW.`;
  }

  /**
   * Crea il messaggio di correzione per un singolo retry.
   */
  buildReasoningCorrection() {
    return {
      role: 'system',
      content: `ERROR: You did NOT follow the reasoning protocol. Your response did not contain <thinking> tags.
You MUST reason inside <thinking> tags before generating the final answer.
Retry your response NOW with proper <thinking> reasoning first. Do NOT output any code or solution until you have completed your reasoning.`
    };
  }

  getTemplatePromptText() {
    return getTemplatePrompt(this.selectedTemplate);
  }

  async getContextMessages() {
    try {
      const messages = [];
      const config = this.modeConfigs[this.currentMode];
      const systemPrompt = this.chat?.client?.getSystemPrompt() || '';

      let fullPrompt = systemPrompt || 'You are a helpful coding assistant.';

      // Inject thinking + effort prompt (works in ALL modes)
      const effortPrompt = this.getEffortPrompt();
      if (effortPrompt) {
        fullPrompt += '\n\n' + effortPrompt;
      }

      // Inject tool usage examples (only when reasoning is active)
      if (this.selectedEffort !== 'off') {
        fullPrompt += '\n\n' + getToolExamples();
      }

      // Inject template prompt (works in ALL modes)
      const templatePrompt = this.getTemplatePromptText();
      if (templatePrompt) {
        fullPrompt += '\n\n' + templatePrompt;
      }

      // Inject file context based on mode-specific injection type
      const shouldInjectFile = this.currentMode === 'edit'
        || this.currentMode === 'agent'
        || (this.currentMode === 'chat' && this.selectedTemplate !== 'none');

      if (shouldInjectFile) {
        fullPrompt += '\n\n--- File Context ---\nFile: Loading...';
        if (this.currentMode === 'edit' && this.editor && this.editor.currentFile) {
          const content = this.editor.getContent();
          fullPrompt = fullPrompt.replace('--- File Context ---\nFile: Loading...',
            `--- Current File: ${this.editor.currentFile} ---\n\n\`\`\`\n${content}\n\`\`\``);
        } else if (this.currentMode === 'agent' && this.editor) {
          let contextBlock = '';
          try {
            const rootPath = this.editor.projectRoot || this.chat?.fileTree?.rootPath || null;
            if (rootPath && window.api?.fsListDir) {
              const tree = await this.buildFileTree(rootPath, '', 0, 5, 150);
              contextBlock = `Project Directory (${rootPath}):\n\`\`\`\n${tree}\n\`\`\``;
            } else {
              contextBlock = 'Project directory not available. Use absolute paths starting from the project root.';
            }
          } catch (e) {
            contextBlock = `Could not read project directory: ${e.message}`;
          }
          const tabs = Object.keys(this.editor.openTabs || {});
          if (tabs.length > 0) {
            contextBlock += '\n\n--- Open Files ---\n';
            for (const tab of tabs) {
              const tabContent = this.editor.openTabs[tab]?.content || '';
              contextBlock += `Path: ${tab}\n\`\`\`\n${tabContent}\n\`\`\`\n`;
            }
          }
          fullPrompt = fullPrompt.replace('--- File Context ---\nFile: Loading...', contextBlock.trim());
        } else if (this.currentMode === 'chat' && this.editor && this.editor.currentFile) {
          const content = this.editor.getContent();
          fullPrompt = fullPrompt.replace('--- File Context ---\nFile: Loading...',
            `--- Current File: ${this.editor.currentFile} ---\n\n\`\`\`\n${content}\n\`\`\``);
        } else {
          fullPrompt = fullPrompt.replace('--- File Context ---\nFile: Loading...', 'No file context available.');
        }
      }

      messages.push({ role: 'system', content: fullPrompt });
      return messages;
    } catch (error) {
      console.error('getContextMessages error:', error);
      return [{ role: 'system', content: 'You are a helpful coding assistant.' }];
    }
  }

  async buildFileTree(dirPath, prefix, depth, maxDepth, maxEntries) {
    let entriesCount = 0;
    const countRef = { count: 0 };
    const buildRecursive = async (dir, pfx, d, cref) => {
      if (d > maxDepth) return '';
      try {
        const result = await window.api.fsListDir(dir);
        if (!result.ok || !result.items) return '';
        let lines = '';
        const sorted = result.items.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (const item of sorted) {
          if (cref.count >= maxEntries) break;
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;
          cref.count++;
          lines += `${pfx}${item.name}${item.isDirectory ? '/' : ''}\n`;
          if (item.isDirectory) {
            lines += await buildRecursive(item.path, pfx + '  ', d + 1, cref);
          }
        }
        return lines;
      } catch (e) {
        return `${pfx}(error: ${e.message})\n`;
      }
    };
    return await buildRecursive(dirPath, prefix, 0, countRef);
  }

  getInfo() {
    return this.modeConfigs[this.currentMode];
  }

  getCurrentMode() {
    return this.currentMode;
  }

  getMaxContextTokens() {
    const provider = this.settings?.getActiveProviderConfig();
    return provider?.maxContextTokens ?? 128000;
  }
}
