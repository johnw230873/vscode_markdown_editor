// Outline / navigation pane: lists all headings, click-to-scroll,
// scroll-spy highlights the active heading.

import { state, editor, editorContainer, navPane, navList } from '../state';

let navUpdateTimer: ReturnType<typeof setTimeout> | null = null;

function toggleNav(show?: boolean): void {
  state.isNavVisible = show !== undefined ? show : !state.isNavVisible;
  navPane.style.display = state.isNavVisible ? 'flex' : 'none';
  const btn = document.getElementById('toggleNavBtn');
  if (btn) btn.classList.toggle('active', state.isNavVisible);
  if (state.isNavVisible) refreshNav();
}

function refreshNav(): void {
  if (!state.isNavVisible) return;
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

export function scheduleNavRefresh(): void {
  if (navUpdateTimer) clearTimeout(navUpdateTimer);
  navUpdateTimer = setTimeout(refreshNav, 600);
}

export function initOutline(): void {
  document.getElementById('toggleNavBtn')!.addEventListener('click', () => toggleNav());
  document.getElementById('navCloseBtn')!.addEventListener('click', () => toggleNav(false));

  // Scroll-spy: highlight active heading in nav
  editorContainer.addEventListener('scroll', () => {
    if (!state.isNavVisible) return;
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
}
