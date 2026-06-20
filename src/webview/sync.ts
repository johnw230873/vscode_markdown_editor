// Two-way sync glue between the webview DOM and the extension host.
// - `scheduleSync()` debounces a HTML -> MD -> postMessage('edit') round-trip.
// - `execCmd()` is the standard wrapper around document.execCommand that also
//   marks the document as dirty and triggers a sync.
// - `updateWordCount()` refreshes the status-bar counters.

import { state, editor, wordCountEl, charCountEl } from './state';
import { htmlToMarkdown } from './markdown';
import { postMessage } from './vscodeApi';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSync(): void {
  if (state.isUpdatingFromExtension) return;
  if (!state.hasUserEdited) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const md = htmlToMarkdown(editor.innerHTML);
    postMessage({ type: 'edit', content: md });
    updateWordCount(md);
  }, 500);
}

export function updateWordCount(text: string): void {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const chars = text.length;
  wordCountEl.textContent = `Words: ${words}`;
  charCountEl.textContent = `Characters: ${chars}`;
}

export function execCmd(command: string, value?: string): void {
  document.execCommand(command, false, value);
  editor.focus();
  state.hasUserEdited = true;
  scheduleSync();
}
