// Image paste + drag/drop handling. Reads images as base64 and delegates
// file save to the extension host via `pasteImage` messages.

import { postMessage } from '../vscodeApi';

export function initImageTransfer(): void {
  const editor = document.getElementById('editor')!;

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
          postMessage({
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
          postMessage({
            type: 'pasteImage',
            data: base64,
            mimeType: file.type,
          });
        };
        reader.readAsDataURL(file);
      }
    }
  });
}
