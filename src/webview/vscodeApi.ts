// Thin wrapper around the VS Code webview API so other modules don't have to
// redeclare the global `acquireVsCodeApi` shim.

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export const vscode = acquireVsCodeApi();

export type VsCodeMessage =
  | { type: 'ready' }
  | { type: 'edit'; content: string }
  | { type: 'insertImage' }
  | { type: 'pasteImage'; data: string; mimeType: string }
  | { type: 'deleteImage'; relativePath: string }
  | { type: 'addCustomWord'; word: string }
  | { type: 'showInfo'; text: string };

export function postMessage(message: VsCodeMessage): void {
  vscode.postMessage(message);
}
