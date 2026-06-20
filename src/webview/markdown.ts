// Markdown <-> HTML conversion.
// Configures `marked` (MD -> HTML) and `turndown` (HTML -> MD) with the same
// rules as the original monolithic webview so output is byte-for-byte identical.
//
// Image paths are resolved against window.__baseUri (document dir) or
// window.__attachmentsBaseUri (parent dir, used for /.attachments/ paths).

import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

marked.setOptions({
  gfm: true,
  breaks: true,
});

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

interface WebviewWindow extends Window {
  __baseUri?: string;
  __attachmentsBaseUri?: string;
}

function getWebviewWindow(): WebviewWindow {
  return window as unknown as WebviewWindow;
}

export function markdownToHtml(md: string): string {
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
  const w = getWebviewWindow();
  const baseUri = w.__baseUri;
  const attachmentsBaseUri = w.__attachmentsBaseUri;
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
          // /.attachments/ -> resolve from parent (attachmentsBaseUri)
          base = attachmentsBaseUri || baseUri;
        } else {
          // .attachments/ or other relative -> resolve from document directory
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

export function htmlToMarkdown(html: string): string {
  // Strip webview base URI from image src before conversion so markdown gets relative paths
  // IMPORTANT: strip baseUri (more specific/longer) BEFORE attachmentsBaseUri (parent)
  // to avoid partial matches leaving folder names like "markdown/" behind
  const w = getWebviewWindow();
  const baseUri = w.__baseUri;
  const attachmentsBaseUri = w.__attachmentsBaseUri;
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
