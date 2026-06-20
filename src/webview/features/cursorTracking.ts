// Cursor position tracking — updates the "Ln X, Col Y" status-bar readout on
// every selection change inside the editor.
//
// (The previous source-view toggle was removed in favour of swapping to VS
// Code's built-in Text Editor via the `visualMarkdownEditor.toggleTextEditor`
// command — that gives users real syntax highlighting, multi-cursor,
// Copilot Chat support, etc. for raw markdown editing.)

import { state, editor } from '../state';

/** Update the "Ln X, Col Y" status-bar readout on every selection change. */
export function initCursorTracking(): void {
  document.addEventListener('selectionchange', () => {
    const cursorEl = document.getElementById('cursorPosition');
    if (!cursorEl) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { cursorEl.textContent = ''; return; }
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) { cursorEl.textContent = ''; return; }
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let text = '';
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) { text += (node.textContent ?? '').slice(0, range.startOffset); break; }
      text += node.textContent ?? '';
    }
    const lines = text.split('\n');
    cursorEl.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  });
}
