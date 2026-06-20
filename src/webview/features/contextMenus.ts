// Right-click context menus for the editor:
//   - Misspelled word: show suggestions, add to dictionary, cut/copy
//   - Image: delete from doc, delete from doc + file
//   - Link: edit, copy URL, remove
//   - Table cell: insert/delete rows/columns/whole table
//
// The dispatcher lives on `editor.contextmenu`. Each menu is a detached
// `<div class="context-menu">` appended to <body>; only one is ever visible.

import { state, editor } from '../state';
import { scheduleSync, execCmd } from '../sync';
import { escapeHtml, clampToViewport } from '../utils';
import { getSuggestions, addCustomWord, replaceWordAt } from '../spellcheck';
import { postMessage } from '../vscodeApi';

interface WebviewWindow extends Window {
  __baseUri?: string;
  __attachmentsBaseUri?: string;
}

function getWebviewWindow(): WebviewWindow {
  return window as unknown as WebviewWindow;
}

export function removeContextMenu(): void {
  const existing = document.getElementById('spellContextMenu');
  if (existing) existing.remove();
}

/** Resolve an <img src="..."> (which may be a webview URI) back to a relative path. */
export function getImageRelativePath(img: HTMLImageElement): string {
  const src = img.getAttribute('src') || '';
  const w = getWebviewWindow();
  const baseUri = w.__baseUri;
  const attachmentsBaseUri = w.__attachmentsBaseUri;
  let relativePath = src;

  if (baseUri && src.startsWith(baseUri + '/')) {
    relativePath = src.slice(baseUri.length + 1);
  } else if (attachmentsBaseUri && src.startsWith(attachmentsBaseUri + '/')) {
    relativePath = src.slice(attachmentsBaseUri.length + 1);
  }
  return relativePath;
}

function getWordAtPoint(x: number, y: number): { node: Text; start: number; end: number; word: string } | null {
  // Try caretRangeAtPoint
  let range: Range | null = null;
  if (document.caretRangeAtPoint) {
    range = document.caretRangeAtPoint(x, y);
  }
  // Fallback: use current selection
  if (!range) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0);
    }
  }
  if (!range) return null;

  let node = range.startContainer;
  let offset = range.startOffset;

  // If we landed on an element, try its text child
  if (node.nodeType !== Node.TEXT_NODE) {
    const child = node.childNodes[offset] || node.childNodes[offset - 1];
    if (child && child.nodeType === Node.TEXT_NODE) {
      node = child;
      offset = 0;
    } else {
      return null;
    }
  }

  const text = node.textContent || '';
  const wordRegex = /[a-zA-Z'\u2019]+/g;
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    if (offset >= match.index && offset <= match.index + match[0].length) {
      const word = match[0].replace(/^['']+|['']+$/g, '');
      if (word.length < 2) continue;
      return { node: node as Text, start: match.index, end: match.index + match[0].length, word };
    }
  }
  return null;
}

