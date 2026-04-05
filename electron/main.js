const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const rootDir = path.join(__dirname, '..');
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(rootDir, 'src', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const id of Object.keys(mcpProcesses)) {
    try {
      const { child } = mcpProcesses[id];
      child.removeAllListeners();
      child.kill('SIGTERM');
    } catch {}
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Project root sandbox ───

let projectRoot = null;

ipcMain.handle('fs:set-project-root', async (_event, root) => {
  projectRoot = root ? path.resolve(root) : null;
  return { ok: true };
});

function validatePath(filePath) {
  if (!projectRoot) return true; // no project opened, allow all
  const resolved = path.resolve(filePath);
  // Use realpath to resolve symlinks, .., UNC paths, etc.
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (e) {
    // File doesn't exist yet (e.g. fs_write new file) — validate the resolved path
    canonical = resolved;
  }
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(projectRoot);
  } catch (e) {
    return false; // project root doesn't exist (anymore), deny all access
  }
  // Use path.relative to prevent prefix-matching attacks
  // e.g. projectRoot="C:\proj" vs resolved="C:\proj-evil"
  const relative = path.relative(canonicalRoot, canonical);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createPathValidator(label) {
  return (filePath) => {
    if (!validatePath(filePath)) {
      return { ok: false, error: `Access denied: path outside project root ('${label}')` };
    }
    return null;
  };
}

// ─── File System IPC ───

ipcMain.handle('fs:read-file', async (_event, filePath) => {
  const validationErr = createPathValidator('read-file')(filePath);
  if (validationErr) return validationErr;
  try {
    return { ok: true, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:write-file', async (_event, filePath, content) => {
  const validationErr = createPathValidator('write-file')(filePath);
  if (validationErr) return validationErr;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:list-dir', async (_event, dirPath) => {
  const validationErr = createPathValidator('list-dir')(dirPath);
  if (validationErr) return validationErr;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
      isFile: e.isFile()
    }));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (!result.canceled && result.filePaths.length > 0) {
    const fp = result.filePaths[0];
    if (!validatePath(fp)) return { ok: false, error: 'Access denied: path outside project root' };
    return { ok: true, path: fp };
  }
  return { ok: false, canceled: true };
});

ipcMain.handle('fs:open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) {
    const fp = result.filePaths[0];
    if (!validatePath(fp)) return { ok: false, error: 'Access denied: path outside project root' };
    return { ok: true, path: fp };
  }
  return { ok: false, canceled: true };
});

ipcMain.handle('fs:exists', async (_event, filePath) => {
  if (!validatePath(filePath)) return { ok: false, error: 'Access denied' };
  return { ok: true, exists: fs.existsSync(filePath) };
});

// ─── Settings IPC ───

ipcMain.handle('settings:load', async () => {
  const settingsPath = path.join(rootDir, 'config', 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (e) {}
  return { providers: {}, activeProvider: null, preferences: {} };
});

ipcMain.handle('settings:save', async (_event, settings) => {
  const configDir = path.join(rootDir, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── AI API (main process via Node.js https, no CORS) ───

const MAX_RETRIES = 10;
const RETRY_BASE_DELAY = 3000; // ms

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRequest(client, url, isHttps, body, authHeader, onSseChunk) {
  const requestId = ++_nextRequestId;
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const req = client.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': authHeader
      }
    }, (res) => {
      res.setEncoding('utf8');

      if (onSseChunk) {
        let sseBuffer = '';
        let fullContent = '';
        let lineStart = 0;
        let errorBody = '';

        res.on('data', (chunk) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            errorBody += chunk;
            return;
          }

          sseBuffer += chunk;

          let newlineIndex;
          while ((newlineIndex = sseBuffer.indexOf('\n', lineStart)) !== -1) {
            const line = sseBuffer.substring(lineStart, newlineIndex).trim();
            lineStart = newlineIndex + 1;

            if (line.startsWith('data:')) {
              const data = line.replace(/^data:\s*/, '');
              if (data === '[DONE]' || !data) continue;
              try {
                const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  onSseChunk(delta, fullContent);
                }
              } catch (e) {
                // Non-JSON SSE lines — skip
              }
            }
          }

          sseBuffer = sseBuffer.substring(lineStart);
          lineStart = 0;
        });

        res.on('end', () => {
          pendingRequests.delete(requestId);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const lastLine = sseBuffer.trim();
            if (lastLine.startsWith('data:')) {
              const data = lastLine.replace(/^data:\s*/, '');
              if (data !== '[DONE]' && data) {
                try {
                  const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                  if (delta) {
                    fullContent += delta;
                    onSseChunk(delta, fullContent);
                  }
                } catch (e) { /* skip */ }
              }
            }
            resolve({ requestId, statusCode: res.statusCode, body: '', headers: res.headers });
          } else {
            resolve({ requestId, statusCode: res.statusCode, body: errorBody, headers: res.headers });
          }
        });
      } else {
        // Non-streaming path: buffer full body (for ai:sendWithTools)
        let rawBody = '';
        res.on('data', (chunk) => { rawBody += chunk; });
        res.on('end', () => {
          pendingRequests.delete(requestId);
          resolve({ requestId, statusCode: res.statusCode, body: rawBody, headers: res.headers });
        });
      }
    });

    pendingRequests.set(requestId, req);

    req.on('error', (err) => {
      pendingRequests.delete(requestId);
      resolve({ requestId, statusCode: 0, body: '', error: 'Connection error: ' + (err.message || 'unknown') });
    });

    req.setTimeout(120000, () => {
      pendingRequests.delete(requestId);
      req.destroy();
      resolve({ requestId, statusCode: 0, body: '', error: 'Request timeout' });
    });

    req.write(body);
    req.end();
  });
}

