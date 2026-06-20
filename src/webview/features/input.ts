// Editor input + keyboard shortcut wiring.
// - Mark document dirty + schedule sync + refresh outline on every input.
// - Ctrl+K opens the link modal.
// - Tab inside list items indents/outdents (instead of leaving the editor).

import { state, editor, sourceEditor } from '../state';
import { scheduleSync } from '../sync';
import { scheduleNavRefresh } from './outline';
import { requestSpellCheck } from '../spellcheck';
import { execCmd } from '../sync';

export function initInput(): void {
  // WYSIWYG input
  editor.addEventListener('input', () => {
    state.hasUserEdited = true;
    scheduleSync();
    scheduleNavRefresh();
    requestSpellCheck();
  });

  // Source-view input
  sourceEditor.addEventListener('input', () => {
    state.hasUserEdited = true;
    scheduleSync();
  });

  // Keyboard shortcuts
  editor.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'k':
          e.preventDefault();
          document.getElementById('linkBtn')!.click();
          break;
        case 's':
          // Let VS Code handle save
          break;
      }
    }
    // Tab in lists for indentation
    if (e.key === 'Tab') {
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const li = (sel.anchorNode as HTMLElement).closest?.('li') ||
          (sel.anchorNode.parentElement as HTMLElement)?.closest?.('li');
        if (li) {
          e.preventDefault();
          if (e.shiftKey) {
            execCmd('outdent');
          } else {
            execCmd('indent');
          }
        }
      }
    }
  });
}
