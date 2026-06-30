import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { marked } from 'marked';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // Tracks the linked plain-text editor (for GitHub Copilot / agent context) per document URI.
  static readonly linkedEditors = new Map<string, vscode.TextEditor>();

  // The document currently active in a visual editor panel.
  static activeDocument: vscode.TextDocument | undefined;

  // Fires whenever the active visual editor document changes (used by the status bar).
  static readonly onActiveDocumentChanged =
    new vscode.EventEmitter<vscode.TextDocument | undefined>();

  /**
   * Toggles the linked plain-text editor: opens it if not visible, closes it if already open.
   */
  static async toggleLinkedTextEditor(document: vscode.TextDocument): Promise<boolean> {
    const uriKey = document.uri.toString();
    const existing = MarkdownEditorProvider.getLinkedEditor(uriKey);
    if (existing) {
      // Close every tab showing this document as a plain-text editor.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === uriKey
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
      MarkdownEditorProvider.linkedEditors.delete(uriKey);
      return false;
    } else {
      await MarkdownEditorProvider.openLinkedTextEditor(document);
      return true;
    }
  }

  /**
   * Opens the markdown source file as a standard text editor beside the visual editor.
   * Copilot agents read from this text editor for document content and selection context.
   */
  static async openLinkedTextEditor(document: vscode.TextDocument): Promise<void> {
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
    MarkdownEditorProvider.linkedEditors.set(document.uri.toString(), editor);
  }

  /**
   * Focuses the linked text editor so Copilot sees it as the active editor.
   * Call this before invoking Copilot inline-chat or asking an agent question.
   */
  static async focusLinkedTextEditor(document: vscode.TextDocument): Promise<void> {
    const uriKey = document.uri.toString();
    const existing = MarkdownEditorProvider.getLinkedEditor(uriKey);
    if (existing) {
      await vscode.window.showTextDocument(existing.document, {
        viewColumn: existing.viewColumn,
        preserveFocus: false,
      });
    } else {
      // Open it first (with focus this time)
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: false,
      });
      MarkdownEditorProvider.linkedEditors.set(uriKey, editor);
    }
  }

  /** Returns the current linked editor if it is still visible, cleaning up stale entries. */
  private static getLinkedEditor(uriKey: string): vscode.TextEditor | undefined {
    // Check ALL visible text editors, not just ones we opened ourselves.
    // This prevents opening a duplicate panel when the file was already open
    // as a plain text editor before the visual editor was activated.
    const current = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uriKey
    );
    if (!current) {
      MarkdownEditorProvider.linkedEditors.delete(uriKey);
      return undefined;
    }
    // Keep the map in sync so selection updates reach the right editor.
    MarkdownEditorProvider.linkedEditors.set(uriKey, current);
    return current;
  }

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
    // True while we are programmatically revealing a line in the linked editor
    // (so we don't echo the change back to the webview as another scrollToLine).
    let isSyncingFromWebview = false;
    // True while we are applying a Visual→Raw selection so the Raw→Visual
    // listener doesn’t echo it straight back.
    let isSyncingSelectionFromVisual = false;

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
          // Send initial Raw button state
          webviewPanel.webview.postMessage({
            type: 'linkedEditorState',
            open: !!MarkdownEditorProvider.getLinkedEditor(document.uri.toString()),
          });
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

        case 'selectionChange': {
          // Sync the selection into the linked text editor so Copilot can see it.
          const uriKey = document.uri.toString();
          const linked = MarkdownEditorProvider.getLinkedEditor(uriKey);
          if (linked) {
            try {
              const startPos = document.positionAt(
                Math.max(0, Math.min(message.startOffset as number, document.getText().length))
              );
              const endPos = document.positionAt(
                Math.max(0, Math.min(message.endOffset as number, document.getText().length))
              );
              const sel = new vscode.Selection(startPos, endPos);
              // Guard: suppress the Raw→Visual echo that would be triggered by
              // the onDidChangeTextEditorSelection fired by setting linked.selection.
              isSyncingSelectionFromVisual = true;
              linked.selection = sel;
              setTimeout(() => { isSyncingSelectionFromVisual = false; }, 400);
              if (!sel.isEmpty) {
                linked.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
              }
            } catch {
              // Document was modified mid-flight; ignore.
            }
          }
          return;
        }

        case 'insertImage': {
          this.handleInsertImage(document, webviewPanel);
          return;
        }

        case 'scrollSync': {
          // Scroll the linked plain-text editor to match the visual editor position.
          const linked = MarkdownEditorProvider.getLinkedEditor(document.uri.toString());
          if (linked) {
            isSyncingFromWebview = true;
            const line = Math.max(0, Math.min(message.line as number, document.lineCount - 1));
            const pos = new vscode.Position(line, 0);
            linked.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
            setTimeout(() => { isSyncingFromWebview = false; }, 300);
          }
          return;
        }

        case 'openLinkedTextEditor': {
          void MarkdownEditorProvider.toggleLinkedTextEditor(document).then((isOpen) => {
            webviewPanel.webview.postMessage({ type: 'linkedEditorState', open: isOpen });
          });
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

        case 'convertSvgToPng': {
          this.handleConvertSvgToPng(
            document,
            webviewPanel,
            message.svgRelativePath,
            message.pngData,
            message.width,
            message.height
          );
          return;
        }

        case 'showInfo':
          vscode.window.showInformationMessage(message.text);
          return;

        case 'executeVsCodeCommand': {
          vscode.commands.executeCommand(message.command as string);
          return;
        }

        case 'exportPdf': {
          this.handleExportPdf(document, message.isDark ?? false);
          return;
        }

        case 'exportDocx': {
          this.handleExportDocx(document);
          return;
        }
      }
    });

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
        if (!isWebviewEdit) {
          updateWebview();
        }
      }
    });

    // Mirror raw-editor text selections into the visual editor.
    const uriString = document.uri.toString();
    const selectionSubscription = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.toString() !== uriString) return;
      if (isSyncingSelectionFromVisual) return;  // don't echo Visual→Raw change back
      if (isSyncingFromWebview) return;           // don't trigger during scroll reveal
      const sel = e.selections[0];
      if (!sel) return;
      if (sel.isEmpty) {
        webviewPanel.webview.postMessage({ type: 'rawSelection', startLine: -1, endLine: -1, selectedText: '' });
        return;
      }
      webviewPanel.webview.postMessage({
        type: 'rawSelection',
        startLine: sel.start.line,
        endLine: sel.end.line,
        selectedText: document.getText(sel),
      });
    });

    // Scroll the visual editor when the user scrolls the linked plain-text editor.
    const visibleRangesSubscription = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (isSyncingFromWebview) return;
      if (e.textEditor.document.uri.toString() !== uriString) return;
      if (e.visibleRanges.length === 0) return;
      const firstLine = e.visibleRanges[0].start.line;
      webviewPanel.webview.postMessage({ type: 'scrollToLine', line: firstLine });
    });

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        MarkdownEditorProvider.activeDocument = document;
      } else if (MarkdownEditorProvider.activeDocument === document) {
        MarkdownEditorProvider.activeDocument = undefined;
      }
      MarkdownEditorProvider.onActiveDocumentChanged.fire(MarkdownEditorProvider.activeDocument);
    });

    webviewPanel.onDidDispose(() => {
      selectionSubscription.dispose();
      visibleRangesSubscription.dispose();
      changeDocumentSubscription.dispose();
      MarkdownEditorProvider.linkedEditors.delete(document.uri.toString());
      if (MarkdownEditorProvider.activeDocument === document) {
        MarkdownEditorProvider.activeDocument = undefined;
        MarkdownEditorProvider.onActiveDocumentChanged.fire(undefined);
      }
    });

    // Set HTML last — this triggers webview script execution
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

    // Fire the initial active-document event so the status bar shows as soon
    // as the panel opens (onDidChangeViewState only fires on *changes*, not
    // on the initial open).
    MarkdownEditorProvider.activeDocument = document;
    MarkdownEditorProvider.onActiveDocumentChanged.fire(document);
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
      // Reject paths that are still full URIs (image was not under a known base directory)
      if (!relativePath || relativePath.includes('://')) {
        vscode.window.showErrorMessage('Cannot delete image: file is not in a recognized location relative to the document.');
        return;
      }

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
      await vscode.workspace.fs.delete(fileUri, { useTrash: true });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to delete image: ${e}`);
    }
  }

  private async handleExportPdf(document: vscode.TextDocument, isDark: boolean): Promise<void> {
    const outPath = document.uri.fsPath.replace(/\.(md|markdown|mdown)$/i, '.pdf');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting to PDF…' },
      async () => {
        try {
          const docDir = path.dirname(document.uri.fsPath);
          const html = buildExportHtml(document.getText(), docDir, '', isDark);
          // Embed images as base64 so Puppeteer can render them without file:// access restrictions
          const htmlWithImages = embedImagesAsBase64(html, docDir);
          await renderHtmlToPdf(htmlWithImages, outPath);
          const open = await vscode.window.showInformationMessage(
            `PDF saved: ${path.basename(outPath)}`, 'Open'
          );
          if (open === 'Open') {
            vscode.env.openExternal(vscode.Uri.file(outPath));
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`PDF export failed: ${e.message}`);
        }
      }
    );
  }

  private async handleExportDocx(document: vscode.TextDocument): Promise<void> {
    const outPath = document.uri.fsPath.replace(/\.(md|markdown|mdown)$/i, '.docx');

    // ── Pre-flight validation ─────────────────────────────────────────────────
    const issues = validateDocxCompatibility(document.getText());
    if (issues.length > 0) {
      const lines = [
        'Word (.docx) export cannot proceed. The following issues must be fixed first:',
        '',
        ...issues.map(i => `  • ${i}`),
        '',
        'Tip: Right-click any SVG image in the editor and choose "Convert to PNG" to convert it.',
      ];
      vscode.window.showErrorMessage(lines.join('\n'), { modal: true });
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting to Word (.docx)…' },
      async () => {
        try {
          const docDir = path.dirname(document.uri.fsPath);
          const html = buildExportHtml(document.getText(), docDir, '', false);
          const htmlWithEmbeddedImages = embedImagesAsBase64(html, docDir, true);
          const HTMLtoDOCX = require('html-to-docx');
          const buf: Buffer = await HTMLtoDOCX(htmlWithEmbeddedImages, null, {
            table: { row: { cantSplit: true } },
            footer: false,
            pageNumber: false,
          });
          fs.writeFileSync(outPath, buf);
          const open = await vscode.window.showInformationMessage(
            `Word document saved: ${path.basename(outPath)}`, 'Open'
          );
          if (open === 'Open') {
            vscode.env.openExternal(vscode.Uri.file(outPath));
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`DOCX export failed: ${e.message}`);
        }
      }
    );
  }

  private async handleConvertSvgToPng(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    svgRelativePath: string,
    pngData: string,
    width: number,
    height: number
  ): Promise<void> {
    try {
      if (!svgRelativePath || svgRelativePath.includes('://')) {
        vscode.window.showErrorMessage('Cannot convert: SVG file is not in a recognized location.');
        return;
      }

      const docDir = path.dirname(document.uri.fsPath);
      let svgFilePath: string;

      if (svgRelativePath.startsWith('/.attachments/') || svgRelativePath.startsWith('/.attachments\\')) {
        const parentDir = path.dirname(docDir);
        svgFilePath = path.join(parentDir, svgRelativePath.slice(1));
      } else {
        svgFilePath = path.join(docDir, svgRelativePath);
      }

      // Save PNG in the same directory as the SVG
      const svgDir = path.dirname(svgFilePath);
      const svgBaseName = path.basename(svgFilePath, path.extname(svgFilePath));
      const pngFileName = `${svgBaseName}-${Date.now()}.png`;
      const pngFilePath = path.join(svgDir, pngFileName);

      // Use Puppeteer (headless browser) to render — supports SVGs with
      // <foreignObject>/embedded HTML that canvas cannot render.
      await renderSvgToPngWithBrowser(svgFilePath, pngFilePath, width, height);

      // Delete the source SVG
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(svgFilePath));
      } catch {
        vscode.window.showWarningMessage('PNG saved but failed to delete original SVG file.');
      }

      // Build the new relative path for the PNG (same structure as SVG path)
      let pngRelativePath: string;
      if (svgRelativePath.startsWith('/.attachments/') || svgRelativePath.startsWith('/.attachments\\')) {
        pngRelativePath = '/.attachments/' + pngFileName;
      } else {
        const svgRelativeDir = path.dirname(svgRelativePath);
        pngRelativePath = svgRelativeDir === '.' ? pngFileName : `${svgRelativeDir}/${pngFileName}`;
      }

      // Build the webview URI for the old SVG (to find it in the DOM) and new PNG
      const baseUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(docDir)).toString();
      const parentDir = path.dirname(docDir);
      const attachmentsBaseUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(parentDir)).toString();

      let oldSrc: string;
      if (svgRelativePath.startsWith('/.attachments/') || svgRelativePath.startsWith('/.attachments\\')) {
        oldSrc = `${attachmentsBaseUri}/${svgRelativePath.slice(1)}`;
      } else {
        oldSrc = `${baseUri}/${svgRelativePath}`;
      }

      const newSrc = webviewPanel.webview.asWebviewUri(vscode.Uri.file(pngFilePath)).toString();

      webviewPanel.webview.postMessage({
        type: 'svgConverted',
        oldSrc,
        newSrc,
        oldRelativePath: svgRelativePath,
        newMarkdownPath: pngRelativePath,
        width,
        height,
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to convert SVG to PNG: ${e}`);
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
    const isSvg = path.extname(document.uri.fsPath).toLowerCase() === '.svg';

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource};">
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
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="markBtn" title="Highlight (Mark)"><mark>A</mark></button>
        <button class="toolbar-btn" data-command="removeFormat" title="Clear Formatting">&#x2718; Clear</button>
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
        <button class="toolbar-btn" id="linkBtn" title="Insert Link (Ctrl+L)">&#x1F517; Link</button>
        <button class="toolbar-btn" id="imageBtn" title="Insert Image">&#x1F5BC; Image</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="inlineCodeBtn" title="Inline Code">&lt;/&gt;</button>
        <button class="toolbar-btn" id="codeBlockBtn" title="Insert Code Block">&#x2338; Code</button>
        <button class="toolbar-btn" id="mermaidBtn" title="Insert Mermaid Diagram">&#x25C7; Mermaid</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="blockquoteBtn" title="Blockquote">&#x275D;</button>
        <button class="toolbar-btn" id="hrBtn" title="Horizontal Rule">&#x2015;</button>
        <button class="toolbar-btn" id="tableBtn" title="Insert Table">&#x25A6; Table</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="exportPdfBtn" title="Export to PDF">&#x2B73; PDF</button>
        <button class="toolbar-btn" id="exportDocxBtn" title="Export to Word (.docx)">&#x2B73; DOCX</button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" id="copilotContextBtn" title="Toggle Open/Close Raw text editor so GitHub Copilot can see this document and selection">&#x1F4CB; Raw</button>
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
      <h3>Link</h3>
      <div class="modal-body">
        <label>URL: <input type="url" id="linkUrl" placeholder="https://example.com"></label>
        <label>Text: <input type="text" id="linkText" placeholder="Link text"></label>
        <label>Title: <input type="text" id="linkTitle" placeholder="Optional title"></label>
        <label>Open in new tab: <input type="checkbox" id="linkNewTab"></label>
      </div>
      <div class="modal-actions">
        <button id="linkInsertOk" class="modal-btn primary">OK</button>
        <button id="linkInsertCancel" class="modal-btn">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Code block modal -->
  <div id="codeBlockModal" class="modal" style="display:none;">
    <div class="modal-content">
      <h3>Insert Code Block</h3>
      <div class="modal-body">
        <label>Language:
          <select id="codeLanguageSelect">
            <option value="">None</option>
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
            <option value="mermaid">Mermaid Diagram</option>
          </select>
        </label>
      </div>
      <div class="modal-actions">
        <button id="codeBlockInsertOk" class="modal-btn primary">Insert</button>
        <button id="codeBlockInsertCancel" class="modal-btn">Cancel</button>
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

  <div id="statusBar">
    <span id="wordCount">Words: 0</span>
    <span id="charCount">Characters: 0</span>
    <span id="cursorPosition"></span>
    <span class="status-spacer"></span>
    <button class="status-btn" id="toggleNavBtn" title="Toggle Outline">&#x2630; Outline</button>
    <button class="status-btn" id="togglePageModeBtn" title="Toggle Page Mode">&#x1F4C4; Page</button>
    <span class="status-separator"></span>
    ${isSvg ? '' : `<label class="zoom-label" for="zoomSlider">&#x1F50D;</label>
    <input type="range" id="zoomSlider" min="50" max="200" value="100" step="10" title="Zoom">
    <span id="zoomValue">100%</span>`}
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

