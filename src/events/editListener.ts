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

  // Text mirror: last known full content per document. onDidChangeTextDocument
  // fires AFTER the document has changed, so `document.getText(change.range)`
  // would return the NEW text — the mirror is the only way to recover what a
  // change replaced. Seeded on open, updated after every change, re-synced on
  // save (formatters/git can drift it), dropped on close.
  const mirrors = new Map<string, string>();

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

    // All changes in one event reference the same pre-event document state.
    const key = e.document.uri.toString();
    const oldText = mirrors.get(key) ?? "";
    for (const change of e.contentChanges) {
      const offset = e.document.offsetAt(change.range.start);
      batchedChanges.push({
        uri: e.document.uri,
        before: oldText.slice(offset, offset + change.rangeLength),
        after: change.text,
      });
    }
    mirrors.set(key, e.document.getText());

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 500);
  });

  const openDisposable = vscode.workspace.onDidOpenTextDocument((doc) => {
    // Seed the mirror so the first change's `before` is correct. Files that
    // were open before activation have no mirror entry and degrade to an
    // empty `before` snippet until the next save re-syncs them.
    if (doc.uri.scheme === "file" && doc.fileName.endsWith(".py")) {
      mirrors.set(doc.uri.toString(), doc.getText());
    }
  });

  const saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    const enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorEdit, true);
    if (!enabled) return;
    if (!doc.fileName.endsWith(".py")) return;

    // Re-sync the mirror: external writes (formatter, git checkout) bypass
    // change events and would otherwise drift the mirror.
    mirrors.set(doc.uri.toString(), doc.getText());

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri);
    const file = workspaceRoot
      ? vscode.workspace.asRelativePath(doc.uri, false)
      : doc.uri.fsPath;

    writer.append("edit", EVENT_KINDS.fileSave, { file });
  });

  const closeDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
    mirrors.delete(doc.uri.toString());
  });

  return {
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      flush(); // flush any pending changes
      disposable.dispose();
      openDisposable.dispose();
      saveDisposable.dispose();
      closeDisposable.dispose();
      mirrors.clear();
    },
  };
}
