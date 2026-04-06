/**
 * MCP Client — gestisce la connessione a server MCP (Model Context Protocol).
 * Comunica con il main process che spawn i processi MCP via stdio.
 */
export default class MCPClient {
  constructor() {
    this.servers = {};
    this.connectedServers = {};
    this.availableTools = {};
  }

  addServer(id, config) {
    this.servers[id] = { ...config };
  }

  removeServer(id) {
    delete this.servers[id];
    delete this.connectedServers[id];
    this.rebuildToolList();
  }

  getServerConfig(id) {
    return this.servers[id] || null;
  }

  async connect() {
    if (!window.api) return;
    for (const [id, config] of Object.entries(this.servers)) {
      if (this.connectedServers[id]) continue;
      try {
        const result = await window.api.mcpConnect(id, config);
        if (result.ok) {
          this.connectedServers[id] = { status: 'connected', tools: result.tools || [] };
        } else {
          this.connectedServers[id] = { status: 'error', error: result.error };
        }
      } catch (e) {
        this.connectedServers[id] = { status: 'error', error: e.message };
      }
    }
    this.rebuildToolList();
  }

  rebuildToolList() {
    this.availableTools = {};
    for (const [serverId, conn] of Object.entries(this.connectedServers)) {
      if (conn.status === 'connected' && conn.tools) {
        for (const tool of conn.tools) {
          this.availableTools[tool.name] = { serverId, ...tool };
        }
      }
    }
  }

  async callTool(toolName, args) {
    const tool = this.availableTools[toolName];
    if (!tool) return { error: `Tool ${toolName} non trovato` };
    if (!window.api) return { error: 'API non disponibile' };

    try {
      const result = await window.api.mcpCallTool(tool.serverId, toolName, args);
      return result;
    } catch (e) {
      return { error: e.message };
    }
  }

  getMCPToolDefinitions() {
    const defs = [];
    for (const [name, tool] of Object.entries(this.availableTools)) {
      defs.push({
        type: 'function',
        function: {
          name,
          description: tool.description || `MCP tool from ${tool.serverId}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
    return defs;
  }

  getStatus() {
    return Object.fromEntries(
      Object.entries(this.connectedServers).map(([id, conn]) => [id, conn.status])
    );
  }

  disconnect() {
    if (!window.api) return;
    for (const id of Object.keys(this.connectedServers)) {
      window.api.mcpDisconnect(id).catch((e) => console.error(e));
    }
    this.connectedServers = {};
    this.availableTools = {};
  }
}
