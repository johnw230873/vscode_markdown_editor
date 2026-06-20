// Image hover tooltip. Shows the image's relative filename after a 700ms
// dwell time.

import { state, editor } from '../state';
import { getImageRelativePath } from './contextMenus';

const imgTooltip = document.createElement('div');
imgTooltip.id = 'imgTooltip';
imgTooltip.className = 'img-tooltip';
document.body.appendChild(imgTooltip);

function showImgTooltip(img: HTMLImageElement, x: number, y: number): void {
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

function hideImgTooltip(): void {
  imgTooltip.style.display = 'none';
  if (state.imgTooltipTimer) { clearTimeout(state.imgTooltipTimer); state.imgTooltipTimer = null; }
  state.tooltipImg = null;
}

export function initImageTooltip(): void {
  editor.addEventListener('mousemove', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      if (state.tooltipImg !== img) {
        hideImgTooltip();
        state.tooltipImg = img;
      }
      if (state.imgTooltipTimer) clearTimeout(state.imgTooltipTimer);
      const cx = e.clientX;
      const cy = e.clientY;
      state.imgTooltipTimer = setTimeout(() => showImgTooltip(img, cx, cy), 700);
    } else {
      if (state.tooltipImg) hideImgTooltip();
    }
  });

  editor.addEventListener('mouseleave', () => {
    hideImgTooltip();
  });
}
