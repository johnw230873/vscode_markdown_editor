import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import mermaid from 'mermaid';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Spell Check Dictionary (client-side) ──
// Seeded with common tech/abbreviation words immediately; the full English word
// list is fetched asynchronously from a local resource so it doesn't block the
// initial script parse.
const dictionary = new Set<string>();
['i', 'a', 'vs', 'ok', 'eg', 'ie', 'etc', 'url', 'html', 'css', 'js', 'ts',
 'api', 'ui', 'id', 'pdf', 'http', 'https', 'www', 'dev', 'src', 'img'].forEach(w => dictionary.add(w));

// Load the full word list in the background.
(async () => {
  try {
    const wordsUri = (window as any).__wordsUri as string | undefined;
    if (wordsUri) {
      const resp = await fetch(wordsUri);
      const wordList: string[] = await resp.json();
      wordList.forEach(w => dictionary.add(w));
    }
  } catch {
    // Spell check will work with the seed words only.
  }
})();

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

// ── Mermaid configuration ──
{
  const isDark = document.body.getAttribute('data-vscode-theme-kind')?.includes('dark') ||
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose',
  });
}

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

// Round-trip mermaid diagrams: convert rendered diagram divs back to ```mermaid fenced blocks
turndownService.addRule('mermaidDiagram', {
  filter: (node) => {
    return node.nodeName === 'DIV' && (node as HTMLElement).classList.contains('mermaid-diagram');
  },
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const encoded = el.getAttribute('data-code') || '';
    if (!encoded) return '';
    const code = decodeURIComponent(escape(atob(encoded)));
    return `\n\`\`\`mermaid\n${code}\n\`\`\`\n`;
  },
});

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

// Keep sized images (preserve width style when resized) using Azure DevOps syntax
turndownService.addRule('sizedImage', {
  filter: (node) => {
    if (node.nodeName !== 'IMG') return false;
    const el = node as HTMLElement;
    const style = el.getAttribute('style') || '';
    return /width\s*:/.test(style);
  },
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const alt = el.getAttribute('alt') || '';
    const src = el.getAttribute('src') || '';
    const style = el.getAttribute('style') || '';
    const widthMatch = style.match(/width\s*:\s*(\d+)px/);
    if (widthMatch) {
      return `![${alt}](${src} =${widthMatch[1]}x)`;
    }
    return `![${alt}](${src})`;
  },
});

// ── DOM Elements ──
const editor = document.getElementById('editor')!;
const editorContainer = document.getElementById('editorContainer')!;
const wordCountEl = document.getElementById('wordCount')!;
const charCountEl = document.getElementById('charCount')!;
const navPane = document.getElementById('navPane')!;
const navList = document.getElementById('navList')!;

let isUpdatingFromExtension = false;
let isNavVisible = false;
let hasUserEdited = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let navUpdateTimer: ReturnType<typeof setTimeout> | null = null;

// ── Scroll sync state ──
let _isSyncingScroll = false;          // true while we are programmatically scrolling the editor
let _scrollSyncTimer: ReturnType<typeof setTimeout> | null = null;

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
const zoomSlider = document.getElementById('zoomSlider') as HTMLInputElement | null;
const zoomValue = document.getElementById('zoomValue');
let currentZoom = 100;

function setZoom(level: number) {
  currentZoom = Math.max(50, Math.min(200, level));
  editor.style.zoom = `${currentZoom}%`;
  if (zoomSlider) zoomSlider.value = String(currentZoom);
  if (zoomValue) zoomValue.textContent = `${currentZoom}%`;
}

if (zoomSlider) {
  zoomSlider.addEventListener('input', () => {
    setZoom(parseInt(zoomSlider.value, 10));
  });
}

editorContainer.addEventListener('wheel', (e: WheelEvent) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    setZoom(currentZoom + delta);
  }
}, { passive: false });

// ── Scroll sync: notify the extension when the user scrolls the visual editor ──
editorContainer.addEventListener('scroll', () => {
  if (_isSyncingScroll) return;
  if (_scrollSyncTimer) clearTimeout(_scrollSyncTimer);
  _scrollSyncTimer = setTimeout(() => {
    // Find the topmost visible block element that carries a source-line annotation.
    const containerTop = editorContainer.getBoundingClientRect().top;
    const annotated = Array.from(
      editor.querySelectorAll<HTMLElement>('[data-source-line]')
    );
    let bestLine = 0;
    for (const el of annotated) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        bestLine = parseInt(el.getAttribute('data-source-line') || '0', 10);
        break;
      }
    }
    vscode.postMessage({ type: 'scrollSync', line: bestLine });
  }, 80);
});

// ── Markdown ↔ HTML conversion ──

/**
 * Annotates each top-level block element in `html` with a `data-source-line`
 * attribute whose value is the 0-based line number of the corresponding token
 * in the original markdown. Used for scroll synchronisation with the linked
 * plain-text editor.
 */
function injectSourceLines(html: string, tokens: any[]): string {
  // Build an ordered list of start-line numbers, one per rendered block element.
  // Tokens of type 'space' and 'def' produce no HTML output, so skip them.
  const lineNums: number[] = [];
  let lineNum = 0;
  for (const token of tokens) {
    if (token.type !== 'space' && token.type !== 'def') {
      lineNums.push(lineNum);
    }
    lineNum += (token.raw || '').split('\n').length - 1;
  }
  if (lineNums.length === 0) return html;

  // Use DOMParser to enumerate only the direct (top-level) child elements and
  // stamp each one with its source line number.
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const root = doc.body.firstElementChild as HTMLElement;
  if (!root) return html;
  Array.from(root.children).forEach((child, i) => {
    if (i < lineNums.length) {
      child.setAttribute('data-source-line', String(lineNums[i]));
    }
  });
  return root.innerHTML;
}

