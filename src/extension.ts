import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MarkdownEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'visualMarkdownEditor.editor',
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
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

  // ── Status bar item ─────────────────────────────────────────────────────────
  // Shows when a Visual Markdown Editor panel is active.  Click it to open the
  // linked plain-text editor beside the visual editor — this is what lets
  // GitHub Copilot see the document content and your current selection.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'visualMarkdownEditor.openLinkedTextEditor';
  statusBar.tooltip = 'Open linked text editor so GitHub Copilot can see this document and selection';
  context.subscriptions.push(statusBar);

  function updateStatusBar(doc: vscode.TextDocument | undefined) {
    if (!doc) {
      statusBar.hide();
      return;
    }
    const hasLinked = MarkdownEditorProvider.linkedEditors.has(doc.uri.toString());
    statusBar.text = hasLinked ? '$(link) Copilot: linked' : '$(link) Copilot: open text view';
    statusBar.show();
  }

  context.subscriptions.push(
    MarkdownEditorProvider.onActiveDocumentChanged.event(updateStatusBar)
  );
  // ────────────────────────────────────────────────────────────────────────────

  // Opens the active visual editor's markdown file as a plain text editor beside it.
  // The text editor's selection is kept in sync with the visual editor, so GitHub
  // Copilot agents can see both the document content and the current selection.
  context.subscriptions.push(
    vscode.commands.registerCommand('visualMarkdownEditor.openLinkedTextEditor', async () => {
      const doc = MarkdownEditorProvider.activeDocument;
      if (!doc) {
        vscode.window.showInformationMessage(
          'No Visual Markdown Editor is currently active.'
        );
        return;
      }
      await MarkdownEditorProvider.openLinkedTextEditor(doc);
      updateStatusBar(doc);
    })
  );

  // Focuses the linked text editor so Copilot sees it as the active editor.
  // Use this before invoking Copilot inline-chat or asking an agent a question
  // about the content you have selected in the visual editor.
  context.subscriptions.push(
    vscode.commands.registerCommand('visualMarkdownEditor.focusLinkedTextEditor', async () => {
      const doc = MarkdownEditorProvider.activeDocument;
      if (!doc) {
        vscode.window.showInformationMessage(
          'No Visual Markdown Editor is currently active. Open a linked text editor first.'
        );
        return;
      }
      await MarkdownEditorProvider.focusLinkedTextEditor(doc);
    })
  );

  // ── SVG to PNG conversion ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('visualMarkdownEditor.convertSvgToPng', async (uri?: vscode.Uri) => {
      if (!uri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.fileName.endsWith('.svg')) {
          uri = activeEditor.document.uri;
        } else {
          const files = await vscode.window.showOpenDialog({
            filters: { 'SVG Files': ['svg'] },
            canSelectMany: false,
          });
          if (!files || files.length === 0) return;
          uri = files[0];
        }
      }

      const svgPath = uri.fsPath;
      const pngPath = svgPath.replace(/\.svg$/i, '.png');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Converting SVG to PNG...' },
        async () => {
          try {
            await convertSvgToPng(svgPath, pngPath);
            vscode.window.showInformationMessage(`PNG saved: ${path.basename(pngPath)}`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`SVG conversion failed: ${err.message}`);
          }
        }
      );
    })
  );
}

async function convertSvgToPng(svgPath: string, pngPath: string): Promise<void> {
  const puppeteer = require('puppeteer-core');

  // Find Chrome/Edge on the system
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error(
      'Could not find Chrome or Edge. Install Google Chrome or Microsoft Edge to use SVG conversion.'
    );
  }

  const svgContent = fs.readFileSync(svgPath, 'utf8');

  // Extract viewBox dimensions
  const viewBoxMatch = svgContent.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
  const width = viewBoxMatch ? Math.ceil(parseFloat(viewBoxMatch[1])) : 1400;
  const height = viewBoxMatch ? Math.ceil(parseFloat(viewBoxMatch[2])) : 700;

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: width + 40, height: height + 40, deviceScaleFactor: 2 });

    const html = `<!DOCTYPE html>
<html><head><style>
body { margin: 0; padding: 20px; background: white; }
svg { display: block; width: ${width}px; height: ${height}px; }
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

function findBrowser(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [
        process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
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

export function deactivate() {}
