/**
 * Gestione settings: solo dal main process (file su disco).
 * Niente localStorage — elimina il problema della corruzione.
 */

function deepMergeDefaults(raw, defaults) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    if (key in raw && raw[key] !== null && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
      result[key] = deepMergeDefaults(raw[key], defaults[key]);
    } else if (key in raw) {
      result[key] = raw[key];
    } else {
      result[key] = defaults[key];
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(key in result)) {
      result[key] = raw[key];
    }
  }
  return result;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const DEFAULT_SETTINGS = {
  providers: {},
  activeProvider: null,
  preferences: {
    defaultMode: 'chat',
    autoApply: 'ask'
  }
};

export default class SettingsManager {
  constructor() {
    this.settings = null;
  }

  _ensureDefaults(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return deepClone(DEFAULT_SETTINGS);
    }
    const normalized = { ...raw };
    if (!normalized.providers || typeof normalized.providers !== 'object' || Array.isArray(normalized.providers)) {
      normalized.providers = {};
    }
    if (!normalized.preferences || typeof normalized.preferences !== 'object' || Array.isArray(normalized.preferences)) {
      normalized.preferences = {};
    }
    return deepMergeDefaults(normalized, DEFAULT_SETTINGS);
  }

  async load(force = false) {
    if (this.settings && !force) return this.settings;

    try {
      const mainSettings = await window.api.loadSettings();
      this.settings = this._ensureDefaults(mainSettings);
    } catch (e) {
      console.warn('Settings load error:', e.message);
      this.settings = deepClone(DEFAULT_SETTINGS);
    }

    return this.settings;
  }

  async save() {
    if (!this.settings) {
      this.settings = deepClone(DEFAULT_SETTINGS);
    }
    if (!this.settings.providers || typeof this.settings.providers !== 'object' || Array.isArray(this.settings.providers)) {
      this.settings.providers = {};
    }
    if (!this.settings.preferences || typeof this.settings.preferences !== 'object' || Array.isArray(this.settings.preferences)) {
      this.settings.preferences = { ...DEFAULT_SETTINGS.preferences };
    }
    if (!this.settings.activeProvider) {
      this.settings.activeProvider = DEFAULT_SETTINGS.activeProvider;
    }

    try {
      await window.api.saveSettings(this.settings);
    } catch (e) {
      console.error('Settings save error:', e.message);
    }
  }

  getProviders() {
    return this.settings?.providers || {};
  }

  setProvider(id, config, partial = true) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('setProvider: config must be an object');
    }
    if (!this.settings) {
      this.settings = deepClone(DEFAULT_SETTINGS);
    }
    if (!this.settings.providers) {
      this.settings.providers = {};
    }

    if (partial && this.settings.providers[id]) {
      const existing = this.settings.providers[id];
      this.settings.providers[id] = {
        ...existing,
        id,
        name: config.name ?? existing.name ?? 'Unknown',
        baseUrl: config.baseUrl ?? existing.baseUrl ?? '',
        apiKey: config.apiKey ?? existing.apiKey ?? '',
        model: config.model ?? existing.model ?? '',
        systemPrompt: config.systemPrompt ?? existing.systemPrompt ?? '',
        temperature: config.temperature ?? existing.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? existing.maxTokens ?? 4096,
        maxContextTokens: config.maxContextTokens ?? existing.maxContextTokens ?? 128000,
        thinking: config.thinking ?? existing.thinking ?? false,
        thinkingBudget: config.thinkingBudget ?? existing.thinkingBudget ?? 16384
      };
    } else {
      this.settings.providers[id] = {
        id,
        name: config.name || 'Unknown',
        baseUrl: config.baseUrl || '',
        apiKey: config.apiKey || '',
        model: config.model || '',
        systemPrompt: config.systemPrompt || '',
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 4096,
        maxContextTokens: config.maxContextTokens ?? 128000,
        thinking: config.thinking ?? false,
        thinkingBudget: config.thinkingBudget ?? 16384
      };
    }
  }

  deleteProvider(id) {
    if (!this.settings || !this.settings.providers) return;
    delete this.settings.providers[id];
    if (this.settings.activeProvider === id) {
      this.settings.activeProvider = null;
    }
  }

  getActiveProvider() {
    return this.settings?.activeProvider || null;
  }

  getActiveProviderConfig() {
    if (!this.settings?.activeProvider) return null;
    const providers = this.settings?.providers;
    if (!providers || typeof providers !== 'object') return null;
    return providers[this.settings.activeProvider] || null;
  }

  setActiveProvider(id) {
    if (id !== null && typeof id !== 'string') {
      throw new TypeError('setActiveProvider: id must be a string or null');
    }
    if (id !== null && this.settings?.providers && !this.settings.providers[id]) {
      console.warn(`setActiveProvider: provider "${id}" not found`);
    }
    if (!this.settings) this.settings = deepClone(DEFAULT_SETTINGS);
    this.settings.activeProvider = id;
  }

  getPreferences() {
    return this.settings?.preferences
      ? { ...DEFAULT_SETTINGS.preferences, ...this.settings.preferences }
      : { ...DEFAULT_SETTINGS.preferences };
  }

  setPreferences(prefs) {
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      throw new TypeError('setPreferences: prefs must be an object');
    }
    if (!this.settings) this.settings = deepClone(DEFAULT_SETTINGS);
    this.settings.preferences = { ...this.getPreferences(), ...prefs };
  }
}