async function renderSvgToPngWithBrowser(svgPath: string, pngPath: string, width: number, height: number): Promise<void> {
  const puppeteer = require('puppeteer-core');
  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error('Could not find Chrome or Edge. Install Google Chrome or Microsoft Edge to convert SVG to PNG.');
  }

  const svgContent = fs.readFileSync(svgPath, 'utf8');

  // Use provided dimensions, fall back to viewBox
  let renderWidth = width;
  let renderHeight = height;
  if (!renderWidth || !renderHeight) {
    const viewBoxMatch = svgContent.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
    renderWidth = viewBoxMatch ? Math.ceil(parseFloat(viewBoxMatch[1])) : 1400;
    renderHeight = viewBoxMatch ? Math.ceil(parseFloat(viewBoxMatch[2])) : 700;
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: renderWidth + 40, height: renderHeight + 40, deviceScaleFactor: 2 });

    const html = `<!DOCTYPE html>
<html><head><style>
body { margin: 0; padding: 20px; background: white; }
svg { display: block; width: ${renderWidth}px; height: ${renderHeight}px; }
</style></head><body>${svgContent}</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const svgElement = await page.$('svg');
    if (svgElement) {
      await svgElement.screenshot({ path: pngPath, type: 'png' });
    } else {
      await page.screenshot({ path: pngPath, type: 'png', fullPage: true });
    }
  } finally {
    await browser.close();
  }
}

function findBrowserPath(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [
        (process.env['PROGRAMFILES(X86)'] ?? '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
        (process.env['PROGRAMFILES'] ?? '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
        (process.env['PROGRAMFILES'] ?? '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES(X86)'] ?? '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['LOCALAPPDATA'] ?? '') + '\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
      ];

  return candidates.find(p => p && fs.existsSync(p));
}

// ── Export helpers ────────────────────────────────────────────────────────────

const DOCX_UNSUPPORTED_IMAGE_EXTS = new Set(['svg', 'webp', 'avif', 'tiff', 'tif']);

/**
 * Scans the markdown for content that cannot be exported to DOCX.
 * Returns a list of human-readable issue descriptions, empty if all clear.
 */
function validateDocxCompatibility(markdown: string): string[] {
  const issues: string[] = [];

  // Find all image references: ![alt](path) and <img src="path">
  const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const htmlImageRegex = /<img[^>]+src="([^"]+)"/gi;

  const checkImagePath = (src: string) => {
    // Ignore external URLs and data URIs
    if (/^https?:\/\//.test(src) || src.startsWith('data:')) return;
    // Strip any sizing suffix like " =300x"
    const cleanSrc = src.split(' ')[0];
    const ext = path.extname(cleanSrc).toLowerCase().slice(1);
    if (DOCX_UNSUPPORTED_IMAGE_EXTS.has(ext)) {
      const fileName = path.basename(cleanSrc);
      issues.push(
        `"${fileName}" is a .${ext} image — Word does not support this format. ` +
        `Convert it to PNG first (right-click the image → "Convert to PNG").`
      );
    }
  };

  let m: RegExpExecArray | null;
  while ((m = mdImageRegex.exec(markdown)) !== null) checkImagePath(m[1]);
  while ((m = htmlImageRegex.exec(markdown)) !== null) checkImagePath(m[1]);

  // Deduplicate (same file referenced multiple times)
  return [...new Set(issues)];
}

marked.setOptions({ gfm: true, breaks: true });

/**
 * Converts the markdown to a standalone HTML page suitable for PDF/DOCX export.
 * Image src attributes are resolved to absolute file:// URIs.
 */
function buildExportHtml(markdown: string, docDir: string, extraCss: string, isDark: boolean): string {
  const bgColor = isDark ? '#1e1e1e' : '#ffffff';
  const fgColor = isDark ? '#d4d4d4' : '#1a1a1a';
  const linkColor = isDark ? '#4ec9b0' : '#0070c1';

  let html = marked.parse(markdown) as string;

  // Resolve relative image paths to absolute file URIs
  html = html.replace(
    /<img\s([^>]*?)src="(?!https?:\/\/|data:|file:)([^"]+)"([^>]*?)>/gi,
    (_match, before, src, after) => {
      // Handle /.attachments/ prefix (one directory up)
      let absPath: string;
      if (src.startsWith('/.attachments/') || src.startsWith('/.attachments\\')) {
        absPath = path.join(path.dirname(docDir), src.slice(1));
      } else {
        absPath = path.resolve(docDir, src);
      }
      const fileUri = `file:///${absPath.replace(/\\/g, '/')}`;
      return `<img ${before}src="${fileUri}"${after}>`;
    }
  );

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
       font-size: 14px; line-height: 1.6; background: ${bgColor}; color: ${fgColor};
       max-width: 860px; margin: 0 auto; padding: 40px 60px; }
