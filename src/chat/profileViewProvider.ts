// Read-only "Learner Profile" sidebar view.
//
// Renders the synthesized L3 profile (profile.md) in a dedicated webview next
// to the chat. The host owns profile.md; the panel asks for it on show and
// re-renders whatever snapshot comes back. "Update" triggers a pipeline run
// through the same code path as the `pylearner.updateProfile` command.

import * as vscode from "vscode";
import { MSG_TYPES } from "../constants";
import type { LlmRouter } from "../llm/router";
import { serialize } from "../memory/document";
import { loadL3Doc, loadL3Meta } from "../memory/store";
import { runProfileUpdate } from "../commands/updateProfile";

export interface ProfileSnapshot {
  exists: boolean;
  markdown: string;
  updatedAt: string | null;
}

export class ProfileViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly router: LlmRouter
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (payload: Record<string, unknown>) => {
        switch (payload.type) {
          case MSG_TYPES.getProfile:
            await this.postSnapshot();
            break;
          case MSG_TYPES.updateProfile:
            await this.updateAndPost();
            break;
        }
      }
    );

    // Load the profile as soon as the view is shown.
    void this.postSnapshot();
  }

  private async postSnapshot(): Promise<void> {
    if (!this._view) return;
    const snapshot = await loadProfileSnapshot(this.context.globalStorageUri);
    await this._view.webview.postMessage({ type: MSG_TYPES.profile, snapshot });
  }

  private async updateAndPost(): Promise<void> {
    if (!this._view) return;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Updating learner profile…",
          cancellable: false,
        },
        async () => runProfileUpdate(this.context.globalStorageUri, this.router)
      );
    } catch (err) {
      await this._view.webview.postMessage({
        type: MSG_TYPES.error,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await this.postSnapshot();
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "webview-ui",
      "dist"
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "assets", "profile.js")
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
  <title>Python Learner Profile</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function loadProfileSnapshot(
  storageUri: vscode.Uri
): Promise<ProfileSnapshot> {
  const doc = await loadL3Doc(storageUri, "profile");
  if (!doc) return { exists: false, markdown: "", updatedAt: null };
  const meta = await loadL3Meta(storageUri, "profile");
  return { exists: true, markdown: serialize(doc), updatedAt: meta.last_update_at };
}
