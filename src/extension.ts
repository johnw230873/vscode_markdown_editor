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
}

export function deactivate() {}