function showSpellContextMenu(word: string, suggestions: string[]): void {
  removeContextMenu();

  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = state.pendingContextMenuPos.x + 'px';
  menu.style.top = state.pendingContextMenuPos.y + 'px';

  // Spelling suggestions
  if (suggestions.length > 0) {
    suggestions.forEach((suggestion) => {
      const item = document.createElement('button');
      item.className = 'context-menu-item spell-suggestion';
      item.textContent = suggestion;
      item.addEventListener('click', () => {
        replaceWordAt(suggestion);
        removeContextMenu();
      });
      menu.appendChild(item);
    });
  } else {
    const noSugg = document.createElement('div');
    noSugg.className = 'context-menu-item disabled';
    noSugg.textContent = 'No suggestions';
    menu.appendChild(noSugg);
  }

  // Divider
  const divider = document.createElement('div');
  divider.className = 'context-menu-divider';
  menu.appendChild(divider);

  // Add to dictionary option
  const addDict = document.createElement('button');
  addDict.className = 'context-menu-item';
  addDict.textContent = `Add "${word}" to dictionary`;
  addDict.addEventListener('click', () => {
    addCustomWord(word);
    removeContextMenu();
  });
  menu.appendChild(addDict);

  // Standard edit options divider
  const divider2 = document.createElement('div');
  divider2.className = 'context-menu-divider';
  menu.appendChild(divider2);

  // Standard options
  [{ label: 'Cut', cmd: 'cut' }, { label: 'Copy', cmd: 'copy' }].forEach(({ label, cmd }) => {
    const item = document.createElement('button');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.addEventListener('click', () => {
      document.execCommand(cmd);
      removeContextMenu();
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  clampToViewport(menu);
}

function showImageContextMenu(img: HTMLImageElement, x: number, y: number): void {
  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Delete image (remove from document only)
  const deleteItem = document.createElement('button');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete Image';
  deleteItem.addEventListener('click', () => {
    img.remove();
    state.hasUserEdited = true;
    scheduleSync();
    removeContextMenu();
  });
  menu.appendChild(deleteItem);

  // Delete image and source file
  const deleteWithFileItem = document.createElement('button');
  deleteWithFileItem.className = 'context-menu-item';
  deleteWithFileItem.textContent = 'Delete Image and Source';
  deleteWithFileItem.addEventListener('click', () => {
    const relativePath = getImageRelativePath(img);
    img.remove();
    state.hasUserEdited = true;
    scheduleSync();
    postMessage({ type: 'deleteImage', relativePath });
    removeContextMenu();
  });
  menu.appendChild(deleteWithFileItem);

  document.body.appendChild(menu);
  clampToViewport(menu);
}

function showLinkContextMenu(anchor: HTMLAnchorElement, x: number, y: number): void {
  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const editItem = document.createElement('button');
  editItem.className = 'context-menu-item';
  editItem.textContent = 'Edit Link';
  editItem.addEventListener('click', () => {
    state.editingLinkElement = anchor;
    (document.getElementById('linkUrl') as HTMLInputElement).value = anchor.getAttribute('href') || '';
    (document.getElementById('linkText') as HTMLInputElement).value = anchor.textContent || '';
    (document.getElementById('linkTitle') as HTMLInputElement).value = anchor.title || '';
    (document.getElementById('linkNewTab') as HTMLInputElement).checked = anchor.target === '_blank';
    document.getElementById('linkModal')!.style.display = 'flex';
    (document.getElementById('linkUrl') as HTMLInputElement).focus();
    removeContextMenu();
  });
  menu.appendChild(editItem);

  const copyItem = document.createElement('button');
  copyItem.className = 'context-menu-item';
  copyItem.textContent = 'Copy Link URL';
  copyItem.addEventListener('click', () => {
    navigator.clipboard.writeText(anchor.getAttribute('href') || '').catch(() => {});
    removeContextMenu();
  });
  menu.appendChild(copyItem);

  const linkDivider = document.createElement('div');
  linkDivider.className = 'context-menu-divider';
  menu.appendChild(linkDivider);

  const removeItem = document.createElement('button');
  removeItem.className = 'context-menu-item';
  removeItem.textContent = 'Remove Link';
  removeItem.addEventListener('click', () => {
    const text = document.createTextNode(anchor.textContent || '');
    anchor.parentNode?.replaceChild(text, anchor);
    state.hasUserEdited = true;
    scheduleSync();
    removeContextMenu();
  });
  menu.appendChild(removeItem);

  document.body.appendChild(menu);
  clampToViewport(menu);
}

function showTableContextMenu(cell: HTMLTableCellElement, x: number, y: number): void {
  const row = cell.parentElement as HTMLTableRowElement;
  const table = cell.closest('table') as HTMLTableElement;
  if (!table) return;
  const colIndex = Array.from(row.cells).indexOf(cell);

  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const tableActions: Array<{ label: string; fn: () => void }> = [
    {
      label: 'Add Row Above',
      fn: () => {
        const newRow = row.cloneNode(true) as HTMLTableRowElement;
        Array.from(newRow.cells).forEach(c => { c.innerHTML = '&nbsp;'; });
        row.parentNode!.insertBefore(newRow, row);
      },
    },
    {
      label: 'Add Row Below',
      fn: () => {
        const newRow = row.cloneNode(true) as HTMLTableRowElement;
        Array.from(newRow.cells).forEach(c => { c.innerHTML = '&nbsp;'; });
        row.parentNode!.insertBefore(newRow, row.nextSibling);
      },
    },
    {
      label: 'Add Column Left',
      fn: () => {
        Array.from(table.rows).forEach(r => {
          const ref = r.cells[colIndex];
          if (ref) {
            const newCell = document.createElement(ref.tagName.toLowerCase());
            newCell.innerHTML = '&nbsp;';
            ref.parentNode!.insertBefore(newCell, ref);
          }
        });
      },
    },
    {
      label: 'Add Column Right',
      fn: () => {
        Array.from(table.rows).forEach(r => {
          const ref = r.cells[colIndex];
          if (ref) {
            const newCell = document.createElement(ref.tagName.toLowerCase());
            newCell.innerHTML = '&nbsp;';
            ref.parentNode!.insertBefore(newCell, ref.nextSibling);
          }
        });
      },
    },
  ];

  tableActions.forEach(({ label, fn }) => {
    const item = document.createElement('button');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.addEventListener('click', () => { fn(); state.hasUserEdited = true; scheduleSync(); removeContextMenu(); });
    menu.appendChild(item);
  });

  const td1 = document.createElement('div');
  td1.className = 'context-menu-divider';
  menu.appendChild(td1);

  const delRow = document.createElement('button');
  delRow.className = 'context-menu-item';
  delRow.textContent = 'Delete Row';
  delRow.addEventListener('click', () => {
    if (table.rows.length > 1) row.remove(); else table.remove();
    state.hasUserEdited = true; scheduleSync(); removeContextMenu();
  });
  menu.appendChild(delRow);

  const delCol = document.createElement('button');
  delCol.className = 'context-menu-item';
  delCol.textContent = 'Delete Column';
  delCol.addEventListener('click', () => {
    if (row.cells.length > 1) {
      Array.from(table.rows).forEach(r => { if (r.cells[colIndex]) r.deleteCell(colIndex); });
    } else {
      table.remove();
    }
    state.hasUserEdited = true; scheduleSync(); removeContextMenu();
  });
  menu.appendChild(delCol);

  const td2 = document.createElement('div');
  td2.className = 'context-menu-divider';
  menu.appendChild(td2);

  const delTable = document.createElement('button');
  delTable.className = 'context-menu-item';
  delTable.textContent = 'Delete Table';
  delTable.addEventListener('click', () => {
    table.remove();
    state.hasUserEdited = true; scheduleSync(); removeContextMenu();
  });
  menu.appendChild(delTable);

  document.body.appendChild(menu);
  clampToViewport(menu);
}

export function initContextMenus(): void {
  editor.addEventListener('contextmenu', (e: MouseEvent) => {
    removeContextMenu();

    const target = e.target as HTMLElement;

    // Image
    if (target.tagName === 'IMG') {
      e.preventDefault();
      e.stopPropagation();
      showImageContextMenu(target as HTMLImageElement, e.clientX, e.clientY);
      return;
    }

    // Link
    const anchor = target.closest('a');
    if (anchor && editor.contains(anchor)) {
      e.preventDefault();
      e.stopPropagation();
      showLinkContextMenu(anchor as HTMLAnchorElement, e.clientX, e.clientY);
      return;
    }

    // Table cell
    const tableCell = target.closest<HTMLTableCellElement>('td, th');
    if (tableCell && editor.contains(tableCell)) {
      e.preventDefault();
      e.stopPropagation();
      showTableContextMenu(tableCell, e.clientX, e.clientY);
      return;
    }

    // Spell check
    const wordInfo = getWordAtPoint(e.clientX, e.clientY);
    if (wordInfo && state.currentMisspelled.has(wordInfo.word.toLowerCase())) {
      e.preventDefault();
      e.stopPropagation();
      state.contextMenuTarget = wordInfo;
      state.pendingContextMenuPos = { x: e.clientX, y: e.clientY };
      const suggestions = getSuggestions(wordInfo.word);
      showSpellContextMenu(wordInfo.word, suggestions);
    }
  });

  // Close context menu on click elsewhere
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('spellContextMenu');
    if (menu && !menu.contains(e.target as Node)) {
      removeContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeContextMenu();
    }
  });
}

// Re-export escapeHtml so callers that imported it from this module before
// the split still resolve. (Not strictly necessary but harmless.)
export { escapeHtml, execCmd };
