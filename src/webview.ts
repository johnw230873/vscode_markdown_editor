import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import words from 'an-array-of-english-words';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Spell Check Dictionary (client-side) ──
const dictionary = new Set(words);
['i', 'a', 'vs', 'ok', 'eg', 'ie', 'etc', 'url', 'html', 'css', 'js', 'ts',
 'api', 'ui', 'id', 'pdf', 'http', 'https', 'www', 'dev', 'src', 'img'].forEach(w => dictionary.add(w));

function checkWord(word: string): boolean {
  if (word.length < 2) return true;
  const lower = word.toLowerCase();
  return dictionary.has(lower) || dictionary.has(word);
}

function edits1(word: string): string[] {
  const results: string[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i <= word.length; i++) {
    if (i < word.length) results.push(word.slice(0, i) + word.slice(i + 1));
    for (const c of letters) results.push(word.slice(0, i) + c + word.slice(i));
    if (i < word.length) {
      for (const c of letters) results.push(word.slice(0, i) + c + word.slice(i + 1));
    }
    if (i < word.length - 1) results.push(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  return results;
}

function getSuggestions(word: string, max: number = 6): string[] {
  const lower = word.toLowerCase();
  const suggestions: string[] = [];
  const seen = new Set<string>();

  for (const candidate of edits1(lower)) {
    if (dictionary.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      suggestions.push(candidate);
      if (suggestions.length >= max) return suggestions;
    }
  }

  // Limited edit distance 2
  if (suggestions.length < max) {
    const e1 = edits1(lower);
    const limit = Math.min(e1.length, 50);
    for (let i = 0; i < limit && suggestions.length < max; i++) {
      for (const candidate of edits1(e1[i])) {
        if (dictionary.has(candidate) && !seen.has(candidate) && candidate !== lower) {
          seen.add(candidate);
          suggestions.push(candidate);
          if (suggestions.length >= max) return suggestions;
        }
      }
    }
  }
  return suggestions;
}

// ── Marked configuration ──
marked.setOptions({
  gfm: true,
  breaks: true,
});

// ── Turndown configuration ──
const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});
turndownService.use(gfm);

// Keep style spans (colors, font-size, etc.)
turndownService.addRule('styledSpan', {
  filter: (node) => {
    return node.nodeName === 'SPAN' && !!(node as HTMLElement).getAttribute('style');
  },
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const style = el.getAttribute('style') || '';
    if (!content.trim()) return '';
    return `<span style="${style}">${content}</span>`;
  },
});

// Keep underline
turndownService.addRule('underline', {
  filter: ['u'],
  replacement: (content) => {
    if (!content.trim()) return '';
    return `<u>${content}</u>`;
  },
});

// Keep superscript/subscript
turndownService.addRule('superscript', {
  filter: ['sup'],
  replacement: (content) => `<sup>${content}</sup>`,
});
turndownService.addRule('subscript', {
  filter: ['sub'],
  replacement: (content) => `<sub>${content}</sub>`,
});

// Keep alignment divs
turndownService.addRule('alignedDiv', {
  filter: (node) => {
    if (node.nodeName !== 'DIV') return false;
    const style = (node as HTMLElement).getAttribute('style') || '';
    return /text-align/.test(style);
  },
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const style = el.getAttribute('style') || '';
    return `<div style="${style}">\n\n${content}\n\n</div>\n\n`;
  },
});

// Keep font tags (from execCommand fontSize)
turndownService.addRule('fontTag', {
  filter: ['font'],
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const color = el.getAttribute('color');
    const size = el.getAttribute('size');
    const face = el.getAttribute('face');
    const styles: string[] = [];
    if (color) styles.push(`color: ${color}`);
    if (size) {
      const sizeMap: Record<string, string> = {
        '1': '8pt', '2': '10pt', '3': '12pt', '4': '14pt',
        '5': '18pt', '6': '24pt', '7': '36pt',
      };
      styles.push(`font-size: ${sizeMap[size] || size}`);
    }
    if (face) styles.push(`font-family: ${face}`);
    if (styles.length === 0) return content;
    return `<span style="${styles.join('; ')}">${content}</span>`;
  },
});

// Task list support
turndownService.addRule('taskListItem', {
  filter: (node) => {
    return (
      node.nodeName === 'LI' &&
      (node as HTMLElement).querySelector('input[type="checkbox"]') !== null
    );
  },
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const checked = checkbox?.checked ? 'x' : ' ';
    const text = content.replace(/^\s*\[.\]\s*/, '').trim();
    return `- [${checked}] ${text}\n`;
  },
});