ipcMain.handle('ai:sendWithTools', async (event, { config, messages, tools }) => {
  if (isAIRateLimited()) {
    return { error: 'AI request rejected: rate limit exceeded (10/min)' };
  }
  const { baseUrl, apiKey, model, temperature, maxTokens } = config;

  console.log('[AI] Attempting request with tools to:', baseUrl, 'model:', model);

  if (!baseUrl || !apiKey || !model) {
    return { error: 'Provider non configurato: mancano URL, API key o modello.' };
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const isHttps = new URL(url).protocol === 'https:';
  const client = isHttps ? https : http;
  const authHeader = 'Bearer ' + apiKey;

  const body = JSON.stringify({
    model,
    messages,
    tools,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
    stream: false // tool_use non supportato con streaming su tutti i provider
  });

  let retries = 0;
  while (retries < MAX_RETRIES) {
    retries++;
    const res = await makeRequest(client, url, isHttps, body, authHeader);

    if (res.statusCode === 0 && res.error) {
      return { error: res.error };
    }

    if (res.statusCode === 429 || res.statusCode === 503) {
      if (retries >= MAX_RETRIES) {
        return { error: `API Error ${res.statusCode}: Troppe richieste. Attendi qualche minuto.` };
      }
      const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
      const delayMs = Math.min(retryAfter * 1000, RETRY_BASE_DELAY * Math.pow(2, retries - 1));
      console.log(`[AI] Rate limited, retry ${retries}/${MAX_RETRIES} in ${delayMs}ms`);
      await delay(delayMs);
      continue;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { error: `API Error ${res.statusCode}: ${res.body.slice(0, 500)}` };
    }

    try {
      const parsed = JSON.parse(res.body);
      const choice = parsed.choices?.[0];
      if (choice?.message) {
        const resp = { content: choice.message.content || '' };
        if (choice.message.tool_calls) {
          resp.tool_calls = choice.message.tool_calls;
        }
        return resp;
      }
      return { error: 'Risposta non valida: ' + res.body.slice(0, 500) };
    } catch (e) {
      return { error: 'Risposta non valida: ' + res.body.slice(0, 300) };
    }
  }

  return { error: 'Max retries exceeded' };
});

ipcMain.handle('ai:send', async (event, { config, messages, streamId }) => {
  if (isAIRateLimited()) {
    return { error: 'AI request rejected: rate limit exceeded (10/min)' };
  }
  const { baseUrl, apiKey, model, temperature, maxTokens, thinking, thinkingBudget } = config;

  console.log('[AI] Attempting request to:', baseUrl, 'model:', model);

  if (!baseUrl || !apiKey || !model) {
    console.error('[AI] Missing config:', { baseUrl: !!baseUrl, apiKey: !!apiKey, model: !!model });
    return { error: 'Provider non configurato: mancano URL, API key o modello.' };
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  console.log('[AI] Full URL:', url);
  const isHttps = new URL(url).protocol === 'https:';
  const client = isHttps ? https : http;
  const authHeader = 'Bearer ' + apiKey;

  const bodyObj = {
    model,
    messages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
    stream: true
  };
  if (thinking) {
    bodyObj.max_tokens = Math.max(bodyObj.max_tokens, thinkingBudget || 16384, 8192);
    bodyObj.thinking = { type: 'enabled', budget_tokens: thinkingBudget || 16384 };
  }
  const fullBody = JSON.stringify(bodyObj);

  let retries = 0;

  while (retries < MAX_RETRIES) {
    retries++;

    let accumulatedContent = '';

    const onSseChunk = (delta, full) => {
      accumulatedContent = full;
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('ai:chunk', { content: delta, streamId });
      }
    };

    const res = await makeRequest(client, url, isHttps, fullBody, authHeader, onSseChunk);

    if (res.statusCode === 0 && res.error) {
      return { error: res.error };
    }

    // 4xx errors (except 429) are NOT retryable — return immediately
    if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
      let errDetail = `HTTP ${res.statusCode}`;
      try {
        const body = JSON.parse(res.body);
        if (body?.error?.message) errDetail = body.error.message;
        else if (body?.message) errDetail = body.message;
      } catch { /* body not JSON parsable */ }
      return { error: `API Error ${res.statusCode}: ${errDetail}` };
    }

    if (res.statusCode === 429 || res.statusCode === 503) {
      if (retries >= MAX_RETRIES) {
        return { error: `API Error ${res.statusCode}: Troppe richieste. Attendi qualche minuto.` };
      }
      const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
      const delayMs = Math.min(retryAfter * 1000, RETRY_BASE_DELAY * Math.pow(2, retries - 1));
      console.log(`[AI] Rate limited (${res.statusCode}), retry ${retries}/${MAX_RETRIES} in ${delayMs}ms`);
      await delay(delayMs);
      continue;
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log('[AI] Response complete, content length:', accumulatedContent.length);
      return { ok: true, content: accumulatedContent || '' };
    }

    // 5xx errors — retry with backoff
    if (res.statusCode >= 500) {
      if (retries >= MAX_RETRIES) {
        return { error: `API Error ${res.statusCode}: Server error dopo ${MAX_RETRIES} tentativi.` };
      }
      await delay(RETRY_BASE_DELAY * Math.pow(2, retries - 1));
      continue;
    }

    return { error: `Unexpected response: HTTP ${res.statusCode}` };
  }

  return { error: 'Max retries exceeded' };
});

