// Webview entry point.
// This file is intentionally thin: it imports every feature module and calls
// their `init*()` functions in the right order. All logic lives in the
// `./webview/*` modules.
//
// The only global side effect we expose to inline handlers (task-list
// checkbox `onclick="scheduleSync()"`) is `window.scheduleSync`.

import { postMessage } from './webview/vscodeApi';
import { scheduleSync } from './webview/sync';
import { initToolbar } from './webview/features/toolbar';
import { initColors } from './webview/features/colors';
import { initInsert } from './webview/features/insert';
import { initOutline } from './webview/features/outline';
import { initSourceView, initCursorTracking } from './webview/features/sourceView';
import { initImageTransfer } from './webview/features/imageTransfer';
import { initZoom } from './webview/features/zoom';
import { initImageTooltip } from './webview/features/imageTooltip';
import { initModals } from './webview/features/modals';
import { initContextMenus } from './webview/features/contextMenus';
import { initInput } from './webview/features/input';
import { initMessages } from './webview/features/messages';

// Expose scheduleSync on window for inline onclick handlers in task-list
// checkboxes (see markdown.ts -> markdownToHtml).
(window as any).scheduleSync = scheduleSync;

// Wire up every feature. Order matters in a few places:
//   - Input handlers must come last among editor-listener registrations so
//     they don't double-handle events wired by other features.
//   - Outline must init before messages, because the 'update' handler calls
//     scheduleNavRefresh().
initToolbar();
initColors();
initInsert();
initOutline();
initSourceView();
initImageTransfer();
initZoom();
initImageTooltip();
initModals();
initContextMenus();
initCursorTracking();
initMessages();
initInput();

// Tell the extension host we're ready to receive the initial document.
postMessage({ type: 'ready' });