// Keep mark/highlight
turndownService.addRule('mark', {
  filter: ['mark'],
  replacement: (content) => `<mark>${content}</mark>`,
});

// ── DOM Elements ──
const editor = document.getElementById('editor')!;
const sourceEditor = document.getElementById('sourceEditor') as HTMLTextAreaElement;
const editorContainer = document.getElementById('editorContainer')!;
const sourceContainer = document.getElementById('sourceContainer')!;
const wordCountEl = document.getElementById('wordCount')!;
const charCountEl = document.getElementById('charCount')!;
const navPane = document.getElementById('navPane')!;
const navList = document.getElementById('navList')!;

let isSourceView = false;
let isUpdatingFromExtension = false;
let isNavVisible = false;
let hasUserEdited = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let navUpdateTimer: ReturnType<typeof setTimeout> | null = null;

// ── Navigation Pane ──
function toggleNav(show?: boolean) {
  isNavVisible = show !== undefined ? show : !isNavVisible;
  navPane.style.display = isNavVisible ? 'flex' : 'none';
  const btn = document.getElementById('toggleNavBtn');
  if (btn) btn.classList.toggle('active', isNavVisible);
  if (isNavVisible) refreshNav();
}

function refreshNav() {
  if (!isNavVisible) return;
  const headings = editor.querySelectorAll('h1, h2, h3, h4, h5, h6');
  navList.innerHTML = '';

  headings.forEach((heading) => {
    const text = heading.textContent?.trim();
    if (!text) return; // Skip empty headings
    const level = parseInt(heading.tagName[1]);
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.setAttribute('data-level', String(level));
    btn.textContent = text;
    btn.title = text;
    btn.addEventListener('click', () => {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Highlight briefly
      navList.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
    });
    navList.appendChild(btn);
  });

  if (headings.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '12px';
    empty.style.fontSize = '12px';
    empty.style.opacity = '0.5';
    empty.textContent = 'No headings found';
    navList.appendChild(empty);
  }
}

function scheduleNavRefresh() {
  if (navUpdateTimer) clearTimeout(navUpdateTimer);
  navUpdateTimer = setTimeout(refreshNav, 600);
}

document.getElementById('toggleNavBtn')!.addEventListener('click', () => toggleNav());
document.getElementById('navCloseBtn')!.addEventListener('click', () => toggleNav(false));

// ── Page Mode Toggle ──
const pageModeBtn = document.getElementById('togglePageModeBtn')!;
let isPageMode = false;

pageModeBtn.addEventListener('click', () => {
  isPageMode = !isPageMode;
  editorContainer.classList.toggle('page-mode', isPageMode);
  pageModeBtn.classList.toggle('active', isPageMode);
  if (isPageMode) setZoom(100);
});

// ── Zoom ──
const zoomSlider = document.getElementById('zoomSlider') as HTMLInputElement;
const zoomValue = document.getElementById('zoomValue')!;
let currentZoom = 100;

function setZoom(level: number) {
  currentZoom = Math.max(50, Math.min(200, level));
  editor.style.zoom = `${currentZoom}%`;
  zoomSlider.value = String(currentZoom);
  zoomValue.textContent = `${currentZoom}%`;
}

zoomSlider.addEventListener('input', () => {
  setZoom(parseInt(zoomSlider.value, 10));
});

editorContainer.addEventListener('wheel', (e: WheelEvent) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    setZoom(currentZoom + delta);
  }
}, { passive: false });