// ─── Rate limiters ───

const aiTimestamps = [];
const cmdTimestamps = [];

function isAIRateLimited() {
  const now = Date.now();
  const windowMs = 60_000;
  while (aiTimestamps.length && aiTimestamps[0] < now - windowMs) aiTimestamps.shift();
  if (aiTimestamps.length >= 10) return true;
  aiTimestamps.push(now);
  return false;
}

function isCommandRateLimited() {
  const now = Date.now();
  const windowMs = 60_000;
  while (cmdTimestamps.length && cmdTimestamps[0] < now - windowMs) cmdTimestamps.shift();
  if (cmdTimestamps.length >= 5) return true;
  cmdTimestamps.push(now);
  return false;
}

// ─── Cancel in-flight AI requests ───

const pendingRequests = new Map();
let _nextRequestId = 0;

ipcMain.handle('ai:cancel', async (_event, requestId) => {
  if (requestId != null && pendingRequests.has(requestId)) {
    // Cancel a specific request
    try { pendingRequests.get(requestId).destroy(); } catch {}
    pendingRequests.delete(requestId);
  } else {
    // Cancel all pending HTTP requests by destroying their sockets
    for (const [id, req] of pendingRequests) {
      try { req.destroy(); } catch {}
    }
    pendingRequests.clear();
  }
  return { cancelled: true };
});

// ─── Command execution ───

