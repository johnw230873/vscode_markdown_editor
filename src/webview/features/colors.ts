// Color palette UI: preset swatches, recent-colors tracking (persisted in
// localStorage), and wiring for text-color + background-color dropdowns.

import { state } from '../state';
import { execCmd } from '../sync';

const PRESET_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#ff0000', '#ff8c00', '#ffdd00', '#00b050', '#0070c0', '#7030a0',
  '#c00000', '#e36c09', '#bf9000', '#00823b', '#004080', '#4a1a6b',
];

const MAX_RECENT_COLORS = 6;

function addRecentColor(color: string): void {
  const normalized = color.toLowerCase();
  state.recentColors = state.recentColors.filter(c => c !== normalized);
  state.recentColors.unshift(normalized);
  if (state.recentColors.length > MAX_RECENT_COLORS) {
    state.recentColors = state.recentColors.slice(0, MAX_RECENT_COLORS);
  }
  localStorage.setItem('recentColors', JSON.stringify(state.recentColors));
  // Refresh all recent color rows
  document.querySelectorAll('.recent-colors-row').forEach(row => renderRecentRow(row as HTMLElement));
}

function renderRecentRow(row: HTMLElement): void {
  const onPick = (row as any)._onPick as (color: string) => void;
  row.innerHTML = '';
  if (state.recentColors.length === 0) {
    row.style.display = 'none';
    const sep = row.previousElementSibling;
    if (sep?.classList.contains('recent-colors-separator')) (sep as HTMLElement).style.display = 'none';
    return;
  }
  row.style.display = 'grid';
  const sep = row.previousElementSibling;
  if (sep?.classList.contains('recent-colors-separator')) (sep as HTMLElement).style.display = '';
  state.recentColors.forEach((color) => {
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

function buildSwatches(containerId: string, onPick: (color: string) => void, onClear: () => void): void {
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

function closeAllColorDropdowns(): void {
  document.querySelectorAll('.color-dropdown').forEach((d) => d.classList.remove('open'));
}

export function initColors(): void {
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

  textColorPicker.addEventListener('input', () => {
    addRecentColor(textColorPicker.value);
    applyTextColor(textColorPicker.value);
  });
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

  bgColorPicker.addEventListener('input', () => {
    addRecentColor(bgColorPicker.value);
    applyBgColor(bgColorPicker.value);
  });
  buildSwatches('bgColorSwatches', applyBgColor, () => {
    bgColorBtn.style.borderBottomColor = 'transparent';
    const indicator = bgColorBtn.querySelector('span') as HTMLElement;
    if (indicator) indicator.style.background = 'transparent';
    closeAllColorDropdowns();
    execCmd('hiliteColor', 'transparent');
  });

  // Close color dropdowns on outside click
  document.addEventListener('click', () => closeAllColorDropdowns());
}
