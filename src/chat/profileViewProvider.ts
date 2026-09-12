// Read-only "Learner Profile" sidebar view.
//
// Renders the synthesized L3 profile (profile.md) in a dedicated webview next
// to the chat. The host owns profile.md; the panel asks for it on show and
// re-renders whatever snapshot comes back. "Update" triggers a pipeline run
// through the same code path as the `pylearner.updateProfile` command.

import * as vscode from "vscode";
import { MSG_TYPES } from "../constants";
import type { LlmRouter } from "../llm/router";
import { pickProfileView, renderDisplay, renderRaw } from "../memory/document";
import { loadL3Doc, loadL3Meta, loadOverview } from "../memory/store";
import { runProfileUpdate, resetProfile } from "../commands/updateProfile";

export interface ProfileSnapshot {
  exists: boolean;
  markdown: string;     // display view: Chinese, no Identity, no ids/footnotes
  raw: string;          // raw view: Chinese, full content with ids + footnotes
  updatedAt: string | null;
}

export class ProfileViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly routerFactory: () => LlmRouter,
    private readonly outputChannel: vscode.OutputChannel
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
          case MSG_TYPES.getProfileRaw:
            await this.postRawSnapshot();
            break;
          case MSG_TYPES.updateProfile:
            await this.updateAndPost();
            break;
          case MSG_TYPES.resetProfile:
            await this.resetAndPost();
            break;
        }
      }
    );

    // Load the profile as soon as the view is shown. Errors are caught and
    // logged so a transient file/config issue does not crash the host.
    void this.postSnapshot().catch((err) => {
      console.error("[pylearner] initial profile snapshot failed:", err);
    });
  }

  private async postSnapshot(): Promise<void> {
    if (!this._view) return;
    const snapshot = await loadProfileSnapshot(this.context.globalStorageUri);
    await this._view.webview.postMessage({ type: MSG_TYPES.profile, snapshot });
  }

  private async postRawSnapshot(): Promise<void> {
    if (!this._view) return;
    const snapshot = await loadProfileSnapshot(this.context.globalStorageUri);
    await this._view.webview.postMessage({
      type: MSG_TYPES.profileRaw,
      raw: snapshot.exists ? snapshot.raw : "",
      updatedAt: snapshot.updatedAt,
    });
  }

  private async updateAndPost(): Promise<void> {
    if (!this._view) return;
    const router = this.routerFactory();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Updating learner profile…",
          cancellable: true,
        },
        async (progress, token) =>
          runProfileUpdate(
            this.context.globalStorageUri,
            this.context.secrets,
            router,
            (event) => {
              if (event.stage) {
                progress.report({ message: `Stage: ${event.stage}` });
              }
            },
            token,
            (msg) => this.outputChannel.appendLine(msg)
          )
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[pylearner] update failed: ${msg}`);
      await this._view.webview.postMessage({ type: MSG_TYPES.error, message: msg });
      return;
    }
    await this.postSnapshot();
  }

  /** Drop the synthesized profile and re-synthesize it from all L2 memory. */
  private async resetAndPost(): Promise<void> {
    if (!this._view) return;
    const router = this.routerFactory();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Resetting and regenerating learner profile…",
          cancellable: true,
        },
        async (progress, token) => {
          await resetProfile(this.context.globalStorageUri);
          await runProfileUpdate(
            this.context.globalStorageUri,
            this.context.secrets,
            router,
            (event) => {
              if (event.stage) {
                progress.report({ message: `Stage: ${event.stage}` });
              }
            },
            token,
            (msg) => this.outputChannel.appendLine(msg)
          );
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[pylearner] reset failed: ${msg}`);
      await this._view.webview.postMessage({ type: MSG_TYPES.error, message: msg });
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
  if (!doc) return { exists: false, markdown: "", raw: "", updatedAt: null };
  const meta = await loadL3Meta(storageUri, "profile");
  // Teacher/student view: the LLM overview when present, else the display
  // view. The raw audit view (ids + footnotes) is unchanged.
  const overview = await loadOverview(storageUri, "profile");
  return {
    exists: true,
    markdown: pickProfileView(overview, doc) ?? "",
    raw: renderRaw(doc),             // audit view: Chinese labels + ids + footnotes
    updatedAt: meta.last_update_at,
  };
}