h1,h2,h3,h4,h5,h6 { margin-top: 1.4em; margin-bottom: 0.4em; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid ${isDark ? '#444' : '#ddd'}; padding-bottom: 0.2em; }
h2 { font-size: 1.5em; border-bottom: 1px solid ${isDark ? '#333' : '#eee'}; padding-bottom: 0.1em; }
code { background: ${isDark ? '#2d2d2d' : '#f0f0f0'}; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: ${isDark ? '#2d2d2d' : '#f6f8fa'}; padding: 12px 16px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid ${isDark ? '#444' : '#ddd'}; margin: 0; padding: 0 16px; color: ${isDark ? '#999' : '#666'}; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid ${isDark ? '#444' : '#ccc'}; padding: 8px 12px; text-align: left; }
th { background: ${isDark ? '#2d2d2d' : '#f0f0f0'}; font-weight: 600; }
a { color: ${linkColor}; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid ${isDark ? '#444' : '#ddd'}; margin: 1.5em 0; }
${extraCss}
</style>
</head>
<body>${html}</body>
</html>`;
}

/**
 * Replaces file:// image src attributes with base64 data URIs for embedding in DOCX.
 */
/**
 * Embeds images as base64 data URIs.
 * @param forDocx When true, SVG images are stripped (Word doesn't support SVG) and
 *                any unresolvable image is removed rather than kept with a broken src.
 */
function embedImagesAsBase64(html: string, docDir: string, forDocx = false): string {
  return html.replace(
    /<img\s([^>]*?)src="(?!https?:\/\/|data:)([^"]+)"([^>]*?)>/gi,
    (_match, before, src, after) => {
      try {
        let filePath: string;
        if (src.startsWith('file:///')) {
          filePath = decodeURIComponent(src.slice(8).replace(/\//g, path.sep));
        } else if (src.startsWith('/.attachments/') || src.startsWith('/.attachments\\')) {
          filePath = path.join(path.dirname(docDir), src.slice(1));
        } else {
          filePath = path.resolve(docDir, src);
        }
        if (!fs.existsSync(filePath)) {
          return forDocx ? '' : _match; // remove broken images for DOCX, keep for PDF
        }
        const ext = path.extname(filePath).toLowerCase().slice(1);
        if (forDocx && ext === 'svg') {
          return ''; // Word doesn't support SVG — strip it
        }
        const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
        const b64 = fs.readFileSync(filePath).toString('base64');
        return `<img ${before}src="data:image/${mime};base64,${b64}"${after}>`;
      } catch {
        return forDocx ? '' : _match;
      }
    }
  );
}

async function renderHtmlToPdf(html: string, outPath: string): Promise<void> {
  const puppeteer = require('puppeteer-core');
  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error('Could not find Chrome or Edge. Install Google Chrome or Microsoft Edge to export PDF.');
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Write to a temp file so page.goto() is used instead of setContent().
  // setContent() can hit Puppeteer's 30s navigation timeout with large base64 content;
  // goto('file://...') with waitUntil:'load' is far more reliable.
  const tmpFile = path.join(os.tmpdir(), `vme-pdf-${Date.now()}.html`);
  fs.writeFileSync(tmpFile, html, 'utf8');

  try {
    const page = await browser.newPage();
    const fileUrl = 'file:///' + tmpFile.replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 120000 });
    await page.pdf({
      path: outPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    await browser.close();
  }
}
