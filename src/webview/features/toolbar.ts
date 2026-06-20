// Toolbar wiring: standard execCommand buttons, heading select, font-size
// select, plus active-state tracking on selection changes.

import { state, editor, headingSelect, fontSizeSelect } from '../state';
import { execCmd } from '../sync';

export function initToolbar(): void {
  // Standard toolbar buttons
  document.querySelectorAll('.toolbar-btn[data-command]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const command = (btn as HTMLElement).dataset.command!;
      execCmd(command);
    });
  });

  // Heading select
  headingSelect.addEventListener('change', () => {
    const value = headingSelect.value;
    if (value === 'p') {
      execCmd('formatBlock', '<p>');
    } else {
      execCmd('formatBlock', `<${value}>`);
    }
    headingSelect.value = value;
  });

  // Font size select
  fontSizeSelect.addEventListener('change', () => {
    const value = fontSizeSelect.value;
    if (value) {
      execCmd('fontSize', value);
    }
    fontSizeSelect.value = '';
  });

  // Active-state tracking
  editor.addEventListener('keyup', updateToolbarState);
  editor.addEventListener('mouseup', updateToolbarState);
}

function updateToolbarState(): void {
  // Update heading select
  const block = document.queryCommandValue('formatBlock');
  const headingMap: Record<string, string> = {
    h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
    p: 'p', div: 'p',
  };
  headingSelect.value = headingMap[block.toLowerCase()] || 'p';

  // Highlight active formatting buttons
  const commands = ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript'];
  commands.forEach((cmd) => {
    const btn = document.querySelector(`.toolbar-btn[data-command="${cmd}"]`);
    if (btn) {
      btn.classList.toggle('active', document.queryCommandState(cmd));
    }
  });
}

// Re-exported so consumers can mark the document dirty without going through
// the deprecated execCommand path (e.g. for inline link edits).
export function markEdited(): void {
  state.hasUserEdited = true;
}