// ── Markdown ↔ HTML conversion ──
function markdownToHtml(md: string): string {
  let html = marked.parse(md) as string;
  // Convert task list items
  html = html.replace(
    /<li>\s*\[([ xX])\]\s*/g,
    (_, checked) => {
      const isChecked = checked.toLowerCase() === 'x';
      return `<li class="task-list-item"><input type="checkbox" ${isChecked ? 'checked' : ''} onclick="this.parentElement.classList.toggle('checked', this.checked); scheduleSync();"> `;
    }
  );
  // Resolve relative image paths to webview URIs so images display
  const baseUri = (window as any).__baseUri as string;
  const attachmentsBaseUri = (window as any).__attachmentsBaseUri as string;
  if (baseUri) {
    html = html.replace(
      /<img\s+([^>]*?)src="(?!https?:\/\/|data:|blob:|vscode-)([^"]+)"([^>]*?)>/gi,
      (match, before, src, after) => {
        let actualSrc = src;
        let slashPrefix = false;
        // Leading slash (e.g. /.attachments/img.png) means one directory up
        if (src.startsWith('/.attachments/') || src.startsWith('/.attachments\\')) {
          actualSrc = src.slice(1); // Remove leading /
          slashPrefix = true;
        }
        let base: string;
        if (slashPrefix) {
          // /.attachments/ → resolve from parent (attachmentsBaseUri)
          base = attachmentsBaseUri || baseUri;
        } else {
          // .attachments/ or other relative → resolve from document directory
          base = baseUri;
        }
        const resolved = `${base}/${actualSrc}`;
        const dataAttr = slashPrefix ? ' data-slash-prefix="true"' : '';
        return `<img ${before}src="${resolved}"${dataAttr}${after}>`;
      }
    );
  }
  return html;
}

function htmlToMarkdown(html: string): string {
  // Strip webview base URI from image src before conversion so markdown gets relative paths
  // IMPORTANT: strip baseUri (more specific/longer) BEFORE attachmentsBaseUri (parent)
  // to avoid partial matches leaving folder names like "markdown/" behind
  const baseUri = (window as any).__baseUri as string;
  const attachmentsBaseUri = (window as any).__attachmentsBaseUri as string;
  if (baseUri) {
    const escaped = baseUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped + '/', 'g'), '');
  }
  if (attachmentsBaseUri && attachmentsBaseUri !== baseUri) {
    const escaped = attachmentsBaseUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped + '/', 'g'), '');
  }
  // Restore leading slash for /.attachments/ paths that had it originally
  html = html.replace(
    /<img([^>]*?)data-slash-prefix="true"([^>]*?)>/gi,
    (match) => match.replace(/src="(\.attachments\/)/i, 'src="/.attachments/')
  );
  let md = turndownService.turndown(html);
  // Clean up extra blank lines
  md = md.replace(/\n{3,}/g, '\n\n');
  return md;
}

// ── Sync to extension ──
function scheduleSync() {
  if (isUpdatingFromExtension) return;
  if (!hasUserEdited) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const md = isSourceView
      ? sourceEditor.value
      : htmlToMarkdown(editor.innerHTML);
    vscode.postMessage({ type: 'edit', content: md });
    updateWordCount(md);
  }, 500);
}

// Make scheduleSync available globally for task list checkboxes
(window as any).scheduleSync = scheduleSync;

function updateWordCount(text: string) {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const chars = text.length;
  wordCountEl.textContent = `Words: ${words}`;
  charCountEl.textContent = `Characters: ${chars}`;
}

// ── Toolbar commands ──
function execCmd(command: string, value?: string) {
  document.execCommand(command, false, value);
  editor.focus();
  hasUserEdited = true;
  scheduleSync();
}

// Standard toolbar buttons
document.querySelectorAll('.toolbar-btn[data-command]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const command = (btn as HTMLElement).dataset.command!;
    execCmd(command);
  });
});

// Heading select
const headingSelect = document.getElementById('headingSelect') as HTMLSelectElement;
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
const fontSizeSelect = document.getElementById('fontSizeSelect') as HTMLSelectElement;
fontSizeSelect.addEventListener('change', () => {
  const value = fontSizeSelect.value;
  if (value) {
    execCmd('fontSize', value);
  }
  fontSizeSelect.value = '';
});

// ── Color palette presets ──
const PRESET_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#ff0000', '#ff8c00', '#ffdd00', '#00b050', '#0070c0', '#7030a0',
  '#c00000', '#e36c09', '#bf9000', '#00823b', '#004080', '#4a1a6b',
];

// ── Recent colors tracking ──
const MAX_RECENT_COLORS = 6;
let recentColors: string[] = JSON.parse(localStorage.getItem('recentColors') || '[]');

function addRecentColor(color: string) {
  const normalized = color.toLowerCase();
  recentColors = recentColors.filter(c => c !== normalized);
  recentColors.unshift(normalized);
  if (recentColors.length > MAX_RECENT_COLORS) recentColors = recentColors.slice(0, MAX_RECENT_COLORS);
  localStorage.setItem('recentColors', JSON.stringify(recentColors));
  // Refresh all recent color rows
  document.querySelectorAll('.recent-colors-row').forEach(row => renderRecentRow(row as HTMLElement));
}

