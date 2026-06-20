// Zoom + page-mode controls. Zoom is exposed via the status-bar slider and
// Ctrl+wheel. Page mode wraps the editor in a centered "page" layout and
// resets zoom to 100%.

import { state, editor, editorContainer, zoomSlider, zoomValue, pageModeBtn } from '../state';

function setZoom(level: number): void {
  state.currentZoom = Math.max(50, Math.min(200, level));
  (editor.style as any).zoom = `${state.currentZoom}%`;
  zoomSlider.value = String(state.currentZoom);
  zoomValue.textContent = `${state.currentZoom}%`;
}

export function initZoom(): void {
  zoomSlider.addEventListener('input', () => {
    setZoom(parseInt(zoomSlider.value, 10));
  });

  editorContainer.addEventListener('wheel', (e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -10 : 10;
      setZoom(state.currentZoom + delta);
    }
  }, { passive: false });

  pageModeBtn.addEventListener('click', () => {
    state.isPageMode = !state.isPageMode;
    editorContainer.classList.toggle('page-mode', state.isPageMode);
    pageModeBtn.classList.toggle('active', state.isPageMode);
    if (state.isPageMode) setZoom(100);
  });
}
