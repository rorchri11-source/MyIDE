/**
 * Stima e gestione dei token per il context window.
 * Approssimazione: ~4 caratteri per token (modello generico).
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countMessageTokens(msg) {
  // Approssimazione: contenuto + tool_calls + overhead per ruolo (3 tok)
  let chars = msg.content ? msg.content.length : 0;
  if (msg.tool_calls) {
    chars += JSON.stringify(msg.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + 3;
}

export function countMessagesTokens(messages) {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
}

/**
 * Tronca i messaggi mantenendo il system message e riempiendo
 * dal più recente al più vecchio fino a maxTokens.
 */
export function truncateMessages(messages, maxTokens) {
  if (messages.length === 0) return messages;

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // Se non c'è system, considera tutti i messaggi
  const baseMessages = systemMsg ? [systemMsg] : [];
  const toTruncate = systemMsg ? nonSystem : messages;

  let baseTokens = systemMsg ? countMessageTokens(systemMsg) : 0;

  // Mantieni messaggi dal più recente al più vecchio
  const kept = [];
  for (let i = toTruncate.length - 1; i >= 0; i--) {
    const msgTokens = countMessageTokens(toTruncate[i]);
    if (baseTokens + msgTokens > maxTokens) break;
    kept.unshift(toTruncate[i]);
    baseTokens += msgTokens;
  }

  return [...baseMessages, ...kept];
}
