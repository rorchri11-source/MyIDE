# Technical Spec: SSE Streaming Refactor — Main Process

**Date:** 2026-04-05
**Scope:** `electron/main.js` — unico file da modificare
**Approccio:** A — SSE Parser In-Line in `makeRequest()`

---

## 1. Problem Statement

### Cosa non funziona

Nei flussi `ai:send` (streaming), `makeRequest()` in `main.js` accumula l'intero HTTP response body in un buffer (`rawBody += chunk`) prima di parsarlo (linea 206). Il parsing SSE avviene solo dopo `res.on('end')` (linea 207), quindi l'utente vede la risposta completa tutta in una volta invece che progressivamente.

### Causa radice

```
res.on('data', (chunk) => { rawBody += chunk; });    // accumula tutto
res.on('end', () => {
  // parsing SSE avviene QUI — quando la risposta è già completa
  content = parseStreamingResponse(res.body, onChunk);
});
```

Sebbene `parseStreamingResponse(chiama onChunk(delta, full)` e `onChunk` invia `ai:chunk` al renderer, tutto avviene in un unico blocco al termine della risposta. Il true streaming è vanificato dal buffer totale.

### Il file è già preparato

`makeRequest()` è già usato da:
- `ai:send` — `stream: true`, vuole streaming (ma non funziona)
- `ai:sendWithTools` — `stream: false`, vuole risposta completa (deve restare bufferizzato)

C'è già `parseStreamingResponse()` che funziona correttamente su body completato. Il pattern di line-buffering è già usato per MCP (righe 529-542).

---

## 2. Current Architecture

```
Renderer                    IPC                     main.js (makeRequest)
   │                          │                              │
   │── ai:send ──────────────>│                              │
   │                          │── makeRequest() ────────────>│
   │                          │                              │── POST /chat/completions (stream: true)
   │                          │                              │   res.on('data', chunk => rawBody += chunk)
   │                          │                              │   res.on('data', chunk => rawBody += chunk)
   │                          │                              │   res.on('data', chunk => rawBody += chunk)
   │                          │                              │   ...
   │                          │                              │   res.on('end'):
   │                          │                              │     parseStreamingResponse(rawBody, onChunk)
   │                          │<─── {ok, content} ───────────│     onChunk invia tutti i chunk in blocco
   │<── ai:chunk (tutto) ────│                              │
   │<── return {ok,content} ─│                              │
   │                          │                              │
```

**Problema:** i chunk TCP arrivano in tempo reale ma vengono accumulati. L'utente non vede nulla mentre l'AI genera.

---

## 3. Proposed Architecture

```
Renderer                    IPC                     main.js (makeRequest)
   │                          │                              │
   │── ai:send ──────────────>│                              │
   │                          │── makeRequest + onSseChunk──>│
   │                          │                              │── POST /chat/completions (stream: true)
   │                          │                              │   res.on('data', chunk => {
   │                          │                              │     sseBuffer += chunk
   │                     onSseChunk(delta, full) ◄─ parse linea-per-linea
   │                          │<─────────────────────────────│     for data: lines => onSseChunk
   │<── ai:chunk (delta) ────│                              │   })
   │                          │                              │   res.on('data', chunk => {
   │                          │    ... ogni chunk TCP ...    │
   │<── ai:chunk (delta) ────│                              │     sseBuffer += chunk + parse
   │                          │                              │   })
   │                          │                              │   res.on('end'):
   │                          │<─── {ok, content} ───────────│     resolve con fullContent
   │<── return {ok,content} ─│                              │
   │                          │                              │
```

**Risultato:** ogni delta SSE viene inviato al renderer non appena il TCP chunk arriva. L'utente vede il testo comparire progressivamente.

---

## 4. Implementation Details

### 4.1 makeRequest() — nuovo parametro `onSseChunk`

**Firma attuale:**
```js
function makeRequest(client, url, isHttps, body, authHeader) {
```

**Nuova firma:**
```js
function makeRequest(client, url, isHttps, body, authHeader, onSseChunk) {
```

**Implementazione — sostituzione del blocco `res.on('data')` e successiva gestione response:**

Sostituire tutto il blocco dentro `makeRequest()` che gestisce `res.on('data')` e `res.on('end')`:

