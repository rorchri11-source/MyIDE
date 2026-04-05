# SSE Streaming Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace post-hoc SSE parsing with real-time in-line parsing inside `makeRequest()` so streaming text appears progressively in the UI instead of all at once.

**Architecture:** Add optional `onSseChunk` callback to `makeRequest()`. When provided, parse SSE line-by-line as TCP chunks arrive (buffer-line-per-line pattern, same as MCP), calling `onSseChunk(delta, fullContent)` per delta. When omitted, fall back to full-body buffering for `ai:sendWithTools` (stream:false). Zero changes to preload.js, ai-client.js, or any renderer file.

**Tech Stack:** Electron IPC, Node.js `http`/`https`, SSE protocol, vanilla JS ES modules.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `electron/main.js` | Modify | `makeRequest()` with streaming branch; `ai:send` retry loop refactor |
| `docs/superpowers/specs/2026-04-05-ai-streaming-refactor-design.md` | Reference | Full technical spec (already written) |

**Not touched and why:**
- `electron/preload.js` — IPC contract (`ai:send`, `ai:chunk`, `ai:cancel`) unchanged
- `src/core/ai-client.js` — `AIClient.send(onChunk)` API unchanged
- `src/ui/ChatUI.js` — chunk consumer unchanged
- `src/core/agent-runner.js` — uses `sendWithToolUse` (stream:false path)
- `src/core/edit-mode-runner.js` — uses `send(onChunk)` (contract unchanged)

---

### Task 1: Refactor `makeRequest()` with SSE in-line parsing

**Files:**
- Modify: `electron/main.js` — replace `makeRequest()` function (lines ~189-229)

- [ ] **Step 1: Replace `makeRequest()` with streaming-capable version**

This is the core change. The new `makeRequest()` accepts an optional `onSseChunk` callback. When present, it parses SSE line-by-line as TCP chunks arrive. When absent, it buffers the full body exactly as it does today.

Replace the entire `makeRequest()` function (lines 189-229) with:

```js
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
        // Streaming path: parse SSE line-by-line as chunks arrive
        let sseBuffer = '';
        let fullContent = '';
        let lineStart = 0;

        res.on('data', (chunk) => {
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
                // Non-JSON SSE lines (e.g., comments) — skip
              }
            }
          }

          // Keep incomplete line in buffer for next chunk
          sseBuffer = sseBuffer.substring(lineStart);
          lineStart = 0;
        });

        res.on('end', () => {
          pendingRequests.delete(requestId);
          // Process any remaining partial line
          const lastLine = sseBuffer.trim();
          if (lastLine.startsWith('data:')) {
            const data = lastLine.replace(/^data:\s*/, '');
            if (data !== '[DONE]' && data) {
              try {
                const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                if (delta) onSseChunk(delta, fullContent);
              } catch (e) { /* skip */ }
            }
          }
          resolve({ requestId, statusCode: res.statusCode, body: '', headers: res.headers });
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
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check electron/main.js` from `C:\Game\MyIDE`
Expected: no output (syntax valid)

- [ ] **Step 3: Verify existing exports work**

Run: `npm start` from `C:\Game\MyIDE`, wait for window to open
Expected: app launches without crash, no console errors in main process

---

### Task 2: Refactor `ai:send` handler to pass `onSseChunk`

**Files:**
- Modify: `electron/main.js` — replace the `while (retries < MAX_RETRIES)` block inside `ipcMain.handle('ai:send')` (lines ~378-418)

- [ ] **Step 1: Replace the retry block in `ai:send`**

The current retry block calls `makeRequest()` without `onSseChunk`, then parses the full body. Replace it with a version that passes an `onSseChunk` callback that streams deltas to the renderer in real time.

Replace the entire `while (retries < MAX_RETRIES)` block inside `ipcMain.handle('ai:send')` (approximately lines 378-418) with:

```js
  let retries = 0;

  while (retries < MAX_RETRIES) {
    retries++;

    // Accumulator for streamed content (reset each retry attempt)
    let accumulatedContent = '';

    const onSseChunk = (delta, full) => {
      accumulatedContent = full;
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('ai:chunk', { content: delta });
      }
    };

    const res = await makeRequest(client, url, isHttps, fullBody, authHeader, onSseChunk);

    if (res.statusCode === 0 && res.error) {
      return { error: res.error };
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

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errDetail = res.body
        ? res.body.slice(0, 500)
        : `HTTP ${res.statusCode} senza body dettagliato`;
      return { error: `API Error ${res.statusCode}: ${errDetail}` };
    }

    // Content has been streamed via onSseChunk; accumulatedContent holds the full text.
    console.log('[AI] Response complete, content length:', accumulatedContent.length);
    return { ok: true, content: accumulatedContent || '' };
  }

  return { error: 'Max retries exceeded' };
```

- [ ] **Step 2: Remove the now-unused `parseStreamingResponse` call (leave function for safety)**

The `parseStreamingResponse()` function is no longer called in the main path. Keep the function definition (lines 231-256) as a fallback — it's harmless and may help debug. No code to remove.