function renderRecentRow(row: HTMLElement) {
  const onPick = (row as any)._onPick as (color: string) => void;
  row.innerHTML = '';
  if (recentColors.length === 0) {
    row.style.display = 'none';
    const sep = row.previousElementSibling;
    if (sep?.classList.contains('recent-colors-separator')) (sep as HTMLElement).style.display = 'none';
    return;
  }
  row.style.display = 'grid';
  const sep = row.previousElementSibling;
  if (sep?.classList.contains('recent-colors-separator')) (sep as HTMLElement).style.display = '';
  recentColors.forEach((color) => {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    if (color === '#ffffff') swatch.style.borderColor = '#ccc';
    swatch.title = color;
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(color);
    });
    row.appendChild(swatch);
  });
}

function buildSwatches(containerId: string, onPick: (color: string) => void, onClear: () => void) {
  const container = document.getElementById(containerId)!;

  // "None" swatch to remove color
  const noneSwatch = document.createElement('button');
  noneSwatch.className = 'color-swatch color-swatch-none';
  noneSwatch.title = 'None (remove color)';
  noneSwatch.innerHTML = '&#x2715;';
  noneSwatch.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllColorDropdowns();
    onClear();
  });
  container.appendChild(noneSwatch);

  PRESET_COLORS.forEach((color) => {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    if (color === '#ffffff') swatch.style.borderColor = '#ccc';
    swatch.title = color;
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      addRecentColor(color);
      onPick(color);
    });
    container.appendChild(swatch);
  });

  // Recent colors separator and row — append after the grid container
  const parent = container.parentElement!;
  const separator = document.createElement('div');
  separator.className = 'recent-colors-separator';
  separator.innerHTML = '<span>Recent</span>';
  parent.insertBefore(separator, container.nextSibling);

  const recentRow = document.createElement('div');
  recentRow.className = 'recent-colors-row';
  (recentRow as any)._onPick = (color: string) => {
    addRecentColor(color);
    onPick(color);
  };
  parent.insertBefore(recentRow, separator.nextSibling);
  renderRecentRow(recentRow);
}

function closeAllColorDropdowns() {
  document.querySelectorAll('.color-dropdown').forEach((d) => d.classList.remove('open'));
}

// Text color
const textColorPicker = document.getElementById('textColorPicker') as HTMLInputElement;
const textColorBtn = document.getElementById('textColorBtn')!;
const textColorDropdown = document.getElementById('textColorDropdown')!;

function applyTextColor(color: string) {
  textColorPicker.value = color;
  textColorBtn.style.borderBottomColor = color;
  closeAllColorDropdowns();
  execCmd('foreColor', color);
}

textColorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = textColorDropdown.classList.contains('open');
  closeAllColorDropdowns();
  if (!isOpen) textColorDropdown.classList.add('open');
});

textColorPicker.addEventListener('input', () => { addRecentColor(textColorPicker.value); applyTextColor(textColorPicker.value); });
buildSwatches('textColorSwatches', applyTextColor, () => {
  textColorBtn.style.borderBottomColor = 'transparent';
  closeAllColorDropdowns();
  execCmd('removeFormat');
});

// Background color
const bgColorPicker = document.getElementById('bgColorPicker') as HTMLInputElement;
const bgColorBtn = document.getElementById('bgColorBtn')!;
const bgColorDropdown = document.getElementById('bgColorDropdown')!;

function applyBgColor(color: string) {
  bgColorPicker.value = color;
  bgColorBtn.style.borderBottomColor = color;
  const indicator = bgColorBtn.querySelector('span') as HTMLElement;
  if (indicator) indicator.style.background = color;
  closeAllColorDropdowns();
  execCmd('hiliteColor', color);
}

bgColorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = bgColorDropdown.classList.contains('open');
  closeAllColorDropdowns();
  if (!isOpen) bgColorDropdown.classList.add('open');
});

bgColorPicker.addEventListener('input', () => { addRecentColor(bgColorPicker.value); applyBgColor(bgColorPicker.value); });
buildSwatches('bgColorSwatches', applyBgColor, () => {
  bgColorBtn.style.borderBottomColor = 'transparent';
  const indicator = bgColorBtn.querySelector('span') as HTMLElement;
  if (indicator) indicator.style.background = 'transparent';
  closeAllColorDropdowns();
  execCmd('hiliteColor', 'transparent');
});

