/**
 * CodeMirror 6 editor component.
 * Sostituisce la textarea con un editor con syntax highlighting.
 */
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { history, historyKeymap } from '@codemirror/commands';
import { keymap, lineNumbers, drawSelection, highlightActiveLine, dropCursor } from '@codemirror/view';
import { highlightSelectionMatches } from '@codemirror/search';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';

const LANG_MAP = {
  js: javascript, jsx: javascript, mjs: javascript, cjs: javascript, ts: javascript, tsx: javascript,
  py: python, pyw: python,
  css: css, html: html, htm: html, json: json
};

const minimalSetup = [
  lineNumbers(), history(), foldGutter(), drawSelection(), dropCursor(),
  indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
  highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap])
];

export default class CodeEditor {
  constructor(containerEl) { this.containerEl = containerEl; this.view = null; }

  _langSupport(ext) { const fn = LANG_MAP[ext]; return fn ? fn() : null; }

  create(initialDoc = '', filePath = '') {
    const ext = filePath.split('.').pop().toLowerCase();
    const extensions = [
      ...minimalSetup, oneDark, EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this._onChanged) this._onChanged(update.state.doc.toString());
      })
    ];
    const lang = this._langSupport(ext);
    if (lang) extensions.push(lang);

    this.view = new EditorView({ state: EditorState.create({ doc: initialDoc, extensions }), parent: this.containerEl });
  }

  getDoc() { return this.view?.state.doc.toString() || ''; }

  setDoc(text) {
    if (this.view) this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  onChanged(callback) { this._onChanged = callback; }

  destroy() { this.view?.destroy(); this.view = null; }
}
