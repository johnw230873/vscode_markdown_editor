// Map a DOM selection inside the WYSIWYG editor to character offsets in the
// equivalent markdown source.
//
// Used when the user clicks the "Text Editor" button: we want the selection
// they had in the visual editor to be preserved (as closely as possible) in
// the raw-markdown Text Editor that opens.
//
// Algorithm:
//   - For each endpoint (start / end) of the selection, walk up the DOM to
//     find the containing block element (P, H1-H6, LI, BLOCKQUOTE, etc.).
//   - Find the markdown line whose "stripped" text matches the block's text.
//   - Within that markdown line, find where the in-block text-before-endpoint
//     starts, and add the length to get the offset.
//   - If we can't match a block (rare — e.g., selection in an unknown tag),
//     fall back to a proportional offset based on plain-text position.
//
// Caveats:
//   - Approximate, not pixel-perfect. Inline syntax like `**bold**` or
//     `[text](url)` complicates the within-line mapping; we use a forgiving
//     substring search.
//   - Multi-block selections work (start and end are computed independently).
//   - Code blocks (PRE) are handled by matching the fence + content.

import { editor } from '../state';
import { htmlToMarkdown } from '../markdown';

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI',
  'BLOCKQUOTE', 'PRE', 'DIV', 'TD', 'TH', 'HR',
]);

export interface MarkdownSelectionOffsets {
  /** Full markdown content (so the extension can sync the doc before selecting). */
  markdown: string;
  /** Character offset in `markdown` where the selection starts. */
  startOffset: number;
  /** Character offset in `markdown` where the selection ends. */
  endOffset: number;
}

/**
 * Compute the markdown character offsets corresponding to the editor's current
 * DOM selection. Returns `null` if there's no selection or the selection is
 * collapsed (cursor only — we don't bother mapping a cursor, only a range).
 */
export function getMarkdownOffsetsForSelection(): MarkdownSelectionOffsets | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  if (sel.isCollapsed) return null; // cursor only — nothing to map
  if (!editor.contains(sel.getRangeAt(0).startContainer)) return null;
  if (!editor.contains(sel.getRangeAt(0).endContainer)) return null;

  const markdown = htmlToMarkdown(editor.innerHTML);
  const startOffset = getOffsetForPosition(markdown, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const endOffset = getOffsetForPosition(markdown, sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);

  // Guard against reversed / equal offsets (shouldn't happen but be defensive).
  if (endOffset < startOffset) {
    return { markdown, startOffset: endOffset, endOffset: startOffset };
  }
  if (startOffset === endOffset) return null;

  return { markdown, startOffset, endOffset };
}

/**
 * Compute the markdown character offset for a single (node, offset) position
 * inside the editor. Walks up to the containing block, finds the matching
 * markdown line, then adds a within-line offset.
 */