// Close color dropdowns on outside click
document.addEventListener('click', () => closeAllColorDropdowns());

// Task list
document.getElementById('taskListBtn')!.addEventListener('click', () => {
  const html = `<ul class="task-list"><li class="task-list-item"><input type="checkbox" onclick="this.parentElement.classList.toggle('checked', this.checked); scheduleSync();"> Task item</li></ul>`;
  execCmd('insertHTML', html);
});

// Link button
document.getElementById('linkBtn')!.addEventListener('click', () => {
  const modal = document.getElementById('linkModal')!;
  const sel = window.getSelection();
  const selectedText = sel ? sel.toString() : '';
  (document.getElementById('linkText') as HTMLInputElement).value = selectedText;
  (document.getElementById('linkUrl') as HTMLInputElement).value = '';
  (document.getElementById('linkTitle') as HTMLInputElement).value = '';
  modal.style.display = 'flex';
  (document.getElementById('linkUrl') as HTMLInputElement).focus();
});

document.getElementById('linkInsertOk')!.addEventListener('click', () => {
  const url = (document.getElementById('linkUrl') as HTMLInputElement).value;
  const text = (document.getElementById('linkText') as HTMLInputElement).value || url;
  const title = (document.getElementById('linkTitle') as HTMLInputElement).value;
  const newTab = (document.getElementById('linkNewTab') as HTMLInputElement).checked;

  if (url) {
    let html = `<a href="${escapeHtml(url)}"`;
    if (title) html += ` title="${escapeHtml(title)}"`;
    if (newTab) html += ` target="_blank"`;
    html += `>${escapeHtml(text)}</a>`;
    execCmd('insertHTML', html);
  }
  document.getElementById('linkModal')!.style.display = 'none';
});

document.getElementById('linkInsertCancel')!.addEventListener('click', () => {
  document.getElementById('linkModal')!.style.display = 'none';
});

// Image button
document.getElementById('imageBtn')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'insertImage' });
});

// Inline code
document.getElementById('inlineCodeBtn')!.addEventListener('click', () => {
  const sel = window.getSelection();
  if (sel && sel.toString()) {
    execCmd('insertHTML', `<code>${escapeHtml(sel.toString())}</code>`);
  } else {
    execCmd('insertHTML', '<code>code</code>');
  }
});

// Code block
document.getElementById('codeBlockBtn')!.addEventListener('click', () => {
  const lang = (document.getElementById('codeLanguageSelect') as HTMLSelectElement).value;
  const sel = window.getSelection();
  const code = sel ? sel.toString() : 'code here';
  const langAttr = lang ? ` class="language-${lang}"` : '';
  execCmd('insertHTML', `<pre><code${langAttr}>${escapeHtml(code)}</code></pre><p><br></p>`);
});

// Blockquote
document.getElementById('blockquoteBtn')!.addEventListener('click', () => {
  execCmd('formatBlock', '<blockquote>');
});

// Horizontal rule
document.getElementById('hrBtn')!.addEventListener('click', () => {
  execCmd('insertHTML', '<hr><p><br></p>');
});

// Table button
let savedTableRange: Range | null = null;

document.getElementById('tableBtn')!.addEventListener('click', () => {
  // Save current selection/cursor position before modal steals focus
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    savedTableRange = sel.getRangeAt(0).cloneRange();
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
  if (savedTableRange) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(savedTableRange);
    }
    savedTableRange = null;
  }

  document.execCommand('insertHTML', false, html);
  hasUserEdited = true;
  scheduleSync();
});

document.getElementById('tableInsertCancel')!.addEventListener('click', () => {
  document.getElementById('tableModal')!.style.display = 'none';
  savedTableRange = null;
});

// Toggle source view
const editorWrapper = document.getElementById('editorWrapper')!;
document.getElementById('toggleSourceBtn')!.addEventListener('click', () => {
  isSourceView = !isSourceView;
  if (isSourceView) {
    sourceEditor.value = htmlToMarkdown(editor.innerHTML);
    editorWrapper.style.display = 'none';
    sourceContainer.style.display = 'flex';
    sourceEditor.focus();
  } else {
    const md = sourceEditor.value;
    editor.innerHTML = markdownToHtml(md);
    sourceContainer.style.display = 'none';
    editorWrapper.style.display = 'flex';
    editor.focus();
    scheduleNavRefresh();
  }
});

// ── Image paste handling ──
editor.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        vscode.postMessage({
          type: 'pasteImage',
          data: base64,
          mimeType: item.type,
        });
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