```js
    }, (res) => {
      res.setEncoding('utf8');

      // Se onSseChunk è fornito, parse SSE in tempo reale
      if (onSseChunk) {
        let sseBuffer = '';
        let fullContent = '';
        let lineStart = 0;

        res.on('data', (chunk) => {
          sseBuffer += chunk;

          // Trova tutte le linee complete nel buffer
          let newlineIndex;
          while ((newlineIndex = sseBuffer.indexOf('\n', lineStart)) !== -1) {
            const line = sseBuffer.substring(lineStart, newlineIndex).trim();
            lineStart = newlineIndex + 1;

            if (line.startsWith('data:')) {
              const data = line.replace(/^data:\s*/, '');
              if (data === '[DONE]' || !data) continue;

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  onSseChunk(delta, fullContent);
                }
              } catch (e) {
                // Righe non-JSON (es. commenti SSE) — ignorare
              }
            }
          }

          // Mantieni la linea parziale nel buffer per il prossimo chunk
          sseBuffer = sseBuffer.substring(lineStart);
          lineStart = 0;
        });

        res.on('end', () => {
          pendingRequests.delete(requestId);
          // Processa l'ultima linea residua
          const lastLine = sseBuffer.trim();
          if (lastLine.startsWith('data:')) {
            const data = lastLine.replace(/^data:\s*/, '');
            if (data !== '[DONE]' && data) {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) onSseChunk(delta, fullContent);
              } catch (e) { /* skip */ }
            }
          }
          resolve({ requestId, statusCode: res.statusCode, body: '', headers: res.headers });
        });
      } else {
        // Nessun onSseChunk: comportamento originale (buffer + parse alla fine)
        let rawBody = '';
        res.on('data', (chunk) => { rawBody += chunk; });
        res.on('end', () => {
          pendingRequests.delete(requestId);
          resolve({ requestId, statusCode: res.statusCode, body: rawBody, headers: res.headers });
        });
      }
    });
```

**Nota chiave:** quando `onSseChunk` è fornito, `rawBody` non viene più accumulato. Il body nel resolve è stringa vuota `''` — il contenuto è già stato consegnato in tempo reale.

### 4.2 ipcMain.handle('ai:send') — passa onSseChunk a makeRequest

**Codice attuale:**
```js
const res = await makeRequest(client, url, isHttps, fullBody, authHeader);
// ...
let content;
if (res.body.includes('data:')) {
  content = parseStreamingResponse(res.body, onChunk);
} else {
  content = parseJsonResponse(res.body);
  // ...
}
return { ok: true, content: content || '' };
```

**Nuovo codice:**
```js
let accumulatedContent = '';
const onSseChunk = (delta, full) => {
  accumulatedContent = full;
  onChunk(delta, full);
};

const res = await makeRequest(client, url, isHttps, fullBody, authHeader, onSseChunk);

if (res.statusCode === 0 && res.error) {
  return { error: res.error };
}

if (res.statusCode === 429 || res.statusCode === 503) {
  // ... rate limit retry logic (invariato) ...
}

if (res.statusCode < 200 || res.statusCode >= 300) {
  // Con onSseChunk attivo, il body è vuoto. Ma se il server ha risposto
  // con errore senza body streaming, il fallback è necessario.
  // Se il body non è vuoto (caso fallback non-streaming), parsalo:
  if (res.body && !res.body.includes('data:')) {
    return { error: `API Error ${res.statusCode}: ${res.body.slice(0, 500)}` };
  }
  return { error: `API Error ${res.statusCode}: richiesta fallita` };
}

console.log('[AI] Response complete, content length:', accumulatedContent.length);
return { ok: true, content: accumulatedContent || '' };
```

Questo codice sostituisce il blocco dentro il `while (retries < MAX_RETRIES)` di `ai:send`, rimuovendo il `if (res.body.includes('data:'))` che diventra non necessario con il nuovo flusso.

### 4.3 ai:sendWithTools — invariato

`ai:sendWithTools` continua a chiamare `makeRequest(...)` senza il quinto parametro. Il ramo `else` dentro `makeRequest()` gestisce il buffering come oggi. Nessuna modifica necessaria.

### 4.4 makeRequest() — firma completa finale

