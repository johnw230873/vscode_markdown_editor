// "Text Editor" status-bar button: posts a message to the extension host to
// toggle the current document to VS Code's built-in Text Editor (and back).
//
// This is the in-webview counterpart of the `visualMarkdownEditor.toggleTextEditor`
// command. It exists so the user has a visible button to click (not just a
// keyboard shortcut), and because the webview can't invoke VS Code commands
// directly — it has to ask the extension host to do it.

import { postMessage } from '../vscodeApi';

export function initTextEditorToggle(): void {
  const btn = document.getElementById('toggleTextEditorBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    postMessage({ type: 'toggleTextEditor' });
  });
}
