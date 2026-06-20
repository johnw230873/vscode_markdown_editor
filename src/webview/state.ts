// Shared state and DOM references for the webview.
// All mutable flags live on the `state` object so mutations are visible to
// every module that imports it (live binding). DOM elements are queried once
// at module load and exported as `const`.

export const editor = document.getElementById('editor') as HTMLElement;
export const editorContainer = document.getElementById('editorContainer') as HTMLElement;
export const wordCountEl = document.getElementById('wordCount') as HTMLElement;
export const charCountEl = document.getElementById('charCount') as HTMLElement;
export const navPane = document.getElementById('navPane') as HTMLElement;
export const navList = document.getElementById('navList') as HTMLElement;
export const headingSelect = document.getElementById('headingSelect') as HTMLSelectElement;
export const fontSizeSelect = document.getElementById('fontSizeSelect') as HTMLSelectElement;
export const zoomSlider = document.getElementById('zoomSlider') as HTMLInputElement;
export const zoomValue = document.getElementById('zoomValue') as HTMLElement;
export const pageModeBtn = document.getElementById('togglePageModeBtn') as HTMLElement;

export interface ContextMenuTarget {
  node: Text;
  start: number;
  end: number;
  word: string;
}

export const state = {
  // View mode flags
  isUpdatingFromExtension: false,
  isNavVisible: false,
  hasUserEdited: false,
  isPageMode: false,

  // Zoom
  currentZoom: 100,

  // Spell-check
  currentMisspelled: new Set<string>(),

  // Color palette
  recentColors: JSON.parse(localStorage.getItem('recentColors') || '[]') as string[],

  // Transient edit state
  editingLinkElement: null as HTMLAnchorElement | null,
  savedCodeRange: null as Range | null,
  savedTableRange: null as Range | null,

  // Context menu state
  contextMenuTarget: null as ContextMenuTarget | null,
  pendingContextMenuPos: { x: 0, y: 0 } as { x: number; y: number },

  // Image tooltip
  tooltipImg: null as HTMLImageElement | null,
  imgTooltipTimer: null as ReturnType<typeof setTimeout> | null,
};
