import * as vscode from "vscode";
import { VIEW_IDS, MSG_TYPES, LITE_MODE } from "../constants";
import { handleMessage } from "./messageHandler";
import type { LlmRouter } from "../llm/router";
import type { L1Writer } from "../storage/l1Writer";
import type { ChatStore } from "../storage/chatStore";
import type { ProfileRefresher } from "../commands/autoRefresh";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  // Mutable ref shared with messageHandler so an `abort` message can cancel
  // the in-flight chat request.
  private abortRef: { current: AbortController | null } = { current: null };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly routerFactory: () => LlmRouter,
    private readonly l1Writer: L1Writer,
    private readonly chatStore: ChatStore,
    private readonly refresher: ProfileRefresher
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
      const router = this.routerFactory();
      await handleMessage(
        payload,
        webviewView.webview,
        this.context.secrets,
        router,
        this.l1Writer,
        this.chatStore,
        this.abortRef,
        this.context.globalStorageUri,
        // 自动刷新已关闭，传 no-op 占位
        async () => {}
      );
    });
  }

  postMessage(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    // public-lite：AI 助教未启用，展示学生友好提示（不加载聊天应用）
    if (LITE_MODE) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Python Learner</title>
  <style>
    body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
           font-family: system-ui, sans-serif; color: var(--vscode-foreground); background: transparent; }
    .card { text-align: center; padding: 0 24px; line-height: 1.7; }
    .icon { font-size: 40px; margin-bottom: 12px; }
    .title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .desc { font-size: 13px; opacity: 0.75; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚧</div>
    <div class="title">AI 助教休息中</div>
    <div class="desc">当前课堂为精简模式，暂未开启 AI 问答。<br>写代码遇到问题随时举手问老师～</div>
  </div>
</body>
</html>`;
    }
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
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}