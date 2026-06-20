import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MarkdownEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'visualMarkdownEditor.editor',
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('visualMarkdownEditor.openVisualEditor', async (uri?: vscode.Uri) => {
      if (!uri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'markdown') {
          uri = activeEditor.document.uri;
        }
      }
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'visualMarkdownEditor.editor');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('visualMarkdownEditor.newDocument', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('Open a folder first to create a new document.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Enter document name',
        placeHolder: 'my-document.md',
        validateInput: (v) => {
          if (!v.trim()) return 'Name is required';
          return null;
        },
      });

      if (!name) return;

      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);

      await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name.replace(/\.md$/, '')}\n\n`));
      await vscode.commands.executeCommand('vscode.openWith', uri, 'visualMarkdownEditor.editor');
    })
  );

  /**
   * Toggle the active Markdown file between the Visual Markdown Editor (custom
   * webview editor) and VS Code's built-in Text Editor.
   *
   * Why this exists: the visual editor is a webview, so Copilot Chat / inline
   * completions / `#selection` can't see what the user has selected inside it.
   * Swapping to a real Text Editor — in the same tab, no split — restores all
   * of those features. Press Ctrl+Alt+V (or click "Text Editor" in the status
   * bar) to flip; press it again to flip back.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'visualMarkdownEditor.toggleTextEditor',
      async (uri?: vscode.Uri) => {
        const activeTextEditor = vscode.window.activeTextEditor;

        // 1. Caller passed a URI (e.g. the webview's status-bar button) — use it.
        // 2. User is currently in a Text Editor — use that document's URI.
        // 3. User is in the visual editor (webview focused) — fall back to the
        //    most recently active custom editor URI tracked by the provider.
        if (!uri) {
          if (activeTextEditor) {
            uri = activeTextEditor.document.uri;
          } else {
            uri = MarkdownEditorProvider.getActiveUri();
          }
        }

        if (!uri) {
          vscode.window.showWarningMessage(
            'Toggle Text Editor: open a Markdown file first.'
          );
          return;
        }

        // If a Text Editor is currently active for this URI, switch to the
        // visual editor. Otherwise switch to the default Text Editor.
        const inTextEditor = !!activeTextEditor
          && activeTextEditor.document.uri.toString() === uri.toString();

        const targetEditor = inTextEditor
          ? 'visualMarkdownEditor.editor'
          : 'default';

        await vscode.commands.executeCommand('vscode.openWith', uri, targetEditor);
      }
    )
  );
}

export function deactivate() {}
