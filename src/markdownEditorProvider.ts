import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const docDir = path.dirname(document.uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const localRoots: vscode.Uri[] = [
      this.context.extensionUri,
      vscode.Uri.file(docDir),
    ];
    if (workspaceFolder) {
      localRoots.push(workspaceFolder.uri);
    } else {
      // Fallback: allow parent and grandparent directories
      localRoots.push(vscode.Uri.file(path.dirname(docDir)));
    }
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    };

    let isWebviewEdit = false;

    const updateWebview = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        content: document.getText(),
      });
    };

    // Register message handler BEFORE setting HTML (which triggers script execution)
    // IMPORTANT: handler is NOT async — all async work is fire-and-forget to prevent
    // VS Code from serializing message processing behind pending promises.
    webviewPanel.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'ready':
          updateWebview();
          // Send saved custom words to webview
          const customWords = this.context.globalState.get<string[]>('customDictionaryWords', []);
          webviewPanel.webview.postMessage({ type: 'loadCustomWords', words: customWords });
          return;

        case 'addCustomWord': {
          const words = this.context.globalState.get<string[]>('customDictionaryWords', []);
          const word = message.word as string;
          if (!words.includes(word)) {
            words.push(word);
            this.context.globalState.update('customDictionaryWords', words);
          }
          return;
        }

        case 'edit': {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            message.content
          );
          isWebviewEdit = true;
          vscode.workspace.applyEdit(edit).then(() => {
            isWebviewEdit = false;
          });
          return;
        }

        case 'insertImage': {
          this.handleInsertImage(document, webviewPanel);
          return;
        }

        case 'pasteImage': {
          this.handlePasteImage(document, webviewPanel, message.data, message.mimeType);
          return;
        }

        case 'deleteImage': {
          this.handleDeleteImage(document, message.relativePath);
          return;
        }

        case 'showInfo':
          vscode.window.showInformationMessage(message.text);
          return;
      }
    });

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
        if (!isWebviewEdit) {
          updateWebview();
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    // Set HTML last — this triggers webview script execution
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);
  }

  private async handleInsertImage(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'],
      },
      title: 'Select Image',
    });

    if (fileUris && fileUris.length > 0) {
      const result = await this.saveImageToAttachments(document.uri, fileUris[0]);
      if (result) {
        const src = webviewPanel.webview.asWebviewUri(
          vscode.Uri.file(result.filePath)
        ).toString();
        webviewPanel.webview.postMessage({
          type: 'imageInserted',
          src,
          markdownPath: result.relativePath,
          alt: result.fileName,
        });
      }
    }
  }

  private async handlePasteImage(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    data: string,
    mimeType: string
  ): Promise<void> {
    const result = await this.saveBase64Image(document.uri, data, mimeType);
    if (result) {
      const src = webviewPanel.webview.asWebviewUri(
        vscode.Uri.file(result.filePath)
      ).toString();
      webviewPanel.webview.postMessage({
        type: 'imageInserted',
        src,
        markdownPath: result.relativePath,
        alt: result.fileName,
      });
    }
  }

  private async handleDeleteImage(
    document: vscode.TextDocument,
    relativePath: string
  ): Promise<void> {
    try {
      const docDir = path.dirname(document.uri.fsPath);
      let filePath: string;

      if (relativePath.startsWith('/.attachments/') || relativePath.startsWith('/.attachments\\')) {
        // Leading slash means resolve from parent directory
        const parentDir = path.dirname(docDir);
        filePath = path.join(parentDir, relativePath.slice(1));
      } else {
        filePath = path.join(docDir, relativePath);
      }

      const fileUri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.delete(fileUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to delete image: ${e}`);
    }
  }

  private async saveImageToAttachments(
    documentUri: vscode.Uri,
    imageUri: vscode.Uri
  ): Promise<{ relativePath: string; filePath: string; fileName: string } | null> {
    try {
      const docDir = path.dirname(documentUri.fsPath);
      const attachmentsDir = path.join(docDir, '.attachments');

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(attachmentsDir));

      const originalName = path.basename(imageUri.fsPath);
      const ext = path.extname(originalName);
      const baseName = path.basename(originalName, ext);
      const uniqueName = `${baseName}-${Date.now()}${ext}`;
      const destPath = path.join(attachmentsDir, uniqueName);

      const imageData = await vscode.workspace.fs.readFile(imageUri);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), imageData);

      return {
        relativePath: `.attachments/${uniqueName}`,
        filePath: destPath,
        fileName: baseName,
      };
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to save image: ${e}`);
      return null;
    }
  }

  private async saveBase64Image(
    documentUri: vscode.Uri,
    base64Data: string,
    mimeType: string
  ): Promise<{ relativePath: string; filePath: string; fileName: string } | null> {
    try {
      const docDir = path.dirname(documentUri.fsPath);
      const attachmentsDir = path.join(docDir, '.attachments');

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(attachmentsDir));

      const extMap: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/bmp': '.bmp',
      };
      const ext = extMap[mimeType] || '.png';
      const fileName = `image-${Date.now()}${ext}`;
      const destPath = path.join(attachmentsDir, fileName);

      const buffer = Buffer.from(base64Data, 'base64');
      await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), buffer);

      return {
        relativePath: `.attachments/${fileName}`,
        filePath: destPath,
        fileName: fileName.replace(ext, ''),
      };
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to save pasted image: ${e}`);
      return null;
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
    );

    const docDir = path.dirname(document.uri.fsPath);
    const baseUri = webview.asWebviewUri(vscode.Uri.file(docDir));

    // /.attachments/ paths mean "one directory up from the document"
    const parentDir = path.dirname(docDir);
    const attachmentsBaseUri = webview.asWebviewUri(vscode.Uri.file(parentDir));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Visual Markdown Editor</title>
</head>
<body>
  <div id="toolbar">
    <!-- Row 1: Main formatting -->
    <div class="toolbar-row">
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="undo" title="Undo (Ctrl+Z)">&#x21A9;</button>
        <button class="toolbar-btn" data-command="redo" title="Redo (Ctrl+Y)">&#x21AA;</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <select id="headingSelect" title="Heading Level">
          <option value="p">Normal Text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="h5">Heading 5</option>
          <option value="h6">Heading 6</option>
        </select>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <select id="fontSizeSelect" title="Font Size">
          <option value="">Size</option>
          <option value="1">8pt</option>
          <option value="2">10pt</option>
          <option value="3">12pt</option>
          <option value="4">14pt</option>
          <option value="5">18pt</option>
          <option value="6">24pt</option>
          <option value="7">36pt</option>
        </select>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="toolbar-btn" data-command="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="toolbar-btn" data-command="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="toolbar-btn" data-command="strikeThrough" title="Strikethrough"><s>S</s></button>
        <button class="toolbar-btn" data-command="superscript" title="Superscript">X<sup>2</sup></button>
        <button class="toolbar-btn" data-command="subscript" title="Subscript">X<sub>2</sub></button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <div class="color-btn-wrap">
          <button class="toolbar-btn color-indicator" id="textColorBtn" title="Text Color" style="border-bottom: 3px solid #ff0000;">A</button>
          <div class="color-dropdown" id="textColorDropdown">
            <div class="color-swatches" id="textColorSwatches"></div>
            <div class="color-custom-row">
              <input type="color" id="textColorPicker" value="#ff0000" class="color-picker-inline">
              <span class="color-custom-label">Custom...</span>
            </div>
          </div>
        </div>
        <div class="color-btn-wrap">
          <button class="toolbar-btn color-indicator" id="bgColorBtn" title="Background Color" style="border-bottom: 3px solid #ffff00;">
            <span style="background: #ffff00; padding: 0 3px;">A</span>
          </button>
          <div class="color-dropdown" id="bgColorDropdown">
            <div class="color-swatches" id="bgColorSwatches"></div>
            <div class="color-custom-row">
              <input type="color" id="bgColorPicker" value="#ffff00" class="color-picker-inline">
              <span class="color-custom-label">Custom...</span>
            </div>
          </div>
        </div>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="justifyLeft" title="Align Left">&#x2261;</button>
        <button class="toolbar-btn" data-command="justifyCenter" title="Align Center">&#x2263;</button>
        <button class="toolbar-btn" data-command="justifyRight" title="Align Right">&#x2262;</button>
        <button class="toolbar-btn" data-command="justifyFull" title="Justify">&#x2630;</button>
      </div>
    </div>
    <!-- Row 2: Insert & Structure -->
    <div class="toolbar-row">
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="insertUnorderedList" title="Bullet List">&#x2022; List</button>
        <button class="toolbar-btn" data-command="insertOrderedList" title="Numbered List">1. List</button>
        <button class="toolbar-btn" id="taskListBtn" title="Task List">&#x2611; Tasks</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="indent" title="Increase Indent">&#x21E5;</button>
        <button class="toolbar-btn" data-command="outdent" title="Decrease Indent">&#x21E4;</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="linkBtn" title="Insert Link (Ctrl+K)">&#x1F517; Link</button>
        <button class="toolbar-btn" id="imageBtn" title="Insert Image">&#x1F5BC; Image</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="inlineCodeBtn" title="Inline Code">&lt;/&gt;</button>
        <button class="toolbar-btn" id="codeBlockBtn" title="Code Block">&#x2338; Code</button>
        <select id="codeLanguageSelect" title="Code Language">
          <option value="">Language</option>
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
          <option value="python">Python</option>
          <option value="csharp">C#</option>
          <option value="java">Java</option>
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="json">JSON</option>
          <option value="yaml">YAML</option>
          <option value="bash">Bash</option>
          <option value="sql">SQL</option>
          <option value="xml">XML</option>
          <option value="markdown">Markdown</option>
          <option value="powershell">PowerShell</option>
          <option value="terraform">Terraform</option>
        </select>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="blockquoteBtn" title="Blockquote">&#x275D;</button>
        <button class="toolbar-btn" id="hrBtn" title="Horizontal Rule">&#x2015;</button>
        <button class="toolbar-btn" id="tableBtn" title="Insert Table">&#x25A6; Table</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" data-command="removeFormat" title="Clear Formatting">&#x2718; Clear</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="toggleSourceBtn" title="Toggle Source View">&#x2328; Source</button>
        <button class="toolbar-btn" id="toggleNavBtn" title="Toggle Navigation Pane">&#x2630; Outline</button>
        <button class="toolbar-btn" id="togglePageModeBtn" title="Toggle Page/Full Width">&#x1F4C4; Page</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group zoom-group">
        <label class="zoom-label" for="zoomSlider">&#x1F50D;</label>
        <input type="range" id="zoomSlider" min="50" max="200" value="100" step="10" title="Zoom">
        <span id="zoomValue">100%</span>
      </div>
    </div>
  </div>

  <!-- Table size picker modal -->
  <div id="tableModal" class="modal" style="display:none;">
    <div class="modal-content">
      <h3>Insert Table</h3>
      <div class="modal-body">
        <label>Rows: <input type="number" id="tableRows" value="3" min="1" max="50"></label>
        <label>Columns: <input type="number" id="tableCols" value="3" min="1" max="20"></label>
        <label>Header Row: <input type="checkbox" id="tableHeader" checked></label>
      </div>
      <div class="modal-actions">
        <button id="tableInsertOk" class="modal-btn primary">Insert</button>
        <button id="tableInsertCancel" class="modal-btn">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Link modal -->
  <div id="linkModal" class="modal" style="display:none;">
    <div class="modal-content">
      <h3>Insert Link</h3>
      <div class="modal-body">
        <label>URL: <input type="url" id="linkUrl" placeholder="https://example.com"></label>
        <label>Text: <input type="text" id="linkText" placeholder="Link text"></label>
        <label>Title: <input type="text" id="linkTitle" placeholder="Optional title"></label>
        <label>Open in new tab: <input type="checkbox" id="linkNewTab"></label>
      </div>
      <div class="modal-actions">
        <button id="linkInsertOk" class="modal-btn primary">Insert</button>
        <button id="linkInsertCancel" class="modal-btn">Cancel</button>
      </div>
    </div>
  </div>

  <div id="editorWrapper">
    <nav id="navPane" class="nav-pane" style="display:none;">
      <div class="nav-header">
        <span>Outline</span>
        <button id="navCloseBtn" class="nav-close" title="Close">&times;</button>
      </div>
      <div id="navList" class="nav-list"></div>
    </nav>
    <div id="editorContainer">
      <div id="editor" contenteditable="true" spellcheck="true"></div>
    </div>
  </div>

  <div id="sourceContainer" style="display:none;">
    <textarea id="sourceEditor" spellcheck="false"></textarea>
  </div>

  <div id="statusBar">
    <span id="wordCount">Words: 0</span>
    <span id="charCount">Characters: 0</span>
    <span id="cursorPosition"></span>
  </div>

  <script nonce="${nonce}">
    window.__baseUri = "${baseUri}";
    window.__attachmentsBaseUri = "${attachmentsBaseUri}";
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
