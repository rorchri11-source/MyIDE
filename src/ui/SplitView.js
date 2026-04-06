/**
 * Splitter regolabile tra Chat e Editor con glow effect
 */
export default class SplitView {
  constructor(chatEl, editorEl) {
    this.chatEl = chatEl;
    this.editorEl = editorEl;
    this.ratio = 0.5;
    this.isDragging = false;
    this.minRatio = 0.2;
    this.maxRatio = 0.8;

    this.init();
  }

  init() {
    this.createSplitter();

    const saved = localStorage.getItem('myide-split-ratio');
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0.1 && parsed <= 0.9) {
        this.ratio = parsed;
        this.apply();
      }
    }

    this.splitter.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.splitter.style.width = '8px';
      this.splitter.style.boxShadow = '0 0 16px var(--accent-glow), 0 0 32px var(--cyan-glow)';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    this._onMouseMove = (e) => {
      if (!this.isDragging) return;
      const containerRect = this.editorEl.parentElement.getBoundingClientRect();
      const relativeX = e.clientX - containerRect.left;
      const newRatio = relativeX / containerRect.width;
      this.ratio = Math.max(this.minRatio, Math.min(this.maxRatio, newRatio));
      this.apply();
    };

    this._onMouseUp = () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.splitter.style.width = '';
        this.splitter.style.boxShadow = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('myide-split-ratio', this.ratio.toString());
      }
    };

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
  }

  destroy() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  createSplitter() {
    this.splitter = document.createElement('div');
    this.splitter.className = 'splitter';
    this.editorEl.parentElement.insertBefore(this.splitter, this.editorEl.nextSibling);
  }

  apply() {
    this.editorEl.style.flex = `${this.ratio}`;
    this.chatEl.style.flex = `${1 - this.ratio}`;
  }
}