function getOffsetForPosition(md: string, container: Node, offset: number): number {
  const mdLines = md.split('\n');

  // Walk up from the position to find the nearest block-level element.
  let blockEl: Element | null = null;
  let cur: Node | null = container;
  while (cur && cur !== editor) {
    if (cur.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((cur as Element).tagName)) {
      blockEl = cur as Element;
      break;
    }
    cur = cur.parentNode;
  }

  if (!blockEl) {
    return proportionalFallback(md, mdLines, container, offset);
  }

  // Special case: PRE (code block) — match the fence + content.
  if (blockEl.tagName === 'PRE') {
    return getOffsetInCodeBlock(md, mdLines, blockEl, container, offset);
  }

  // Find the markdown line corresponding to this block.
  const blockText = (blockEl.textContent || '').trim().replace(/\s+/g, ' ');
  const needle = blockText.slice(0, 40);
  let targetLine = -1;

  if (needle.length >= 3) {
    for (let i = 0; i < mdLines.length; i++) {
      const stripped = mdLines[i]
        .replace(/^[#\s\-*+>`|[\]!]+/, '')
        .trim()
        .replace(/\s+/g, ' ');
      if (stripped.length >= 3 && needle.startsWith(stripped.slice(0, Math.min(stripped.length, 30)))) {
        targetLine = i;
        break;
      }
    }
  }

  if (targetLine === -1) {
    return proportionalFallback(md, mdLines, container, offset);
  }

  // Compute the line's starting character offset in the full markdown.
  let lineStart = 0;
  for (let i = 0; i < targetLine; i++) {
    lineStart += mdLines[i].length + 1; // +1 for '\n'
  }

  // Get the text BEFORE the position, scoped to the block element.
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let textBefore = '';
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === container) {
      textBefore += (node.textContent ?? '').slice(0, offset);
      break;
    }
    textBefore += node.textContent ?? '';
  }
  const normalizedBefore = textBefore.replace(/\s+/g, ' ').trim();

  // Find where this text starts in the markdown line (after stripping leading
  // syntax characters like `#`, `-`, `>`, etc.).
  const mdLine = mdLines[targetLine];
  const leadingSyntax = mdLine.match(/^[#\s\-*+>`|[\]!]+/);
  const strippedStart = leadingSyntax ? leadingSyntax[0].length : 0;
  const strippedLine = mdLine.slice(strippedStart);

  const withinLine = findApproximateIndex(strippedLine, normalizedBefore);

  return lineStart + strippedStart + withinLine;
}

/**
 * For code blocks: find the ``` fence in markdown and map the position within
 * the <pre><code> element to a character offset inside the fenced block.
 */
function getOffsetInCodeBlock(
  md: string,
  mdLines: string[],
  preEl: Element,
  container: Node,
  offset: number,
): number {
  const codeText = (preEl.querySelector('code')?.textContent || preEl.textContent || '');
  const codeLines = codeText.split('\n');
  // Use the first non-empty line of the code as a needle.
  const needle = codeLines.find(l => l.trim().length >= 3)?.trim().slice(0, 40) || '';

  // Find a ``` fence line in markdown followed by a line containing the needle.
  for (let i = 0; i < mdLines.length - 1; i++) {
    if (mdLines[i].trim().startsWith('```')) {
      // Check if the next line matches the needle.
      if (needle && mdLines[i + 1].includes(needle.slice(0, Math.min(needle.length, 20)))) {
        // Found the code block. Compute the text-before-position within <pre>.
        const walker = document.createTreeWalker(preEl, NodeFilter.SHOW_TEXT);
        let textBefore = '';
        let node: Node | null;
        let matchedNode = false;
        while ((node = walker.nextNode())) {
          if (node === container) {
            textBefore += (node.textContent ?? '').slice(0, offset);
            matchedNode = true;
            break;
          }
          textBefore += node.textContent ?? '';
        }
        if (!matchedNode) return 0;

        // Offset = start of fence line + fence line length + 1 (for \n) + textBefore length
        let fenceStart = 0;
        for (let j = 0; j < i; j++) {
          fenceStart += mdLines[j].length + 1;
        }
        return fenceStart + mdLines[i].length + 1 + textBefore.length;
      }
    }
  }

  return proportionalFallback(md, mdLines, container, offset);
}

/**
 * Last-resort proportional mapping: compute the plain-text position of the
 * endpoint as a fraction of the editor's total plain text, then map that
 * fraction to a character offset in the markdown.
 */
function proportionalFallback(
  md: string,
  mdLines: string[],
  container: Node,
  offset: number,
): number {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let textBefore = '';
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === container) {
      textBefore += (node.textContent ?? '').slice(0, offset);
      break;
    }
    textBefore += node.textContent ?? '';
  }
  const total = editor.innerText || '';
  if (total.length === 0) return 0;

  const ratio = textBefore.length / total.length;
  const targetLine = Math.floor(ratio * mdLines.length);
  const clamped = Math.max(0, Math.min(targetLine, mdLines.length - 1));
  return mdLines.slice(0, clamped).join('\n').length + (clamped > 0 ? 1 : 0);
}

/**
 * Find the index of `needle` in `haystack`, with progressively looser matching
 * if exact search fails. Returns 0 if nothing matches.
 */
function findApproximateIndex(haystack: string, needle: string): number {
  if (!needle) return 0;
  // Exact match.
  let idx = haystack.indexOf(needle);
  if (idx >= 0) return idx;
  // First ~10 chars.
  if (needle.length > 10) {
    idx = haystack.indexOf(needle.slice(0, 10));
    if (idx >= 0) return idx;
  }
  // First 5 chars.
  if (needle.length > 5) {
    idx = haystack.indexOf(needle.slice(0, 5));
    if (idx >= 0) return idx;
  }
  // First non-whitespace character.
  const firstChar = needle.trim()[0];
  if (firstChar) {
    idx = haystack.indexOf(firstChar);
    if (idx >= 0) return idx;
  }
  return 0;
}
