const { contextBridge, ipcRenderer } = require('electron');

// Map of request-scoped listeners to support concurrent AI calls
let aiChunkListeners = new Map();
let nextListenerId = 1;
function onAiChunk(callback) {
  const id = nextListenerId++;
  const listener = (_event, data) => callback(data);
  aiChunkListeners.set(id, listener);
  ipcRenderer.on('ai:chunk', listener);
  return id; // caller can use this to remove the listener
}
function aiRemoveChunkListener(id) {
  const listener = aiChunkListeners.get(id);
  if (listener) {
    ipcRenderer.off('ai:chunk', listener);
    aiChunkListeners.delete(id);
  }
}

// ai:cancel — sends cancel signal to main process to abort in-flight requests
// Pass an optional requestId to cancel only that request; omit to cancel all.
function aiCancel(requestId) {
  return ipcRenderer.invoke('ai:cancel', requestId);
}

contextBridge.exposeInMainWorld('api', {
  fsReadFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  fsWriteFile: (path, content) => ipcRenderer.invoke('fs:write-file', path, content),
  fsListDir: (path) => ipcRenderer.invoke('fs:list-dir', path),
  fsOpenFile: () => ipcRenderer.invoke('fs:open-file-dialog'),
  fsOpenFolder: () => ipcRenderer.invoke('fs:open-folder-dialog'),
  fsExists: (path) => ipcRenderer.invoke('fs:exists', path),
  fsSetProjectRoot: (root) => ipcRenderer.invoke('fs:set-project-root', root),

  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  aiSend: (config, messages, streamId) => ipcRenderer.invoke('ai:send', { config, messages, streamId }),
  aiSendWithTools: (config, messages, tools) => ipcRenderer.invoke('ai:sendWithTools', { config, messages, tools }),
  aiCancel,
  onAiChunk,
  aiRemoveChunkListener,

  execCommand: (command, cwd) => ipcRenderer.invoke('cmd:exec', command, cwd),

  mcpConnect: (id, config) => ipcRenderer.invoke('mcp:connect', id, config),
  mcpCallTool: (serverId, toolName, args) => ipcRenderer.invoke('mcp:call-tool', serverId, toolName, args),
  mcpDisconnect: (id) => ipcRenderer.invoke('mcp:disconnect', id)
});
