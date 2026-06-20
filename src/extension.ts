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
   *
   * Selection preservation: when the user clicks the "Text Editor" button
   * (not the keyboard shortcut), the webview sends the markdown content plus
   * start/end character offsets for the current selection. We apply the
   * markdown to the document (so the text editor sees the latest content),
   * open the text editor, then set the selection using those offsets.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'visualMarkdownEditor.toggleTextEditor',
      async (
        uri?: vscode.Uri,
        selection?: { markdown: string; startOffset: number; endOffset: number },
      ) => {
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

        if (inTextEditor) {
          // Text editor -> visual editor. No selection to preserve in this
          // direction (mapping markdown offsets back to DOM ranges is a
          // separate problem we don't solve here).
          await vscode.commands.executeCommand('vscode.openWith', uri, 'visualMarkdownEditor.editor');
          return;
        }

        // Visual editor -> text editor.
        // If the webview provided selection offsets, sync the document first
        // so the offsets line up with what the text editor will display.
        if (selection) {
          // Apply the webview's markdown to the document via a WorkspaceEdit.
          // This ensures the text editor — which is about to open — sees the
          // exact same content the offsets were computed against.
          const doc = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            0, 0,
            doc.lineCount, 0,
          );
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, fullRange, selection.markdown);
          await vscode.workspace.applyEdit(edit);
        }

        // Open the document in the default Text Editor.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');

        // If we have selection offsets, set the selection now. We need to wait
        // briefly for the new text editor to become the active editor — VS
        // Code doesn't give us a synchronous handle from `vscode.openWith`.
        if (selection) {
          // Wait for the text editor to be active. Poll up to ~500ms.
          const deadline = Date.now() + 500;
          while (Date.now() < deadline) {
            const ed = vscode.window.activeTextEditor;
            if (ed && ed.document.uri.toString() === uri.toString()) {
              const doc = ed.document;
              try {
                const startPos = doc.positionAt(selection.startOffset);
                const endPos = doc.positionAt(selection.endOffset);
                ed.selection = new vscode.Selection(startPos, endPos);
                // Reveal the selection in the viewport.
                ed.revealRange(
                  new vscode.Range(startPos, endPos),
                  vscode.TextEditorRevealType.InCenterIfOutsideViewport,
                );
              } catch {
                // Offsets were out of range — ignore and leave the cursor at 0:0.
              }
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          // If we get here, the text editor never became active in time.
          // The user can still select manually — not catastrophic.
        }
      }
    )
  );
}

export function deactivate() {}
