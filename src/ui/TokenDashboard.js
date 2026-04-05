/**
 * Token Usage Dashboard — grafico a barre semplice
 * per visualizzare il consumo di token per messaggio.
 */
export default class TokenDashboard {
  constructor() {
    this.messageTokens = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  recordMessage(role, tokenCount) {
    this.messageTokens.push({ role, tokens: tokenCount, timestamp: Date.now() });
    if (role === 'user' || role === 'system') {
      this.totalInputTokens += tokenCount;
    } else {
      this.totalOutputTokens += tokenCount;
    }
  }

  getTotalTokens() {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  show() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="token-dashboard-modal">
        <div class="modal-header">
          <h2>Token Usage Dashboard</h2>
          <button class="btn-small token-dashboard-close">x</button>
        </div>
        <div class="token-summary">
          <div class="token-stat"><span class="token-stat-label">Input</span><span class="token-stat-value">${this._formatTokens(this.totalInputTokens)}</span></div>
          <div class="token-stat"><span class="token-stat-label">Output</span><span class="token-stat-value">${this._formatTokens(this.totalOutputTokens)}</span></div>
          <div class="token-stat"><span class="token-stat-label">Totale</span><span class="token-stat-value">${this._formatTokens(this.getTotalTokens())}</span></div>
        </div>
        <div class="token-chart">${this._renderChart()}</div>
      </div>`;

    modal.querySelector('.token-dashboard-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  _renderChart() {
    if (this.messageTokens.length === 0) return '<p style="text-align:center;color:var(--text-muted);padding:20px;">No dati disponibili</p>';
    const maxTokens = Math.max(...this.messageTokens.map(m => m.tokens), 1);
    let html = '';
    this.messageTokens.forEach((msg, i) => {
      const heightPct = Math.max(5, (msg.tokens / maxTokens) * 100);
      const color = msg.role === 'user' ? 'var(--red)' : 'var(--amber)';
      html += `<div class="token-bar-item"><div class="token-bar" style="height:${heightPct}px;background:${color};"><span class="token-bar-label">${Math.round(msg.tokens)}</span></div><div class="token-bar-index">#${i + 1}</div></div>`;
    });
    return html;
  }

  _formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toString();
  }

  reset() {
    this.messageTokens = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}
