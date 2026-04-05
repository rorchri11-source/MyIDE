import SettingsManager from './settings.js';

function validateConfig(config) {
  if (!config?.baseUrl) throw new Error('Configurazione mancante: URL base del provider. Apri le impostazioni.');
  if (!config?.apiKey) throw new Error('Configurazione mancante: API key del provider. Apri le impostazioni.');
  if (!config?.model) throw new Error('Configurazione mancante: modello AI del provider. Apri le impostazioni.');
}

/**
 * Client AI che comunica con il main process via IPC.
 * Le chiamate HTTP partono dal main process (Node.js) — nessun CORS.
 * Streaming gestito via eventi ai:chunk dal main process.
 * Usa request-scoped content per evitare race condition tra chiamate concorrenti.
 */
export default class AIClient {
  constructor(providerConfig) {
    this.config = providerConfig;
    this._pendingRequest = null; // { content, onChunk, resolve, reject }
    this._listenerId = null; // ID of the registered ai:chunk listener

    // Listen for streaming chunks — route to active request
    if (window.api && window.api.onAiChunk) {
      this._listenerId = window.api.onAiChunk((data) => {
        if (data.content && this._pendingRequest) {
          this._pendingRequest.content += data.content;
          if (this._pendingRequest.onChunk) {
            this._pendingRequest.onChunk(data.content, this._pendingRequest.content);
          }
        }
      });
    }
  }

  /**
   * Invia messaggi al provider. La risposta completa viene tornata.
   * Durante la chiamata, gli aggiornamenti streaming sono chiamati via onChunk.
   */
  async send(messages, onChunk) {
    validateConfig(this.config);

    if (this._pendingRequest) {
      throw new Error('Richiesta AI gia in corso. Completa o annulla la richiesta prima di inviarne una nuova.');
    }

    const req = { content: '', onChunk };
    this._pendingRequest = req;

    try {
      const result = await window.api.aiSend(this.config, messages);

      if (result.error) {
        throw new Error(result.error);
      }

      return result.content || req.content || '';
    } finally {
      if (this._pendingRequest === req) {
        this._pendingRequest = null;
      }
    }
  }

  cancel() {
    if (this._pendingRequest) {
      if (window.api && window.api.aiCancel) {
        window.api.aiCancel().catch(() => {});
      }
      this._pendingRequest = null;
    }
  }

  destroy() {
    if (this._listenerId != null && window.api && window.api.aiRemoveChunkListener) {
      window.api.aiRemoveChunkListener(this._listenerId);
      this._listenerId = null;
    }
    this.cancel();
  }

  getSystemPrompt() {
    return this.config.systemPrompt || 'You are a helpful coding assistant.';
  }
}

/**
 * Factory per creare client AI dalla configurazione attiva.
 */
export class AIClientFactory {
  static async createFromSettings(existingSettings = null) {
    const settings = existingSettings || new SettingsManager();
    if (!existingSettings) await settings.load();

    const providers = settings.getProviders();
    const activeId = settings.getActiveProvider();

    if (!activeId || !providers[activeId]) {
      throw new Error('Nessun provider attivo. Configura un provider nelle impostazioni.');
    }

    const provider = providers[activeId];
    return new AIClient(provider);
  }

  static createFromProvider(providerConfig) {
    return new AIClient(providerConfig);
  }
}

// AIClient.prototype.sendWithToolUse — aggiunto qui per estendere la classe
AIClient.prototype.sendWithToolUse = async function (messages, tools, onChunk) {
  validateConfig(this.config);

  if (this._pendingRequest) {
    throw new Error('Richiesta AI gia in corso. Completa o annulla la richiesta prima di inviarne una nuova.');
  }

  const req = { content: '', onChunk };
  this._pendingRequest = req;

  try {
    const result = await window.api.aiSendWithTools(this.config, messages, tools);

    if (result.error) {
      throw new Error(result.error);
    }

    // Propagate both content and tool_calls from the main process response
    const content = result.content || req.content || '';
    return { content, tool_calls: result.tool_calls || null };
  } finally {
    if (this._pendingRequest === req) {
      this._pendingRequest = null;
    }
  }
};