function markdownToHtml(md: string): string {
  // Pre-process Azure DevOps image size syntax: ![alt](url =WIDTHx) or ![alt](url =WIDTHxHEIGHT)
  md = md.replace(
    /!\[([^\]]*)\]\(([^)]*?)\s+=([0-9]+)x([0-9]*)\)/g,
    (_match, alt, src, width, _height) => {
      return `<img src="${src.trim()}" alt="${alt}" width="${width}">`;
    }
  );
  // Tokenise first so we can annotate rendered elements with source line numbers.
  const mdTokens: any[] = (marked as any).lexer(md);
  let html = marked.parse(md) as string;
  // Intercept mermaid code blocks before any other processing.
  // marked renders them as <pre><code class="language-mermaid">…</code></pre>;
  // replace with a placeholder div that stores the source so we can:
  //   a) render via mermaid.render() after innerHTML is set
  //   b) round-trip back to ```mermaid fenced blocks via the turndown rule
  html = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
    (_, rawCode) => {
      const code = rawCode
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      const encoded = btoa(unescape(encodeURIComponent(code)));
      return `<div class="mermaid-diagram" data-code="${encoded}" contenteditable="false"></div>`;
    }
  );
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
  // Convert width attribute to inline style for resized images
  html = html.replace(
    /<img\s([^>]*?)width="(\d+)"([^>]*?)>/gi,
    (match, before, width, after) => {
      // Remove the width attribute and add inline style
      const cleanBefore = before.replace(/width="\d+"\s*/g, '');
      const cleanAfter = after.replace(/width="\d+"\s*/g, '');
      const existingStyle = match.match(/style="([^"]*)"/);
      if (existingStyle) {
        return match.replace(/style="([^"]*)"/, `style="$1; width: ${width}px; max-width: 100%; height: auto;"`);
      }
      return `<img ${cleanBefore}style="width: ${width}px; max-width: 100%; height: auto;"${cleanAfter}>`;
    }
  );
  // Annotate top-level block elements with source line numbers for scroll sync.
  html = injectSourceLines(html, mdTokens);
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
    const md = htmlToMarkdown(editor.innerHTML);
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

// Mark / Highlight
document.getElementById('markBtn')!.addEventListener('click', () => {
  const sel = window.getSelection();
  const content = sel && sel.toString() ? escapeHtml(sel.toString()) : 'highlighted text';
  execCmd('insertHTML', `<mark>${content}</mark>`);
});

// Link button
let editingLinkElement: HTMLAnchorElement | null = null;
document.getElementById('linkBtn')!.addEventListener('click', () => {
  editingLinkElement = null;
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
    if (editingLinkElement) {
      editingLinkElement.href = url;
      editingLinkElement.textContent = text;
      editingLinkElement.title = title;
      if (newTab) editingLinkElement.setAttribute('target', '_blank');
      else editingLinkElement.removeAttribute('target');
      editingLinkElement = null;
      hasUserEdited = true;
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
let savedCodeRange: Range | null = null;
// Mermaid diagram button — inserts a sample diagram and renders it immediately
document.getElementById('mermaidBtn')!.addEventListener('click', () => {
  const sample = [
    'flowchart LR',
    '    A[Start] --> B{Decision}',
    '    B -- Yes --> C[Do something]',
    '    B -- No --> D[Do something else]',
    '    C --> E[End]',
    '    D --> E',
  ].join('\n');
  const encoded = btoa(unescape(encodeURIComponent(sample)));
  const html =
    `<div class="mermaid-diagram" data-code="${encoded}" contenteditable="false"></div>` +
    `<p><em style="color:var(--vscode-descriptionForeground,#888);font-size:0.85em;">` +
    `Switch to Copilot mode to edit this diagram.</em></p><p><br></p>`;
  editor.focus();
  document.execCommand('insertHTML', false, html);
  hasUserEdited = true;
  scheduleSync();
  renderMermaidDiagrams();
});

document.getElementById('codeBlockBtn')!.addEventListener('click', () => {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) savedCodeRange = sel.getRangeAt(0).cloneRange();
  (document.getElementById('codeLanguageSelect') as HTMLSelectElement).value = '';
  document.getElementById('codeBlockModal')!.style.display = 'flex';
});

document.getElementById('codeBlockInsertOk')!.addEventListener('click', () => {
  const lang = (document.getElementById('codeLanguageSelect') as HTMLSelectElement).value;
  const langAttr = lang ? ` class="language-${lang}"` : '';
  document.getElementById('codeBlockModal')!.style.display = 'none';
  editor.focus();
  if (savedCodeRange) {
    const s = window.getSelection();
    if (s) { s.removeAllRanges(); s.addRange(savedCodeRange); }
    savedCodeRange = null;
  }
  const selectedText = window.getSelection()?.toString() || 'code here';
  document.execCommand('insertHTML', false, `<pre><code${langAttr}>${escapeHtml(selectedText)}</code></pre><p><br></p>`);
  hasUserEdited = true;
  scheduleSync();
});

document.getElementById('codeBlockInsertCancel')!.addEventListener('click', () => {
  document.getElementById('codeBlockModal')!.style.display = 'none';
  savedCodeRange = null;
});

// Blockquote
document.getElementById('blockquoteBtn')!.addEventListener('click', () => {
  execCmd('formatBlock', '<blockquote>');
});

// Horizontal rule
document.getElementById('hrBtn')!.addEventListener('click', () => {
  execCmd('insertHTML', '<hr><p><br></p>');
});

// Export buttons
document.getElementById('exportPdfBtn')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportPdf', isDark: false });
});