ipcMain.handle('cmd:exec', async (_event, command, cwd) => {
  // Block shell metacharacters that allow command chaining, piping, subshell, globbing
  if (/[;|&$`<>\\(){}!\[\]*?~%\^'"\n\r]/.test(command)) {
    return { ok: false, error: 'Command rejected: invalid characters not allowed' };
  }
  if (isCommandRateLimited()) {
    return { ok: false, error: 'Command rejected: rate limit exceeded (5/min)' };
  }
  // Parse executable + args from the command string
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: 'Command rejected: empty command' };
  }
  const exe = tokens[0];

  const ALLOWED_COMMANDS = ['npm', 'node', 'ls', 'esbuild', 'electron', 'electron-builder'];
  const baseExe = path.basename(exe);

  if (!ALLOWED_COMMANDS.includes(baseExe)) {
    return { ok: false, error: `Command rejected: executable '${baseExe}' is not in the allowlist` };
  }
  const args = tokens.slice(1);
  // Validate cwd against project root
  const effectiveCwd = cwd || rootDir;
  if (!validatePath(effectiveCwd)) {
    return { ok: false, error: 'Command rejected: cwd outside project root' };
  }
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: effectiveCwd, timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr, exitCode: 1 });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });
  });
});

// ─── MCP Support ───

const mcpProcesses = {};
let _mcpreqId = 0;

ipcMain.handle('mcp:connect', async (_event, id, config) => {
  try {
    if (mcpProcesses[id]) {
      try {
        mcpProcesses[id].child.removeAllListeners();
        mcpProcesses[id].child.kill('SIGTERM');
      } catch(e) {}
      delete mcpProcesses[id];
    }
    // Validate command against allow-list
    const MCP_COMMAND_ALLOW_LIST = ['node', 'npx', 'python', 'python3', 'bun', 'deno', 'cargo', 'tsx'];
    const cmd = path.basename(config.command || '');
    if (!MCP_COMMAND_ALLOW_LIST.includes(cmd)) {
      return { ok: false, error: `MCP command rejected: '${cmd}' is not in the allowed list` };
    }
    const child = spawn(cmd, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.env || {}) }
    });

    // Line-based reader to avoid parsing partial chunks
    let stdoutBuffer = '';

    let resolve;
    let onTools = null;
    const promise = new Promise((r) => { resolve = r; });

    const stderrHandler = (d) => { console.error(`[MCP ${id}]`, d.toString()); };
    child.stderr.on('data', stderrHandler);

    // Register listener BEFORE writing to stdin
    const onInit = (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
            child.stdout.removeListener('data', onInit);
            onTools = (d2) => {
              stdoutBuffer += d2.toString();
              const toolLines = stdoutBuffer.split('\n');
              stdoutBuffer = toolLines.pop();
              for (const l of toolLines) {
                if (!l.trim()) continue;
                try {
                  const p2 = JSON.parse(l);
                  if (p2.id === 2) {
                    child.stdout.removeListener('data', onTools);
                    child.stderr.removeListener('data', stderrHandler);
                    clearTimeout(timeoutId);
                    resolve({ ok: true, tools: p2.result?.tools || [] });
                  }
                } catch { /* skip non-json lines */ }
              }
            };
            child.stdout.on('data', onTools);
            return;
          }
        } catch { /* skip non-json lines */ }
      }
    };

    mcpProcesses[id] = { child, config, output: '' };

    // Initialize MCP session
    const initReq = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-10-07', capabilities: {}, clientInfo: { name: 'MyIDE', version: '0.1.0' } } });

    const timeoutId = setTimeout(() => {
      child.stdout.removeListener('data', onInit);
      if (onTools) child.stdout.removeListener('data', onTools);
      child.stderr.removeListener('data', stderrHandler);
      resolve({ ok: true, tools: [] });
    }, 5000);

    child.stdout.on('data', onInit);
    child.stdin.write(initReq + '\n');
    return promise;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mcp:call-tool', async (_event, serverId, toolName, args) => {
  const proc = mcpProcesses[serverId];
  if (!proc) return { error: `Server ${serverId} non connesso` };

  return new Promise((resolve) => {
    // Use incremental counter for collision-free reqIds
    const reqId = ++_mcpreqId;
    const req = JSON.stringify({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name: toolName, arguments: args } });
    proc.child.stdin.write(req + '\n');

    // Line-based reader for tool response
    let toolBuffer = '';
    const onData = (data) => {
      toolBuffer += data.toString();
      const lines = toolBuffer.split('\n');
      toolBuffer = lines.pop(); // Keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === reqId) {
            proc.child.stdout.off('data', onData);
            clearTimeout(timeoutId);
            if (parsed.error) {
              resolve({ error: parsed.error.message });
            } else {
              const content = parsed.result?.content || [];
              const text = content.map(c => c.text || '').join('\n');
              resolve({ ok: true, content: text });
            }
            return;
          }
        } catch { /* skip */ }
      }
    };
    proc.child.stdout.on('data', onData);

    const timeoutId = setTimeout(() => {
      proc.child.stdout.off('data', onData);
      resolve({ error: 'MCP tool call timeout' });
    }, 15000);
  });
});

ipcMain.handle('mcp:disconnect', async (_event, id) => {
  const proc = mcpProcesses[id];
  if (proc) {
    proc.child.kill();
    delete mcpProcesses[id];
  }
  return { ok: true };
});