// ── Image drag & drop handling ──
editor.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault();
  editor.classList.add('drag-over');
});

editor.addEventListener('dragleave', () => {
  editor.classList.remove('drag-over');
});

editor.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  editor.classList.remove('drag-over');

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        vscode.postMessage({
          type: 'pasteImage',
          data: base64,
          mimeType: file.type,
        });
      };
      reader.readAsDataURL(file);
    }
  }
});

// ── Input handling ──
editor.addEventListener('input', () => {
  hasUserEdited = true;
  scheduleSync();
  scheduleNavRefresh();
});

sourceEditor.addEventListener('input', () => {
  hasUserEdited = true;
  scheduleSync();
});

// ── Keyboard shortcuts ──
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

// ── Message handling from extension ──
window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'update': {
      isUpdatingFromExtension = true;
      const html = markdownToHtml(message.content);
      if (!isSourceView) {
        // Preserve scroll position
        const scrollTop = editor.scrollTop;
        editor.innerHTML = html;
        editor.scrollTop = scrollTop;
      } else {
        sourceEditor.value = message.content;
      }
      updateWordCount(message.content);
      // Keep flag true briefly to catch async input events from innerHTML
      setTimeout(() => {
        isUpdatingFromExtension = false;
      }, 100);
      scheduleNavRefresh();
      requestSpellCheck();
      break;
    }

    case 'loadCustomWords': {
      const words: string[] = message.words || [];
      words.forEach((w: string) => dictionary.add(w));
      requestSpellCheck();
      break;
    }

    case 'imageInserted': {
      const imgHtml = `<img src="${escapeHtml(message.src)}" alt="${escapeHtml(message.alt)}" style="max-width: 100%;">`;
      if (!isSourceView) {
        execCmd('insertHTML', imgHtml + '<p><br></p>');
      } else {
        const mdImage = `![${message.alt}](${message.markdownPath})`;
        const pos = sourceEditor.selectionStart;
        const before = sourceEditor.value.substring(0, pos);
        const after = sourceEditor.value.substring(pos);
        sourceEditor.value = before + mdImage + after;
        scheduleSync();
      }
      break;
    }
  }
});

// ── Utilities ──
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ── Close modals on backdrop click ──
document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      (modal as HTMLElement).style.display = 'none';
    }
  });
});

// ── Close modals on Escape ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach((modal) => {
      (modal as HTMLElement).style.display = 'none';
    });
  }
});

// ── Track heading/format state for toolbar ──
editor.addEventListener('keyup', updateToolbarState);
editor.addEventListener('mouseup', updateToolbarState);

// ── Scroll-spy: highlight active heading in nav ──
editorContainer.addEventListener('scroll', () => {
  if (!isNavVisible) return;
  const headings = editor.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const containerRect = editorContainer.getBoundingClientRect();
  let activeIndex = -1;
  headings.forEach((h, i) => {
    const rect = h.getBoundingClientRect();
    if (rect.top <= containerRect.top + 60) {
      activeIndex = i;
    }
  });
  const navItems = navList.querySelectorAll('.nav-item');
  navItems.forEach((item, i) => {
    item.classList.toggle('active', i === activeIndex);
  });
});

function updateToolbarState() {
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

// ── Spell Check (client-side, no message round-trip) ──
let spellCheckTimer: ReturnType<typeof setTimeout> | null = null;
let currentMisspelled: Set<string> = new Set();

function requestSpellCheck() {
  if (isSourceView) return;
  if (spellCheckTimer) clearTimeout(spellCheckTimer);
  spellCheckTimer = setTimeout(runSpellCheck, 300);
}

function runSpellCheck() {
  const text = editor.innerText || '';
  const wordRegex = /[a-zA-Z'\u2019]+/g;
  const misspelled = new Set<string>();
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0].replace(/^['']+|['']+$/g, '');
    if (!checkWord(word)) {
      misspelled.add(word.toLowerCase());
    }
  }
  currentMisspelled = misspelled;
  applySpellHighlights();
}

function applySpellHighlights() {
  // Use CSS Custom Highlight API if available
  if ((CSS as any).highlights) {
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const wordRegex = /[a-zA-Z'\u2019]+/g;

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      let match;
      wordRegex.lastIndex = 0;
      while ((match = wordRegex.exec(text)) !== null) {
        const word = match[0].replace(/^['']+|['']+$/g, '');
        if (word.length < 2) continue;
        if (currentMisspelled.has(word.toLowerCase())) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
      }
    }

    const highlight = new (window as any).Highlight(...ranges);
    (CSS as any).highlights.set('spelling-error', highlight);
  }
}