document.getElementById('exportDocxBtn')!.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportDocx' });
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

// ── Source position sync: find the char offset in markdown that matches the WYSIWYG cursor ──
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

// ── Copy with embedded images (for paste into Word / external apps) ──
// When the selection contains images, intercept copy and replace each webview-resource
// URI with a base64 data URL so external apps (e.g. Word) can render them.
editor.addEventListener('copy', (e: ClipboardEvent) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const clonedImgs = Array.from(fragment.querySelectorAll('img')) as HTMLImageElement[];

  // No images in selection — let the browser handle the copy normally
  if (clonedImgs.length === 0) return;

  e.preventDefault();

  // Build a lookup of live DOM images by src so we can draw them (cloned nodes
  // are not rendered and may not have naturalWidth/Height set).
  const liveImgMap = new Map<string, HTMLImageElement>();
  (Array.from(editor.querySelectorAll('img')) as HTMLImageElement[]).forEach((li) => {
    const s = li.getAttribute('src');
    if (s) liveImgMap.set(s, li);
  });

  clonedImgs.forEach((clonedImg) => {
    const srcAttr = clonedImg.getAttribute('src') || '';
    const liveImg = liveImgMap.get(srcAttr);
    const source = liveImg ?? clonedImg;

    const w = source.naturalWidth || source.clientWidth || 300;
    const h = source.naturalHeight || source.clientHeight || 300;
    const canvas = document.createElement('canvas');
    canvas.width = w || 300;
    canvas.height = h || 300;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      try {
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        clonedImg.src = canvas.toDataURL('image/png');
        clonedImg.removeAttribute('data-slash-prefix');
        clonedImg.style.maxWidth = '';
      } catch {
        // Tainted canvas (e.g. cross-origin image) — leave original src
      }
    }
  });

  const container = document.createElement('div');
  container.appendChild(fragment);
  e.clipboardData!.setData('text/html', container.innerHTML);
  e.clipboardData!.setData('text/plain', selection.toString());
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

// ── Shared drag utilities ──
function getCaretRangeAt(x: number, y: number): Range | null {
  if ((document as any).caretPositionFromPoint) {
    const pos = (document as any).caretPositionFromPoint(x, y);
    if (pos) {
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
  } else if ((document as any).caretRangeFromPoint) {
    return (document as any).caretRangeFromPoint(x, y);
  }
  return null;
}

// Range of text currently being dragged (captured in dragstart, consumed in drop)
let savedDragRange: Range | null = null;

// ── Image / file drag & drop + text drag handling ──
editor.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault(); // required to allow drop
  // Only highlight the editor border for external file drops, not internal text drags
  const hasFiles = e.dataTransfer?.types.includes('Files');
  editor.classList.toggle('drag-over', !!hasFiles);
});

editor.addEventListener('dragleave', () => {
  editor.classList.remove('drag-over');
});

editor.addEventListener('drop', (e: DragEvent) => {
  editor.classList.remove('drag-over');

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    // External file drop — handle ourselves
    e.preventDefault();
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
  } else if (savedDragRange) {
    // Internal text drag — manually extract and reinsert so it works reliably
    e.preventDefault();
    const dropRange = getCaretRangeAt(e.clientX, e.clientY);
    const fragment = savedDragRange.extractContents();
    savedDragRange = null;
    if (dropRange && editor.contains(dropRange.commonAncestorContainer)) {
      dropRange.insertNode(fragment);
      // Place the cursor at the end of the moved content
      dropRange.collapse(false);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(dropRange); }
    }
    hasUserEdited = true;
    scheduleSync();
  }
});

