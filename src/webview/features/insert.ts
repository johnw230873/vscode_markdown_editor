// "Insert" toolbar actions: task list, mark/highlight, link (modal), image
// (delegated to extension), inline code, code block (modal), blockquote, hr,
// table (modal).

import { state, editor } from '../state';
import { execCmd, scheduleSync } from '../sync';
import { state as _unused } from '../state'; // ensure state import isn't elided if only types use it
import { escapeHtml } from '../utils';
import { postMessage } from '../vscodeApi';

void _unused;

export function initInsert(): void {
  initTaskList();
  initMark();
  initLink();
  initImage();
  initInlineCode();
  initCodeBlock();
  initBlockquote();
  initHr();
  initTable();
}

function initTaskList(): void {
  document.getElementById('taskListBtn')!.addEventListener('click', () => {
    const html = `<ul class="task-list"><li class="task-list-item"><input type="checkbox" onclick="this.parentElement.classList.toggle('checked', this.checked); scheduleSync();"> Task item</li></ul>`;
    execCmd('insertHTML', html);
  });
}

function initMark(): void {
  document.getElementById('markBtn')!.addEventListener('click', () => {
    const sel = window.getSelection();
    const content = sel && sel.toString() ? escapeHtml(sel.toString()) : 'highlighted text';
    execCmd('insertHTML', `<mark>${content}</mark>`);
  });
}

function initLink(): void {
  document.getElementById('linkBtn')!.addEventListener('click', () => {
    state.editingLinkElement = null;
    const modal = document.getElementById('linkModal')!;
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString() : '';
    (document.getElementById('linkText') as HTMLInputElement).value = selectedText;
    (document.getElementById('linkUrl') as HTMLInputElement).value = '';
    (document.getElementById('linkTitle') as HTMLInputElement).value = '';
    (document.getElementById('linkNewTab') as HTMLInputElement).checked = false;
    modal.style.display = 'flex';
    (document.getElementById('linkUrl') as HTMLInputElement).focus();
  });

  document.getElementById('linkInsertOk')!.addEventListener('click', () => {
    const url = (document.getElementById('linkUrl') as HTMLInputElement).value;
    const text = (document.getElementById('linkText') as HTMLInputElement).value || url;
    const title = (document.getElementById('linkTitle') as HTMLInputElement).value;
    const newTab = (document.getElementById('linkNewTab') as HTMLInputElement).checked;

    if (url) {
      if (state.editingLinkElement) {
        state.editingLinkElement.href = url;
        state.editingLinkElement.textContent = text;
        state.editingLinkElement.title = title;
        if (newTab) state.editingLinkElement.setAttribute('target', '_blank');
        else state.editingLinkElement.removeAttribute('target');
        state.editingLinkElement = null;
        state.hasUserEdited = true;
        scheduleSync();
      } else {
        let html = `<a href="${escapeHtml(url)}"`;
        if (title) html += ` title="${escapeHtml(title)}"`;
        if (newTab) html += ` target="_blank"`;
        html += `>${escapeHtml(text)}</a>`;
        execCmd('insertHTML', html);
      }
    }
    document.getElementById('linkModal')!.style.display = 'none';
  });

  document.getElementById('linkInsertCancel')!.addEventListener('click', () => {
    document.getElementById('linkModal')!.style.display = 'none';
  });
}

function initImage(): void {
  document.getElementById('imageBtn')!.addEventListener('click', () => {
    postMessage({ type: 'insertImage' });
  });
}

function initInlineCode(): void {
  document.getElementById('inlineCodeBtn')!.addEventListener('click', () => {
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      execCmd('insertHTML', `<code>${escapeHtml(sel.toString())}</code>`);
    } else {
      execCmd('insertHTML', '<code>code</code>');
    }
  });
}

function initCodeBlock(): void {
  document.getElementById('codeBlockBtn')!.addEventListener('click', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) state.savedCodeRange = sel.getRangeAt(0).cloneRange();
    (document.getElementById('codeLanguageSelect') as HTMLSelectElement).value = '';
    document.getElementById('codeBlockModal')!.style.display = 'flex';
  });

  document.getElementById('codeBlockInsertOk')!.addEventListener('click', () => {
    const lang = (document.getElementById('codeLanguageSelect') as HTMLSelectElement).value;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    document.getElementById('codeBlockModal')!.style.display = 'none';
    editor.focus();
    if (state.savedCodeRange) {
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(state.savedCodeRange); }
      state.savedCodeRange = null;
    }
    const selectedText = window.getSelection()?.toString() || 'code here';
    document.execCommand('insertHTML', false, `<pre><code${langAttr}>${escapeHtml(selectedText)}</code></pre><p><br></p>`);
    state.hasUserEdited = true;
    scheduleSync();
  });

  document.getElementById('codeBlockInsertCancel')!.addEventListener('click', () => {
    document.getElementById('codeBlockModal')!.style.display = 'none';
    state.savedCodeRange = null;
  });
}

function initBlockquote(): void {
  document.getElementById('blockquoteBtn')!.addEventListener('click', () => {
    execCmd('formatBlock', '<blockquote>');
  });
}

function initHr(): void {
  document.getElementById('hrBtn')!.addEventListener('click', () => {
    execCmd('insertHTML', '<hr><p><br></p>');
  });
}

function initTable(): void {
  document.getElementById('tableBtn')!.addEventListener('click', () => {
    // Save current selection/cursor position before modal steals focus
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      state.savedTableRange = sel.getRangeAt(0).cloneRange();
    }
    // Reset inputs to defaults
    (document.getElementById('tableRows') as HTMLInputElement).value = '3';
    (document.getElementById('tableCols') as HTMLInputElement).value = '3';
    document.getElementById('tableModal')!.style.display = 'flex';
    (document.getElementById('tableRows') as HTMLInputElement).focus();
  });

  document.getElementById('tableInsertOk')!.addEventListener('click', () => {
    const rows = parseInt((document.getElementById('tableRows') as HTMLInputElement).value) || 3;
    const cols = parseInt((document.getElementById('tableCols') as HTMLInputElement).value) || 3;
    const hasHeader = (document.getElementById('tableHeader') as HTMLInputElement).checked;

    let html = '<table>';
    if (hasHeader) {
      html += '<thead><tr>';
      for (let c = 0; c < cols; c++) {
        html += `<th>Header ${c + 1}</th>`;
      }
      html += '</tr></thead>';
    }
    html += '<tbody>';
    const startRow = hasHeader ? 1 : 0;
    for (let r = startRow; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        html += '<td>&nbsp;</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';

    document.getElementById('tableModal')!.style.display = 'none';

    // Restore focus and selection in the editor before inserting
    editor.focus();
    if (state.savedTableRange) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(state.savedTableRange);
      }
      state.savedTableRange = null;
    }

    document.execCommand('insertHTML', false, html);
    state.hasUserEdited = true;
    scheduleSync();
  });

  document.getElementById('tableInsertCancel')!.addEventListener('click', () => {
    document.getElementById('tableModal')!.style.display = 'none';
    state.savedTableRange = null;
  });
}