- [ ] **Step 3: Verify syntax**

Run: `node --check electron/main.js` from `C:\Game\MyIDE`
Expected: no output

- [ ] **Step 4: Manual smoke test**

Run: `npm start` from `C:\Game\MyIDE`
1. Configure a provider in settings (API key, model, base URL)
2. Open chat, send a prompt like "Write a hello world in Python"
3. **Critical verification:** text must appear progressively word-by-word, NOT all at once after a delay
4. Check main process console for `[AI] Response complete, content length: XXX`
5. Verify final content is complete (no truncation)

Expected: streaming text visible in real-time, final response correct, no errors

---

### Task 3: Verify `ai:sendWithTools` regression-free

**Files:**
- No file changes. Verification only.

- [ ] **Step 1: Confirm `ai:sendWithTools` calls `makeRequest` without `onSseChunk`**

Read `electron/main.js` lines for `ipcMain.handle('ai:sendWithTools')` (approx line 271). Verify the call is:

```js
const res = await makeRequest(client, url, isHttps, body, authHeader);
```

(no 6th argument). This routes to the non-streaming branch of `makeRequest`, preserving existing behavior.

- [ ] **Step 2: Manual Agent mode test**

Run: `npm start` from `C:\Game\MyIDE`
1. Switch to Agent mode
2. Send: "Read the README file and summarize it"
3. **Verification:** agent shows tool call (fs_read), executes it, returns summary
4. No streaming artifacts, no missing text

Expected: agent loop works exactly as before

---

### Task 4: Verify Edit mode regression-free

**Files:**
- No file changes. Verification only.

- [ ] **Step 1: Manual Edit mode test**

Run: `npm start` from `C:\Game\MyIDE`
1. Open any file in the editor
2. Switch to Edit mode
3. Request a change (e.g., "Add error handling")
4. **Verification:** AI response appears, diff is shown and can be applied
5. No crashes, no UI freezes

Expected: edit mode works as before (it uses `client.send(onChunk)` which routes through the same IPC but consumption pattern is unchanged)

---

### Task 5: Edge case verification

**Files:**
- No file changes. Verification only.

- [ ] **Step 1: Test cancel during streaming**

Run: `npm start` from `C:\Game\MyIDE`
1. Send a long prompt ("Write a complete game in JavaScript")
2. While text is streaming, press the Stop button
3. **Verification:** streaming stops, no crash, partial text is visible

- [ ] **Step 2: Test rate limit retry**

Simulate or observe a 429 response. The code paths are unchanged but `onSseChunk` is created fresh each retry loop iteration (declared inside `while`), ensuring no stale accumulator carries over.

- [ ] **Step 3: Test network disconnect**

1. Send a prompt
2. Disconnect network mid-stream
3. **Verification:** error message shown, app doesn't crash, `pendingRequests` cleaned up

- [ ] **Step 4: Commit (if git available)**

Run from `C:\Game\MyIDE`:
```bash
git add electron/main.js
git commit -m "fix: true SSE streaming — parse in makeRequest() instead of post-body"
```

If git is not initialized, skip this step.

---

## Self-Review

### 1. Spec coverage check

| Spec requirement | Task |
|---|---|
| `makeRequest()` with `onSseChunk` parameter | Task 1 |
| SSE line-by-line parsing with buffer | Task 1, Steps 1 |
| Non-streaming fallback for `ai:sendWithTools` | Task 1, Steps 1 (else branch) |
| `ai:send` passes `onChunk` to `makeRequest` | Task 2 |
| Chunk TCP split handling | Task 1 (sseBuffer + lineStart pattern) |
| Last line residual processing | Task 1 (res.on('end') lastLine block) |
| Error handling for non-SSE 2xx | Task 2 (accumulatedContent returns '') |
| Error handling for 4xx/5xx | Task 2 (statusCode check with body fallback) |
| Rate limit retry | Task 2 (unchanged retry logic, fresh accumulator) |
| Cancel in-flight | Task 5 (uses existing ai:cancel + pendingRequests) |
| sendWithTools regression-free | Task 3 |
| Edit mode regression-free | Task 4 |
| Impact analysis (only main.js) | All tasks confirm |
| parseStreamingResponse kept as safety net | Task 2, Step 2 (left in-place) |

**All spec requirements covered.**

### 2. Placeholder scan
- No TBD, TODO, "implement later", "handle edge cases"
- All code steps contain actual code
- No "similar to Task N" references
- All function signatures defined inline
- All error handling shown explicitly

### 3. Type/Signature consistency
- `makeRequest(client, url, isHttps, body, authHeader, onSseChunk)` — Task 1 definition matches Task 2 call (6 arguments)
- `onSseChunk(delta, fullContent)` — called in Task 1, matches `onChunk` pattern from original spec
- `accumulateContent = full` — Task 2 assignment matches `fullContent` accumulation in Task 1
- Return types: `{ requestId, statusCode, body, headers }` or `{ requestId, statusCode, body, headers, error }` — consistent across both branches of `makeRequest()`

**Plan is internally consistent and covers all spec requirements.**
