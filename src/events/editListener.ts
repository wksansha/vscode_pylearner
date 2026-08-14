import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";

export function createEditListener(writer: L1Writer): vscode.Disposable {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let batchedChanges: Array<{
    uri: vscode.Uri;
    before: string;
    after: string;
  }> = [];

  const flush = () => {
    if (batchedChanges.length === 0) return;
    const changes = batchedChanges.splice(0);
    for (const ch of changes) {
      const beforeLines = ch.before.split("\n");
      const afterLines = ch.after.split("\n");
      const linesChanged = Math.abs(afterLines.length - beforeLines.length) || 1;

      // Skip trivial changes (pure whitespace, single char)
      const beforeTrimmed = ch.before.trim();
      const afterTrimmed = ch.after.trim();
      if (beforeTrimmed === afterTrimmed) continue;

      const workspaceRoot = vscode.workspace.getWorkspaceFolder(ch.uri);
      const relativePath = workspaceRoot
        ? vscode.workspace.asRelativePath(ch.uri, false)
        : ch.uri.fsPath;

      writer.append("edit", "code_change", {
        file: relativePath,
        lines_changed: linesChanged,
        before_snippet: beforeTrimmed.slice(0, 200),
        after_snippet: afterTrimmed.slice(0, 200),
      });
    }
  };

  const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
    const enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorEdit, true);
    if (!enabled) return;

    if (e.document.uri.scheme !== "file") return;
    if (!e.document.fileName.endsWith(".py")) return;
    if (e.contentChanges.length === 0) return;

    for (const change of e.contentChanges) {
      batchedChanges.push({
        uri: e.document.uri,
        before: change.rangeLength > 0 ? e.document.getText(change.range) : "",
        after: change.text,
      });
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 500);
  });

  const saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    const enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorEdit, true);
    if (!enabled) return;
    if (!doc.fileName.endsWith(".py")) return;

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri);
    const file = workspaceRoot
      ? vscode.workspace.asRelativePath(doc.uri, false)
      : doc.uri.fsPath;

    writer.append("edit", EVENT_KINDS.fileSave, { file });
  });

  return {
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      flush(); // flush any pending changes
      disposable.dispose();
      saveDisposable.dispose();
    },
  };
}
