import * as vscode from "vscode";
import { VIEW_IDS, MSG_TYPES } from "../constants";
import { handleMessage } from "./messageHandler";
import type { LlmRouter } from "../llm/router";
import type { L1Writer } from "../storage/l1Writer";
import type { ChatStore } from "../storage/chatStore";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  // Mutable ref shared with messageHandler so an `abort` message can cancel
  // the in-flight chat request.
  private abortRef: { current: AbortController | null } = { current: null };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly router: LlmRouter,
    private readonly l1Writer: L1Writer,
    private readonly chatStore: ChatStore
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    console.log("[pylearner] resolveWebviewView called");
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (payload) => {
      await handleMessage(
        payload,
        webviewView.webview,
        this.context.secrets,
        this.router,
        this.l1Writer,
        this.chatStore,
        this.abortRef
      );
    });
  }

  postMessage(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "webview-ui",
      "dist"
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "assets", "index.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "assets", "index.css")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Python Learner Chat</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
