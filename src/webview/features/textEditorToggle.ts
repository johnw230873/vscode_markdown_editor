// "Text Editor" status-bar button: posts a message to the extension host to
// toggle the current document to VS Code's built-in Text Editor (and back).
//
// If the user has a non-collapsed selection in the visual editor when they
// click the button, we also compute the equivalent markdown character offsets
// and send them along — so the text editor can auto-select the same text.
//
// This is the in-webview counterpart of the `visualMarkdownEditor.toggleTextEditor`
// command. The keyboard shortcut (Ctrl+Alt+V) bypasses the webview, so it
// can't carry a selection — only the button click can.

import { postMessage } from '../vscodeApi';
import { getMarkdownOffsetsForSelection } from './selectionMapping';

export function initTextEditorToggle(): void {
  const btn = document.getElementById('toggleTextEditorBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const offsets = getMarkdownOffsetsForSelection();
    if (offsets) {
      postMessage({
        type: 'toggleTextEditor',
        markdown: offsets.markdown,
        startOffset: offsets.startOffset,
        endOffset: offsets.endOffset,
      });
    } else {
      // No selection (or collapsed cursor) — just toggle without selection.
      postMessage({ type: 'toggleTextEditor' });
    }
  });
}