La funzione completa dopo il refactor:

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
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  onSseChunk(delta, fullContent);
                }
              } catch (e) {
                // Righe non-JSON — ignorare (es. commenti SSE)
              }
            }
          }

          sseBuffer = sseBuffer.substring(lineStart);
          lineStart = 0;
        });

        res.on('end', () => {
          pendingRequests.delete(requestId);
          // Processa eventuale ultima linea residua
          const lastLine = sseBuffer.trim();
          if (lastLine.startsWith('data:')) {
            const data = lastLine.replace(/^data:\s*/, '');
            if (data !== '[DONE]' && data) {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) onSseChunk(delta, fullContent);
              } catch (e) { /* skip */ }
            }
          }
          resolve({ requestId, statusCode: res.statusCode, body: '', headers: res.headers });
        });
      } else {
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

### 4.5 ipcMain.handle('ai:send') — blocco retry completo

Il blocco completo del `while (retries < MAX_RETRIES)` dentro `ai:send`:

```js
  let retries = 0;

  while (retries < MAX_RETRIES) {
    retries++;

    // Accumulatore per il contenuto (serve per il return finale)
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
      // Con streaming attivo (onSseChunk) il body è vuoto; fallback per errori HTTP
      const errDetail = res.body
        ? res.body.slice(0, 500)
        : `HTTP ${res.statusCode} senza body dettagliato`;
      return { error: `API Error ${res.statusCode}: ${errDetail}` };
    }

    // Se siamo qui, il contenuto è stato già streamato via onSseChunk.
    // Il body è vuoto ma accumulatedContent contiene la risposta completa.
    return { ok: true, content: accumulatedContent || '' };
  }

  return { error: 'Max retries exceeded' };
```

Questo sostituisce interamente il blocco `while (retries < MAX_RETRIES)` esistente nel handler `ai:send`.

---

## 5. Edge Cases

### 5.1 Chunk TCP spezza una linea SSE a meta

**Scenario:** un chunk TCP contiene:
```
chunk 1: "data: {\"choices\":[{\"delta\":{\"con"
chunk 2: "tent\":\"hello\"}}]}\n\n"
```

**Gestione:** lo `sseBuffer` mantiene la linea incompleta dopo l'ultimo `\n`. Quando il chunk 2 arriva, le due meta-linee vengono concatenate e il parsing avviene sulla linea completa. Il pattern `sseBuffer.substring(lineStart)` e `lineStart = 0` dopo ogni ciclo `while` garantisce che la linea parziale resti nel buffer.

### 5.2 Risposta non-SSE (errore del provider)

**Scenario:** il provider restituisce un errore JSON non-SSE (es. 4xx con body `{"error":"..."}`), o la connessione viene rifiutata con status code diverso da 1xx.

**Gestione:** quando `onSseChunk` e attivo, le risposte non-SSE semplicemente non producono chiamate a `onSseChunk` (nessuna linea inizia con `data:`). Il `statusCode` viene comunque restituito. Il check `res.statusCode < 200 || res.statusCode >= 300` in `ai:send` cattura l'errore e return il messaggio appropriato.

Tuttavia, se il provider risponde con 200 ma body JSON non-SSE (caso raro), il `accumulatedContent` resta vuoto. Il return `{ ok: true, content: '' }` e corretto: la risposta vuota verra gestita dal caller come nessun contenuto.

### 5.3 Connessione interrotta

**Scenario:** la connessione cade durante lo streaming.

**Gestione:** il handler `req.on('error')` esistente (riga 215) viene invocato. `pendingRequests` viene pulito e viene restituito `{ statusCode: 0, error: 'Connection error: ...' }`. Il loop retry in `ai:send` lo rileva con `res.statusCode === 0 && res.error` e return l'errore. Il contenuto parzialmente streamato e gia arrivato al renderer — nessun rollback necessario.

### 5.4 Cancel in-flight

**Scenario:** l'utente preme Stop durante lo streaming.

**Gestione:** `ai:cancel` gia esistente (righe 449-462) distrugge la richiesta tramite `req.destroy()`. Questo triggera `req.on('error')` nel handler esistente. Il contenuto gia streamato rimane valido; la richiesta viene semplicemente interrotta. Nessun comportamento cambia.

### 5.5 Retry dopo errore — ricreazione onSseChunk

**Scenario:** `ai:send` fa retry dopo 429/503. Ogni iterazione del loop deve avere il proprio `accumulatedContent`.

**Gestione:** `let accumulatedContent = ''` e dichiarato dentro il `while`, quindi ogni retry parte da zero. Questo e corretto: se il primo tentativo fallisce con 429, non ha streamato nulla e il retry puo ricominciare con un accumulatore vuoto.

### 5.6 Risposta con [DONE] come ultimo evento

**Scenario:** il provider chiude con `data: [DONE]`.

**Gestione:** il parser salta esplicitamente `data === '[DONE]'`. L'ultima linea residua del buffer non verra processata se contiene solo `[DONE]`. Se il provider non invia `[DONE]` e chiude la connessione direttamente, `res.on('end')` processa l'ultima linea residua e resolve correttamente.

---

## 6. Impact Analysis

### File modificati

| File | Modifica | Motivazione |
|------|----------|-------------|
| `electron/main.js` | Refactor `makeRequest()`, refactor loop retry in `ai:send` | Parsing SSE in-line invece che post-body |

### File NON modificati — e perche

| File | Non toccato perche |
|------|-------------------|
| `electron/preload.js` | Espone `ai:send`, `onAiChunk`, `aiCancel` — API invariata. I chunk continuano ad arrivare su `ai:chunk`. |
| `src/core/ai-client.js` | `AIClient.send()` passa `onChunk`, riceve chunk via `ai:chunk` listener — nessun cambiamento nel contratto IPC. |
| `src/ui/ChatUI.js` | Consuma `updateMessageStreaming()` con chunk — invariato. |
| `src/core/agent-runner.js` | Usa `sendWithToolUse` con `stream: false` — percorso non toccato. |
| `src/core/edit-mode-runner.js` | Chiama `client.send(messages, onChunk)` — il contratto e invariato. |

### Perche l'approccio e a basso rischio

1. Solo `makeRequest()` e `ai:send` vengono toccati. `ai:sendWithTools` non chiama `makeRequest` con `onSseChunk`.
2. Il branching inside `makeRequest` (if `onSseChunk`) assicura che il comportamento bufferizzato originale venga mantenuto per i chiamanti che non passano il parametro.
3. Il protocollo IPC (`ai:send`, `ai:chunk`) rimane identico — nessun cambiamento su preload/renderer.

### Codice rimovibile (opzionale)

Dopo questo refactor, `parseStreamingResponse()` non e piu usato nel flusso principale. Puo essere mantenuto come safety net o rimosso. La spec lo lascia in-place per sicurezza.

---

## 7. Testing Strategy

### 7.1 Test manuale — streaming visibile

1. Aprire MyIDE, impostare un provider compatibile OpenAI (es. Anthropic, OpenRouter)
2. Inviare un prompt in modalita chat semplice (non Agent)
3. **Verifica:** il testo appare progressivamente nella chat, non tutto in una volta
4. **Verifica:** il testo finale e completo e corrisponde alla risposta del provider

### 7.2 Test — Agent mode invariato

1. Passare a modalita Agent
2. Inviare un prompt che triggera tool_use
3. **Verifica:** il tool_use funziona come prima (risposta non-SSE, `stream: false`)

### 7.3 Test — Edit mode invariato

1. Aprire un file, passare a modalita Edit
2. Richiedere una modifica
3. **Verifica:** il diff appare e puo essere applicato

### 7.4 Test — Edge cases

| Scenario | Cosa fare | Risultato atteso |
|----------|-----------|-----------------|
| Connessione lenta / Throttle Network | Usare DevTools Network Throttling a "Slow 3G" | Il testo appare lentamente ma progressivamente |
| Connessione interrotta a meta | Chiudere rete durante lo streaming | Errore mostrato, contenuto parziale visibile |
| Stop durante streaming | Premere Stop mentre il testo e in arrivo | Streaming si ferma, nessun crash |
| Provider non-SSE (errore 500) | Testare con un endpoint fake che torna 500 | Messaggio d'errore mostrato all'utente |
| Retry 429 | Testare con rate-limiter | Retry automatico con backoff, come prima |
| Risposta lunga (>1000 token) | Prompt generativo lungo | Streaming continuo, nessun freeze |

### 7.5 Test — Log verification

Monitorare console di Electron (DevTools main process) durante i test:

- `[AI] Response complete, content length: N` deve apparire quando la risposta e completa
- Nessuno errore `Parse error` nel log (se appare, il provider ha un formato SSE non standard)
- `[AI] Rate limited` solo quando effettivamente rate-limited

### 7.6 Criteri di successo

- Il testo appare progressivamente nella UI durante la generazione (non in un blocco)
- Il contenuto completo corrisponde alla risposta del provider (zero byte persi)
- `ai:sendWithTools` continua a funzionare senza regressioni
- Nessun crash del main process durante test di edge cases
- `ai:cancel` interrompe lo streaming correttamente