// ── Image drag-to-reposition ──
{
  let draggedImg: HTMLImageElement | null = null;
  let dragClone: HTMLElement | null = null;
  let dropCaret: HTMLElement | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isDraggingImg = false;

  function updateDropCaret(x: number, y: number): void {
    if (!dropCaret) return;
    const range = getCaretRangeAt(x, y);
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      dropCaret.style.display = 'none';
      return;
    }
    const rects = range.getClientRects();
    const rect = rects[0];
    if (!rect) { dropCaret.style.display = 'none'; return; }
    dropCaret.style.left = rect.left + 'px';
    dropCaret.style.top = rect.top + 'px';
    dropCaret.style.height = Math.max(rect.height, 16) + 'px';
    dropCaret.style.display = 'block';
  }

  // Suppress the browser's built-in image drag; capture selection for text drag
  editor.addEventListener('dragstart', (e: DragEvent) => {
    if ((e.target as HTMLElement).tagName === 'IMG') {
      e.preventDefault();
      return;
    }
    // Capture the selection range so the drop handler can reinsert it manually
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && editor.contains(sel.anchorNode)) {
      savedDragRange = sel.getRangeAt(0).cloneRange();
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    }
  });

  editor.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'IMG' || e.button !== 0) return;
    const img = e.target as HTMLImageElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const imgRect = img.getBoundingClientRect();
    dragOffsetX = startX - imgRect.left;
    dragOffsetY = startY - imgRect.top;

    const onMouseMove = (me: MouseEvent) => {
      if (!isDraggingImg) {
        if (Math.abs(me.clientX - startX) < 5 && Math.abs(me.clientY - startY) < 5) return;
        isDraggingImg = true;
        draggedImg = img;

        // Floating clone that follows the cursor
        dragClone = document.createElement('div');
        dragClone.style.cssText = [
          `position:fixed`,
          `left:${imgRect.left}px`,
          `top:${imgRect.top}px`,
          `width:${imgRect.width}px`,
          `height:${imgRect.height}px`,
          `pointer-events:none`,
          `opacity:0.75`,
          `z-index:9999`,
          `border:2px dashed var(--vscode-focusBorder,#007fd4)`,
          `border-radius:3px`,
          `background:url("${img.src}") center/contain no-repeat`,
          `box-shadow:0 4px 16px rgba(0,0,0,0.35)`,
        ].join(';');
        document.body.appendChild(dragClone);

        // Thin caret line indicating the drop position
        dropCaret = document.createElement('div');
        dropCaret.style.cssText = [
          `position:fixed`,
          `width:2px`,
          `height:20px`,
          `background:var(--vscode-focusBorder,#007fd4)`,
          `pointer-events:none`,
          `z-index:10000`,
          `border-radius:1px`,
          `box-shadow:0 0 4px var(--vscode-focusBorder,#007fd4)`,
          `display:none`,
        ].join(';');
        document.body.appendChild(dropCaret);

        img.style.opacity = '0.3';
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }

      if (isDraggingImg && dragClone) {
        dragClone.style.left = (me.clientX - dragOffsetX) + 'px';
        dragClone.style.top = (me.clientY - dragOffsetY) + 'px';
        updateDropCaret(me.clientX, me.clientY);
      }
    };

    const onMouseUp = (me: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (dragClone) { dragClone.remove(); dragClone = null; }
      if (dropCaret) { dropCaret.remove(); dropCaret = null; }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      if (isDraggingImg && draggedImg) {
        // Temporarily hide the image so caretRangeFromPoint doesn't land on it
        draggedImg.style.display = 'none';
        const range = getCaretRangeAt(me.clientX, me.clientY);
        draggedImg.style.display = '';
        draggedImg.style.opacity = '';

        if (range && editor.contains(range.commonAncestorContainer)) {
          const imgNode = draggedImg;
          imgNode.remove();
          range.insertNode(imgNode);
        }
        hasUserEdited = true;
        scheduleSync();
      }

      isDraggingImg = false;
      draggedImg = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ── Input handling ──
editor.addEventListener('input', () => {
  hasUserEdited = true;
  scheduleSync();
  scheduleNavRefresh();
});

// ── Keyboard shortcuts ──
let chordPending = false;
let chordTimer: ReturnType<typeof setTimeout> | null = null;

editor.addEventListener('keydown', (e: KeyboardEvent) => {
  // Handle pending Ctrl+K chord sequences
  if (chordPending) {
    chordPending = false;
    if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
    if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      vscode.postMessage({ type: 'executeVsCodeCommand', command: 'workbench.action.files.saveAll' });
      return;
    }
  }

  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 'l':
        e.preventDefault();
        document.getElementById('linkBtn')!.click();
        break;
      case 'k':
        // Start Ctrl+K chord — e.g. Ctrl+K, S = Save All
        e.preventDefault();
        chordPending = true;
        chordTimer = setTimeout(() => { chordPending = false; }, 1500);
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

// ── Mermaid rendering ──
let mermaidCounter = 0;
async function renderMermaidDiagrams(): Promise<void> {
  const diagrams = editor.querySelectorAll<HTMLElement>('.mermaid-diagram[data-code]:not([data-rendered])');
  for (const div of Array.from(diagrams)) {
    const encoded = div.getAttribute('data-code') || '';
    if (!encoded) continue;
    const code = decodeURIComponent(escape(atob(encoded)));
    const id = `mermaid-svg-${++mermaidCounter}`;
    try {
      const { svg } = await mermaid.render(id, code);
      div.innerHTML = svg;
      div.setAttribute('data-rendered', 'true');
    } catch (err: any) {
      div.innerHTML = `<pre class="mermaid-error" style="color:red;border:1px solid red;padding:8px;">Mermaid error: ${err?.message ?? err}</pre>`;
      div.setAttribute('data-rendered', 'true');
    }
  }
}

// ── Message handling from extension ──
window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'update': {
      isUpdatingFromExtension = true;
      const html = markdownToHtml(message.content);
      // Preserve scroll position
      const scrollTop = editor.scrollTop;
      editor.innerHTML = html;
      editor.scrollTop = scrollTop;
      renderMermaidDiagrams();
      // Clear any stale raw-selection highlight (content just changed)
      if ((CSS as any).highlights) { (CSS as any).highlights.delete('raw-selection'); }
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

    case 'rawSelection': {
      // Mirror the raw-editor text selection into the visual editor using a
      // CSS Custom Highlight (no DOM events fired → no feedback loop).
      applyRawSelectionHighlight(
          message.startLine as number,
          message.endLine as number,
          (message.selectedText as string) || '',
        );
      break;
    }

    case 'scrollToLine': {
      const targetLine = message.line as number;
      const annotated = Array.from(
        editor.querySelectorAll<HTMLElement>('[data-source-line]')
      );
      if (annotated.length === 0) break;
      // Find the annotated element whose source line is closest to (but not past) targetLine.
      let best = annotated[0];
      for (const el of annotated) {
        const ln = parseInt(el.getAttribute('data-source-line') || '0', 10);
        if (ln <= targetLine) {
          best = el;
        } else {
          break;
        }
      }
      _isSyncingScroll = true;
      best.scrollIntoView({ block: 'start' });
      setTimeout(() => { _isSyncingScroll = false; }, 300);
      break;
    }

    case 'imageInserted': {
      const imgHtml = `<img src="${escapeHtml(message.src)}" alt="${escapeHtml(message.alt)}" style="max-width: 100%;">`;
      execCmd('insertHTML', imgHtml + '<p><br></p>');
      break;
    }

    case 'svgConverted': {
      // Replace the SVG image element with the new PNG
      const oldSrc = message.oldSrc as string;
      const newSrc = message.newSrc as string;
      const newMarkdownPath = message.newMarkdownPath as string;
      const width = message.width as number;
      const height = message.height as number;

      const imgs = editor.querySelectorAll('img');
        for (const img of imgs) {
          if (img.getAttribute('src') === oldSrc) {
            img.setAttribute('src', newSrc);
            img.removeAttribute('width');
            img.removeAttribute('height');
            img.removeAttribute('data-slash-prefix');
            img.setAttribute('style', 'max-width: 100%; height: auto;');
            break;
          }
        }
        hasUserEdited = true;
        scheduleSync();
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

// ── Selection tracking (exposes cursor/selection to GitHub Copilot agents) ──
let selectionReportTimer: ReturnType<typeof setTimeout> | null = null;

// Track whether the webview currently has focus.
// When focus leaves (e.g. the user opens Copilot Chat), the browser fires a
// selectionchange with an empty selection.  Without this guard we would
// overwrite the linked text editor's selection with nothing, making Copilot
// see no selected text.
let webviewHasFocus = true;
window.addEventListener('focus', () => { webviewHasFocus = true; });
window.addEventListener('blur',  () => { webviewHasFocus = false; });

function reportSelection() {
  if (isUpdatingFromExtension) return;
  // Do NOT send anything while the webview is unfocused — preserve the last
  // known selection in the linked text editor so Copilot can still read it.
  if (!webviewHasFocus) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !editor.contains(sel.focusNode)) {
    // Only clear the selection when we're sure focus is still here
    if (webviewHasFocus) {
      vscode.postMessage({ type: 'selectionChange', startOffset: 0, endOffset: 0, selectedText: '' });
    }
    return;
  }

  const selectedText = sel.toString();
  const md = htmlToMarkdown(editor.innerHTML);
  const startOffset = getSourceCharOffsetForCursor(md);
  // End offset approximation: markdown may differ from plain text by syntax chars,
  // but this is accurate enough for Copilot to locate the right region.
  const endOffset = sel.isCollapsed ? startOffset : startOffset + selectedText.length;

  vscode.postMessage({
    type: 'selectionChange',
    startOffset,
    endOffset,
    selectedText,
  });
}

document.addEventListener('selectionchange', () => {
  if (selectionReportTimer) clearTimeout(selectionReportTimer);
  selectionReportTimer = setTimeout(reportSelection, 150);
});

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

// ── Raw-editor → Visual selection highlight ──

/** Strip common markdown inline/block syntax so we can match display text. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .trim();
}

/** Walk text nodes inside `editor` and return a Range matching `searchText`, or null. */
function findTextRangeInEditor(searchText: string): Range | null {
  const segments: Array<{ node: Text; nodeStart: number }> = [];
  let fullText = '';
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = (node as Text).textContent || '';
    if (t.length > 0) {
      segments.push({ node: node as Text, nodeStart: fullText.length });
      fullText += t;
    }
  }
  const idx = fullText.indexOf(searchText);
  if (idx < 0) return null;
  const endIdx = idx + searchText.length;
  let startNode: Text | null = null, startOff = 0;
  let endNode: Text | null = null, endOff = 0;
  for (const seg of segments) {
    const segEnd = seg.nodeStart + (seg.node.textContent?.length || 0);
    if (!startNode && idx >= seg.nodeStart && idx < segEnd) {
      startNode = seg.node;
      startOff = idx - seg.nodeStart;
    }
    if (!endNode && endIdx > seg.nodeStart && endIdx <= segEnd) {
      endNode = seg.node;
      endOff = endIdx - seg.nodeStart;
    }
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  } catch { return null; }
}

/**
 * Apply (or clear) the `raw-selection` CSS Custom Highlight.
 * Tries an exact text match first; falls back to highlighting the
 * block elements whose `data-source-line` falls in [startLine, endLine].
 */
function applyRawSelectionHighlight(startLine: number, endLine: number, rawText: string): void {
  if (!(CSS as any).highlights) return;
  (CSS as any).highlights.delete('raw-selection');
  if (startLine < 0) return;

  // Attempt precise match using stripped display text
  const cleanText = stripInlineMarkdown(rawText);
  if (cleanText.length >= 2) {
    const range = findTextRangeInEditor(cleanText);
    if (range) {
      (CSS as any).highlights.set('raw-selection', new (window as any).Highlight(range));
      // Scroll into view if outside the container
      const rect = range.getBoundingClientRect();
      const cRect = editorContainer.getBoundingClientRect();
      if (rect.top < cRect.top || rect.bottom > cRect.bottom) {
        (range.startContainer as Element).parentElement?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
  }

  // Fallback: highlight every annotated block element in the selected line range
  const ranges: Range[] = [];
  editor.querySelectorAll<HTMLElement>('[data-source-line]').forEach(el => {
    const line = parseInt(el.getAttribute('data-source-line') || '-1', 10);
    if (line >= startLine && line <= endLine) {
      const r = document.createRange();
      r.selectNodeContents(el);
      ranges.push(r);
    }
  });
  if (ranges.length > 0) {
    (CSS as any).highlights.set('raw-selection', new (window as any).Highlight(...ranges));
  }
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
  if (wordInfo && currentMisspelled.has(wordInfo.word.toLowerCase())) {
    e.preventDefault();
    e.stopPropagation();
    contextMenuTarget = wordInfo;
    pendingContextMenuPos = { x: e.clientX, y: e.clientY };
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
    // Image is from the parent directory — prefix with '/' so the provider
    // knows to resolve relative to the parent (e.g. /.attachments/img.png)
    relativePath = '/' + src.slice(attachmentsBaseUri.length + 1);
  }
  return relativePath;
}

function isSvgImage(img: HTMLImageElement): boolean {
  const src = img.getAttribute('src') || '';
  return src.toLowerCase().endsWith('.svg');
}

function convertSvgToPng(img: HTMLImageElement, width: number, height: number): void {
  const svgRelativePath = getImageRelativePath(img);
  // Send just the path — the extension host renders via headless browser
  // (canvas can't render SVGs that contain <foreignObject>, e.g. Mermaid diagrams)
  vscode.postMessage({
    type: 'convertSvgToPng',
    svgRelativePath,
    pngData: '',
    width,
    height,
  });
}

function showConvertSvgDialog(img: HTMLImageElement): void {
  const displayWidth = img.clientWidth || img.naturalWidth || 300;
  const displayHeight = img.clientHeight || img.naturalHeight || 300;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--vscode-editor-background, #1e1e1e);color:var(--vscode-editor-foreground, #ccc);border:1px solid var(--vscode-widget-border, #444);border-radius:6px;padding:20px;min-width:280px;font-family:var(--vscode-font-family, sans-serif);';

  dialog.innerHTML = `
    <h3 style="margin:0 0 12px 0;font-size:14px;">Convert SVG to PNG</h3>
    <div style="margin-bottom:10px;">
      <label style="display:block;margin-bottom:4px;font-size:12px;">Width (px):</label>
      <input id="svgConvertWidth" type="number" value="${displayWidth}" min="1" max="4096"
        style="width:100%;padding:4px 8px;background:var(--vscode-input-background, #3c3c3c);color:var(--vscode-input-foreground, #ccc);border:1px solid var(--vscode-input-border, #555);border-radius:3px;">
    </div>
    <div style="margin-bottom:10px;">
      <label style="display:block;margin-bottom:4px;font-size:12px;">Height (px):</label>
      <input id="svgConvertHeight" type="number" value="${displayHeight}" min="1" max="4096"
        style="width:100%;padding:4px 8px;background:var(--vscode-input-background, #3c3c3c);color:var(--vscode-input-foreground, #ccc);border:1px solid var(--vscode-input-border, #555);border-radius:3px;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;">
        <input id="svgConvertLockRatio" type="checkbox" checked> Lock aspect ratio
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="svgConvertCancel" style="padding:4px 12px;background:transparent;color:var(--vscode-button-secondaryForeground, #ccc);border:1px solid var(--vscode-button-secondaryBorder, #555);border-radius:3px;cursor:pointer;">Cancel</button>
      <button id="svgConvertOk" style="padding:4px 12px;background:var(--vscode-button-background, #0e639c);color:var(--vscode-button-foreground, #fff);border:none;border-radius:3px;cursor:pointer;">Convert</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const widthInput = dialog.querySelector('#svgConvertWidth') as HTMLInputElement;
  const heightInput = dialog.querySelector('#svgConvertHeight') as HTMLInputElement;
  const lockRatio = dialog.querySelector('#svgConvertLockRatio') as HTMLInputElement;
  const cancelBtn = dialog.querySelector('#svgConvertCancel') as HTMLButtonElement;
  const okBtn = dialog.querySelector('#svgConvertOk') as HTMLButtonElement;

  const aspectRatio = displayWidth / displayHeight;

  widthInput.addEventListener('input', () => {
    if (lockRatio.checked) {
      heightInput.value = String(Math.round(parseInt(widthInput.value) / aspectRatio) || 1);
    }
  });
  heightInput.addEventListener('input', () => {
    if (lockRatio.checked) {
      widthInput.value = String(Math.round(parseInt(heightInput.value) * aspectRatio) || 1);
    }
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  okBtn.addEventListener('click', () => {
    const w = parseInt(widthInput.value) || displayWidth;
    const h = parseInt(heightInput.value) || displayHeight;
    overlay.remove();
    convertSvgToPng(img, w, h);
  });

  widthInput.focus();
  widthInput.select();
}

function showImageResizeDialog(img: HTMLImageElement): void {
  // Determine current size as percentage of natural width (or 100% if unknown)
  const naturalW = img.naturalWidth || img.clientWidth || 300;
  const currentW = img.clientWidth || naturalW;
  const currentPercent = Math.round((currentW / naturalW) * 100);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--vscode-editor-background, #1e1e1e);color:var(--vscode-editor-foreground, #ccc);border:1px solid var(--vscode-widget-border, #444);border-radius:6px;padding:20px;min-width:300px;font-family:var(--vscode-font-family, sans-serif);';

  dialog.innerHTML = `
    <h3 style="margin:0 0 12px 0;font-size:14px;">Resize Image</h3>
    <div style="margin-bottom:8px;font-size:12px;opacity:0.7;">Original: ${naturalW}px wide</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <input id="imgResizeSlider" type="range" min="5" max="100" value="${currentPercent}"
        style="flex:1;cursor:pointer;">
      <span id="imgResizeValue" style="min-width:42px;text-align:right;font-size:13px;font-weight:bold;">${currentPercent}%</span>
    </div>
    <div style="margin-bottom:16px;text-align:center;">
      <img id="imgResizePreview" src="${img.src}" style="max-width:100%;width:${currentPercent}%;border:1px solid var(--vscode-widget-border, #444);border-radius:3px;max-height:200px;object-fit:contain;">
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="imgResizeReset" style="padding:4px 12px;background:transparent;color:var(--vscode-button-secondaryForeground, #ccc);border:1px solid var(--vscode-button-secondaryBorder, #555);border-radius:3px;cursor:pointer;margin-right:auto;">Reset (100%)</button>
      <button id="imgResizeCancel" style="padding:4px 12px;background:transparent;color:var(--vscode-button-secondaryForeground, #ccc);border:1px solid var(--vscode-button-secondaryBorder, #555);border-radius:3px;cursor:pointer;">Cancel</button>
      <button id="imgResizeOk" style="padding:4px 12px;background:var(--vscode-button-background, #0e639c);color:var(--vscode-button-foreground, #fff);border:none;border-radius:3px;cursor:pointer;">Apply</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const slider = dialog.querySelector('#imgResizeSlider') as HTMLInputElement;
  const valueLabel = dialog.querySelector('#imgResizeValue') as HTMLElement;
  const preview = dialog.querySelector('#imgResizePreview') as HTMLImageElement;
  const cancelBtn = dialog.querySelector('#imgResizeCancel') as HTMLButtonElement;
  const okBtn = dialog.querySelector('#imgResizeOk') as HTMLButtonElement;
  const resetBtn = dialog.querySelector('#imgResizeReset') as HTMLButtonElement;

  slider.addEventListener('input', () => {
    const pct = slider.value;
    valueLabel.textContent = pct + '%';
    preview.style.width = pct + '%';
  });

  resetBtn.addEventListener('click', () => {
    slider.value = '100';
    valueLabel.textContent = '100%';
    preview.style.width = '100%';
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  okBtn.addEventListener('click', () => {
    const pct = parseInt(slider.value);
    if (pct >= 100) {
      // Full size — remove explicit width constraint
      img.style.width = '';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.removeAttribute('width');
      img.removeAttribute('height');
    } else {
      const newWidth = Math.round(naturalW * (pct / 100));
      img.style.width = newWidth + 'px';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.removeAttribute('width');
      img.removeAttribute('height');
    }
    overlay.remove();
    hasUserEdited = true;
    scheduleSync();
  });

  slider.focus();
}

function showImageContextMenu(img: HTMLImageElement, x: number, y: number) {
  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Copy image to clipboard
  const copyItem = document.createElement('button');
  copyItem.className = 'context-menu-item';
  copyItem.textContent = 'Copy Image';
  copyItem.addEventListener('click', () => {
    removeContextMenu();
    const canvas = document.createElement('canvas');
    const w = img.naturalWidth || img.clientWidth || 300;
    const h = img.naturalHeight || img.clientHeight || 300;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob) {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
        }
      }, 'image/png');
    }
  });
  menu.appendChild(copyItem);

  // Divider after copy
  const copyDivider = document.createElement('div');
  copyDivider.className = 'context-menu-divider';
  menu.appendChild(copyDivider);

  // Resize image (not available for SVGs - they don't have meaningful pixel dimensions)
  if (!isSvgImage(img)) {
    const resizeItem = document.createElement('button');
    resizeItem.className = 'context-menu-item';
    resizeItem.textContent = 'Resize Image';
    resizeItem.addEventListener('click', () => {
      removeContextMenu();
      showImageResizeDialog(img);
    });
    menu.appendChild(resizeItem);
  }

  // Convert SVG to PNG (only for SVG images)
  if (isSvgImage(img)) {
    const convertItem = document.createElement('button');
    convertItem.className = 'context-menu-item';
    convertItem.textContent = 'Convert to PNG';
    convertItem.addEventListener('click', () => {
      removeContextMenu();
      showConvertSvgDialog(img);
    });
    menu.appendChild(convertItem);
  }

  // Divider before destructive actions
  const imgDivider = document.createElement('div');
  imgDivider.className = 'context-menu-divider';
  menu.appendChild(imgDivider);

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

// ── Link Context Menu ──
function showLinkContextMenu(anchor: HTMLAnchorElement, x: number, y: number) {
  const menu = document.createElement('div');
  menu.id = 'spellContextMenu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const editItem = document.createElement('button');
  editItem.className = 'context-menu-item';
  editItem.textContent = 'Edit Link';
  editItem.addEventListener('click', () => {
    editingLinkElement = anchor;
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
    hasUserEdited = true;
    scheduleSync();
    removeContextMenu();
  });
  menu.appendChild(removeItem);

  document.body.appendChild(menu);
  const lr = menu.getBoundingClientRect();
  if (lr.right > window.innerWidth) menu.style.left = (window.innerWidth - lr.width - 5) + 'px';
  if (lr.bottom > window.innerHeight) menu.style.top = (window.innerHeight - lr.height - 5) + 'px';
}

// ── Table Context Menu ──
function showTableContextMenu(cell: HTMLTableCellElement, x: number, y: number) {
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
    item.addEventListener('click', () => { fn(); hasUserEdited = true; scheduleSync(); removeContextMenu(); });
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
    hasUserEdited = true; scheduleSync(); removeContextMenu();
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
    hasUserEdited = true; scheduleSync(); removeContextMenu();
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
    hasUserEdited = true; scheduleSync(); removeContextMenu();
  });
  menu.appendChild(delTable);

  document.body.appendChild(menu);
  const tr = menu.getBoundingClientRect();
  if (tr.right > window.innerWidth) menu.style.left = (window.innerWidth - tr.width - 5) + 'px';
  if (tr.bottom > window.innerHeight) menu.style.top = (window.innerHeight - tr.height - 5) + 'px';
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

// ── Cursor position tracking ──
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

// ── Image hover tooltip ──
const imgTooltip = document.createElement('div');
imgTooltip.id = 'imgTooltip';
imgTooltip.className = 'img-tooltip';
document.body.appendChild(imgTooltip);

let imgTooltipTimer: ReturnType<typeof setTimeout> | null = null;
let tooltipImg: HTMLImageElement | null = null;

// ── Link hover tooltip ──
const linkTooltip = document.createElement('div');
linkTooltip.className = 'link-tooltip';
const linkTooltipUrl = document.createElement('span');
linkTooltipUrl.className = 'link-tooltip-url';
const linkTooltipHint = document.createElement('span');
linkTooltipHint.className = 'link-tooltip-hint';
linkTooltipHint.textContent = 'Ctrl+Click to follow link';
linkTooltip.appendChild(linkTooltipUrl);
linkTooltip.appendChild(linkTooltipHint);
document.body.appendChild(linkTooltip);

let linkTooltipTimer: ReturnType<typeof setTimeout> | null = null;
let tooltipAnchor: HTMLAnchorElement | null = null;

function showLinkTooltip(anchor: HTMLAnchorElement, x: number, y: number) {
  linkTooltipUrl.textContent = anchor.getAttribute('href') || '';
  linkTooltip.style.display = 'block';
  const offset = 14;
  linkTooltip.style.left = (x + offset) + 'px';
  linkTooltip.style.top  = (y + offset) + 'px';
  requestAnimationFrame(() => {
    const rect = linkTooltip.getBoundingClientRect();
    if (rect.right  > window.innerWidth  - 8) linkTooltip.style.left = (x - rect.width  - offset) + 'px';
    if (rect.bottom > window.innerHeight - 8) linkTooltip.style.top  = (y - rect.height - offset) + 'px';
  });
}

function hideLinkTooltip() {
  linkTooltip.style.display = 'none';
  if (linkTooltipTimer) { clearTimeout(linkTooltipTimer); linkTooltipTimer = null; }
  tooltipAnchor = null;
}

function showImgTooltip(img: HTMLImageElement, x: number, y: number) {
  const relativePath = getImageRelativePath(img);
  const filename = relativePath.replace(/\\/g, '/').split('/').pop() || relativePath;
  imgTooltip.textContent = filename;
  imgTooltip.style.display = 'block';
  // Position below-right of cursor, keeping within viewport
  const offset = 14;
  imgTooltip.style.left = (x + offset) + 'px';
  imgTooltip.style.top = (y + offset) + 'px';
  requestAnimationFrame(() => {
    const rect = imgTooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      imgTooltip.style.left = (x - rect.width - offset) + 'px';
    }
    if (rect.bottom > window.innerHeight - 8) {
      imgTooltip.style.top = (y - rect.height - offset) + 'px';
    }
  });
}

function hideImgTooltip() {
  imgTooltip.style.display = 'none';
  if (imgTooltipTimer) { clearTimeout(imgTooltipTimer); imgTooltipTimer = null; }
  tooltipImg = null;
}

editor.addEventListener('mousemove', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'IMG') {
    const img = target as HTMLImageElement;
    if (tooltipImg !== img) {
      hideImgTooltip();
      tooltipImg = img;
    }
    if (imgTooltipTimer) clearTimeout(imgTooltipTimer);
    const cx = e.clientX;
    const cy = e.clientY;
    imgTooltipTimer = setTimeout(() => showImgTooltip(img, cx, cy), 700);
    // Hide link tooltip when over an image
    if (tooltipAnchor) hideLinkTooltip();
  } else {
    if (tooltipImg) hideImgTooltip();
    // Link tooltip
    const anchor = (target as HTMLElement).closest('a') as HTMLAnchorElement | null;
    if (anchor && anchor.getAttribute('href')) {
      if (tooltipAnchor !== anchor) {
        hideLinkTooltip();
        tooltipAnchor = anchor;
      }
      if (linkTooltipTimer) clearTimeout(linkTooltipTimer);
      const cx = e.clientX;
      const cy = e.clientY;
      linkTooltipTimer = setTimeout(() => showLinkTooltip(anchor, cx, cy), 500);
    } else {
      if (tooltipAnchor) hideLinkTooltip();
    }
  }
});

editor.addEventListener('mouseleave', () => {
  hideImgTooltip();
  hideLinkTooltip();
});

// ── Ctrl+Click on links to open files ──
editor.addEventListener('click', (e: MouseEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const target = (e.target as HTMLElement).closest('a');
  if (!target) return;
  const href = target.getAttribute('href');
  if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) return;
  e.preventDefault();
  e.stopPropagation();
  vscode.postMessage({ type: 'openFile', href });
});

// ── Notify extension we're ready ──
vscode.postMessage({ type: 'ready' });
