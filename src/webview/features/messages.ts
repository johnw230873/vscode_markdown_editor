// Inbound message handler from the extension host.
//   - 'update'           : document content changed externally; refresh editor.
//   - 'loadCustomWords'  : add user-persisted words to the dictionary.
//   - 'imageInserted'    : image was saved to .attachments/; insert at cursor.

import { state, editor, sourceEditor } from '../state';
import { markdownToHtml } from '../markdown';
import { updateWordCount } from '../sync';
import { scheduleNavRefresh } from './outline';
import { requestSpellCheck, loadCustomWords } from '../spellcheck';
import { execCmd } from '../sync';
import { escapeHtml } from '../utils';

interface InboundMessage {
  type: 'update' | 'loadCustomWords' | 'imageInserted';
  content?: string;
  words?: string[];
  src?: string;
  alt?: string;
  markdownPath?: string;
}

export function initMessages(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as InboundMessage;
    switch (message.type) {
      case 'update': {
        state.isUpdatingFromExtension = true;
        const html = markdownToHtml(message.content || '');
        if (!state.isSourceView) {
          // Preserve scroll position
          const scrollTop = editor.scrollTop;
          editor.innerHTML = html;
          editor.scrollTop = scrollTop;
        } else {
          sourceEditor.value = message.content || '';
        }
        updateWordCount(message.content || '');
        // Keep flag true briefly to catch async input events from innerHTML
        setTimeout(() => {
          state.isUpdatingFromExtension = false;
        }, 100);
        scheduleNavRefresh();
        requestSpellCheck();
        break;
      }

      case 'loadCustomWords': {
        loadCustomWords(message.words || []);
        break;
      }

      case 'imageInserted': {
        const imgHtml = `<img src="${escapeHtml(message.src || '')}" alt="${escapeHtml(message.alt || '')}" style="max-width: 100%;">`;
        if (!state.isSourceView) {
          execCmd('insertHTML', imgHtml + '<p><br></p>');
        } else {
          const mdImage = `![${message.alt || ''}](${message.markdownPath || ''})`;
          const pos = sourceEditor.selectionStart;
          const before = sourceEditor.value.substring(0, pos);
          const after = sourceEditor.value.substring(pos);
          sourceEditor.value = before + mdImage + after;
          // Trigger a sync (input event won't fire on programmatic value set).
          state.hasUserEdited = true;
          import('../sync').then(({ scheduleSync }) => scheduleSync());
        }
        break;
      }
    }
  });
}
