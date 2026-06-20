// Source view toggle (WYSIWYG <-> raw markdown) with cursor-position
// preservation. Also handles the status-bar cursor-position display.

import {
  state,
  editor,
  editorContainer,
  editorWrapper,
  sourceEditor,
  sourceContainer,
} from '../state';
import { markdownToHtml, htmlToMarkdown } from '../markdown';
import { scheduleSync } from '../sync';
import { scheduleNavRefresh } from './outline';
import { requestSpellCheck } from '../spellcheck';

/**
 * Walk from the cursor up to the nearest block element, then try to find the
 * markdown line whose stripped text matches the start of the block's text.
 * Falls back to a proportional offset if no match is found.
 */
function getSourceCharOffsetForCursor(md: string): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return 0;

  const mdLines = md.split('\n');

  // Walk up from the cursor node to find the nearest block-level element
  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV', 'TD', 'TH', 'HR']);
  let blockEl: Element | null = null;
  let cur: Node | null = range.startContainer;
  while (cur && cur !== editor) {
    if (cur.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((cur as Element).tagName)) {
      blockEl = cur as Element;
      break;
    }
    cur = cur.parentNode;
  }

  let targetLine = 0;
  let matched = false;

  if (blockEl) {
    // Strip markdown-syntax characters from each line and look for a line whose
    // plain text matches the start of the block element's text content.
    const needle = (blockEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (needle.length >= 3) {
      for (let i = 0; i < mdLines.length; i++) {
        const stripped = mdLines[i]
          .replace(/^[#\s\-*+>`|[\]!]+/, '')  // strip leading syntax
          .trim()
          .replace(/\s+/g, ' ');
        if (stripped.length >= 3 && needle.startsWith(stripped.slice(0, Math.min(stripped.length, 30)))) {
          targetLine = i;
          matched = true;
          break;
        }
      }
    }
  }

  if (!matched) {
    // Proportional fallback: use ratio of plain-text position to total plain text
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let textBefore = '';
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        textBefore += (node.textContent ?? '').slice(0, range.startOffset);
        break;
      }
      textBefore += node.textContent ?? '';
    }
    const total = editor.innerText || '';
    if (total.length > 0) {
      targetLine = Math.floor((textBefore.length / total.length) * mdLines.length);
    }
  }

  const clamped = Math.max(0, Math.min(targetLine, mdLines.length - 1));
  // Convert line number to character offset in the markdown string
  return mdLines.slice(0, clamped).join('\n').length + (clamped > 0 ? 1 : 0);
}

export function initSourceView(): void {
  document.getElementById('toggleSourceBtn')!.addEventListener('click', () => {
    state.isSourceView = !state.isSourceView;
    document.getElementById('toggleSourceBtn')!.classList.toggle('active', state.isSourceView);
    if (state.isSourceView) {
      const md = htmlToMarkdown(editor.innerHTML);
      const charOffset = getSourceCharOffsetForCursor(md);
      sourceEditor.value = md;
      editorWrapper.style.display = 'none';
      sourceContainer.style.display = 'flex';
      sourceEditor.focus();
      sourceEditor.setSelectionRange(charOffset, charOffset);
    } else {
      const md = sourceEditor.value;
      editor.innerHTML = markdownToHtml(md);
      sourceContainer.style.display = 'none';
      editorWrapper.style.display = 'flex';
      editor.focus();
      scheduleNavRefresh();
    }
  });
}

/** Update the "Ln X, Col Y" status-bar readout on every selection change. */
export function initCursorTracking(): void {
  document.addEventListener('selectionchange', () => {
    if (state.isSourceView) return;
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

/** Re-export so other modules can re-run spell check after toggling back to WYSIWYG. */
export { requestSpellCheck };
