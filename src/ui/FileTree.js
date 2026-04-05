import { escapeHtml } from '../core/utils.js';

export default class FileTree {
  constructor(onFileClick) {
    this.treeEl = document.getElementById('file-tree');
    this.onFileClick = onFileClick;
    this.rootPath = null;
    this.treeData = null;
  }

  async loadFolder(folderPath) {
    this.rootPath = folderPath;
    if (!this.treeEl) return;
    if (!window.api) return;

    const result = await window.api.fsListDir(folderPath);

    if (result.ok) {
      this.treeData = result.items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      this.render();
    }
  }

  render() {
    if (!this.treeData || !this.treeEl) return;
    this.treeEl.innerHTML = '';
    this.renderItems(this.treeData, 0);
  }

  renderItems(items, depth) {
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'file-tree-item' + (item.isDirectory ? ' dir' : '');
      el.style.paddingLeft = `${8 + depth * 12}px`;
      el.dataset.path = item.path;

      const iconChar = item.isDirectory ? (item._expanded ? '▾' : '▸') : '·';
      el.innerHTML = `<span class="icon">${iconChar}</span><span>${escapeHtml(item.name)}</span>`;

      el.addEventListener('click', async () => {
        if (item.isDirectory) {
          item._expanded = !item._expanded;
          if (item._expanded && !item.children) {
            if (!window.api) return;
            const result = await window.api.fsListDir(item.path);
            if (result.ok) {
              item.children = result.items.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
              });
            } else {
              item.children = [];
            }
          }
          this.render();
        } else if (this.onFileClick) {
          this.onFileClick(item.path);
        }
      });

      this.treeEl.appendChild(el);

      if (item.isDirectory && item._expanded && item.children) {
        this.renderItems(item.children, depth + 1);
      }
    }
  }

}
