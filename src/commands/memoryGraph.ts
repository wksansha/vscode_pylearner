// "Memory Graph" command — opens a webview panel that renders the three-layer
// citation chain (L3 → L2 → L1) so every profile claim can be traced down to
// its source events.
//
// The host owns the data: on open (and on refresh) it hydrates the L3/L2 docs
// and L1 entities from disk, builds the pure citation graph, and posts it to
// the webview, which renders it client-side.

import * as vscode from "vscode";
import { CMD_IDS, MSG_TYPES, SURFACES } from "../constants";
import { buildCitationGraph } from "../memory/graph";
import type { CitationGraph } from "../memory/graph";
import type { Document } from "../memory/document";
import { loadL2Doc, loadL3Doc } from "../memory/store";
import { L3_SLOTS } from "../memory/paths";
import { readTraceEntities } from "../snapshot/reader";
import type { Entity } from "../snapshot/entity";

export function registerMemoryGraphCommand(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand(CMD_IDS.memoryGraph, async () => {
    const panel = vscode.window.createWebviewPanel(
      "pylearner.memoryGraph",
      "Python Learner: Memory Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
        ],
      }
    );

    panel.webview.html = getHtml(context, panel.webview);

    panel.webview.onDidReceiveMessage(async (payload: Record<string, unknown>) => {
      if (payload.type === MSG_TYPES.getMemoryGraph) {
        await postGraph(panel.webview, context.globalStorageUri);
      }
    });

    await postGraph(panel.webview, context.globalStorageUri);
  });
}

async function postGraph(
  webview: vscode.Webview,
  storageUri: vscode.Uri
): Promise<void> {
  try {
    const graph = await loadGraph(storageUri);
    await webview.postMessage({ type: MSG_TYPES.memoryGraphData, graph });
  } catch (err) {
    await webview.postMessage({
      type: MSG_TYPES.error,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadGraph(storageUri: vscode.Uri): Promise<CitationGraph> {
  const l3Docs: Record<string, Document> = {};
  for (const slot of L3_SLOTS) {
    const doc = await loadL3Doc(storageUri, slot);
    if (doc) l3Docs[slot] = doc;
  }

  const l2Docs: Record<string, Document> = {};
  const entities: Record<string, Entity[]> = {};
  for (const surface of SURFACES) {
    const doc = await loadL2Doc(storageUri, surface);
    if (doc) l2Docs[surface] = doc;
    entities[surface] = await readTraceEntities(storageUri, surface);
  }

  return buildCitationGraph({ l3Docs, l2Docs, entities });
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const distUri = vscode.Uri.joinPath(
    context.extensionUri,
    "webview-ui",
    "dist"
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "assets", "memoryGraph.js")
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
  <title>Python Learner Memory Graph</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