// Trigger spell check on content changes
editor.addEventListener('input', () => {
  requestSpellCheck();
});

// ── Custom Context Menu with Spell Suggestions ──
let contextMenuTarget: { node: Text; start: number; end: number; word: string } | null = null;
let pendingContextMenuPos = { x: 0, y: 0 };

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

function removeContextMenu() {
  const existing = document.getElementById('spellContextMenu');
  if (existing) existing.remove();
}

function showSpellContextMenu(word: string, suggestions: string[]) {
  removeContextMenu();

  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = pendingContextMenuPos.x + 'px';
  menu.style.top = pendingContextMenuPos.y + 'px';

  // Spelling suggestions
  if (suggestions.length > 0) {
    suggestions.forEach((suggestion) => {
      const item = document.createElement('button');
      item.className = 'context-menu-item spell-suggestion';
      item.textContent = suggestion;
      item.addEventListener('click', () => {
        replaceWord(suggestion);
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
    // Add to local dictionary and persist via extension host
    const lower = word.toLowerCase();
    currentMisspelled.delete(lower);
    dictionary.add(lower);
    vscode.postMessage({ type: 'addCustomWord', word: lower });
    // Re-apply highlights without this word
    applySpellHighlights();
    removeContextMenu();
  });
  menu.appendChild(addDict);

  // Standard edit options divider
  const divider2 = document.createElement('div');
  divider2.className = 'context-menu-divider';
  menu.appendChild(divider2);

  // Standard options
  [{ label: 'Cut', cmd: 'cut' }, { label: 'Copy', cmd: 'copy' }, { label: 'Paste', cmd: 'paste' }].forEach(({ label, cmd }) => {
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

  // Ensure menu doesn't overflow viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - rect.width - 5) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - rect.height - 5) + 'px';
  }
}

function replaceWord(replacement: string) {
  if (!contextMenuTarget) return;
  const { node, start, end } = contextMenuTarget;
  const text = node.textContent || '';
  node.textContent = text.slice(0, start) + replacement + text.slice(end);
  scheduleSync();
  requestSpellCheck();
}

editor.addEventListener('contextmenu', (e: MouseEvent) => {
  removeContextMenu();

  // Check if right-clicked on an image
  const target = e.target as HTMLElement;
  if (target.tagName === 'IMG') {
    e.preventDefault();
    e.stopPropagation();
    showImageContextMenu(target as HTMLImageElement, e.clientX, e.clientY);
    return;
  }

  const wordInfo = getWordAtPoint(e.clientX, e.clientY);
  if (wordInfo && currentMisspelled.has(wordInfo.word.toLowerCase())) {
    e.preventDefault();
    e.stopPropagation();
    contextMenuTarget = wordInfo;
    pendingContextMenuPos = { x: e.clientX, y: e.clientY };
    // Get suggestions directly (no round-trip)
    const suggestions = getSuggestions(wordInfo.word);
    showSpellContextMenu(wordInfo.word, suggestions);
  }
});

// ── Image Context Menu ──
function getImageRelativePath(img: HTMLImageElement): string {
  const src = img.getAttribute('src') || '';
  const baseUri = (window as any).__baseUri as string;
  const attachmentsBaseUri = (window as any).__attachmentsBaseUri as string;
  let relativePath = src;
  if (baseUri && src.startsWith(baseUri + '/')) {
    relativePath = src.slice(baseUri.length + 1);
  } else if (attachmentsBaseUri && src.startsWith(attachmentsBaseUri + '/')) {
    relativePath = src.slice(attachmentsBaseUri.length + 1);
  }
  return relativePath;
}

function showImageContextMenu(img: HTMLImageElement, x: number, y: number) {
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
    hasUserEdited = true;
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
    hasUserEdited = true;
    scheduleSync();
    vscode.postMessage({ type: 'deleteImage', relativePath });
    removeContextMenu();
  });
  menu.appendChild(deleteWithFileItem);

  document.body.appendChild(menu);

  // Ensure menu doesn't overflow viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - rect.width - 5) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - rect.height - 5) + 'px';
  }
}

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

// ── Notify extension we're ready ──
vscode.postMessage({ type: 'ready' });
