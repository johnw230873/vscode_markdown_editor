// Client-side spell check.
// - `dictionary` is a Set seeded from `an-array-of-english-words` plus a few
//   short technical words.
// - `checkWord()` / `getSuggestions()` power the context-menu suggestions.
// - `requestSpellCheck()` debounces a re-scan of the editor text and updates
//   the CSS Custom Highlight API ranges for squiggly underlines.

import words from 'an-array-of-english-words';
import { state, editor } from './state';
import { postMessage } from './vscodeApi';

const dictionary = new Set(words);
['i', 'a', 'vs', 'ok', 'eg', 'ie', 'etc', 'url', 'html', 'css', 'js', 'ts',
 'api', 'ui', 'id', 'pdf', 'http', 'https', 'www', 'dev', 'src', 'img'].forEach(w => dictionary.add(w));

export function checkWord(word: string): boolean {
  if (word.length < 2) return true;
  const lower = word.toLowerCase();
  return dictionary.has(lower) || dictionary.has(word);
}

export function edits1(word: string): string[] {
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

export function getSuggestions(word: string, max: number = 6): string[] {
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

let spellCheckTimer: ReturnType<typeof setTimeout> | null = null;

export function requestSpellCheck(): void {
  if (spellCheckTimer) clearTimeout(spellCheckTimer);
  spellCheckTimer = setTimeout(runSpellCheck, 300);
}

function runSpellCheck(): void {
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
  state.currentMisspelled = misspelled;
  applySpellHighlights();
}

function applySpellHighlights(): void {
  // Use CSS Custom Highlight API if available
  if (!(CSS as any).highlights) return;
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
      if (state.currentMisspelled.has(word.toLowerCase())) {
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

/** Add a custom word (from context menu) to the in-memory dictionary and notify the host. */
export function addCustomWord(word: string): void {
  const lower = word.toLowerCase();
  state.currentMisspelled.delete(lower);
  dictionary.add(lower);
  postMessage({ type: 'addCustomWord', word: lower });
  applySpellHighlights();
}

/** Bulk-load persisted custom words from the extension host. */
export function loadCustomWords(words: string[]): void {
  words.forEach((w) => dictionary.add(w));
  requestSpellCheck();
}

/** Replace a misspelled word at a saved (Text node, start, end) target. */
export function replaceWordAt(replacement: string): void {
  if (!state.contextMenuTarget) return;
  const { node, start, end } = state.contextMenuTarget;
  const text = node.textContent || '';
  node.textContent = text.slice(0, start) + replacement + text.slice(end);
  state.contextMenuTarget = null;
  // Schedule sync + re-spellcheck via dynamic import to avoid circular dep
  // with sync.ts (which imports state, not spellcheck).
  import('./sync').then(({ scheduleSync }) => {
    scheduleSync();
    requestSpellCheck();
  });
}
