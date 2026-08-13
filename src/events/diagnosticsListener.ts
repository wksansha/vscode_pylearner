import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";

export function createDiagnosticsListener(writer: L1Writer): vscode.Disposable {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastState = new Map<string, { errors: number; warnings: number }>();

  const flush = (uri: vscode.Uri) => {
    const key = uri.toString();
    timers.delete(key);

    const enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorEdit, true);
    if (!enabled) return;
    if (uri.scheme !== "file" || !uri.fsPath.endsWith(".py")) return;

    const diagnostics = vscode.languages.getDiagnostics(uri);
    let errors = 0;
    let warnings = 0;
    for (const d of diagnostics) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }

    const prev = lastState.get(key);
    if (prev && prev.errors === errors && prev.warnings === warnings) return;
    if (!prev && errors === 0 && warnings === 0) return; // nothing before, nothing now

    if (errors === 0 && warnings === 0) lastState.delete(key);
    else lastState.set(key, { errors, warnings });

    const samples = diagnostics
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 5)
      .map((d) => d.message.slice(0, 200));

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri);
    const file = workspaceRoot
      ? vscode.workspace.asRelativePath(uri, false)
      : uri.fsPath;

    writer.append("edit", EVENT_KINDS.diagnosticsChange, {
      file,
      errors,
      warnings,
      samples: samples.length > 0 ? samples : undefined,
    });
  };

  const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
    for (const uri of e.uris) {
      if (uri.scheme !== "file" || !uri.fsPath.endsWith(".py")) continue;
      const key = uri.toString();
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(key, setTimeout(() => flush(uri), 1500));
    }
  });

  return {
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      disposable.dispose();
    },
  };
}
