import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";

export function createRunListener(writer: L1Writer): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  // Dedupe state: terminal shell executions fire for ▶ runs, Run Task, and
  // debug-launched terminals. While a tracked task or debug session is
  // active, the task/debug listeners own the recording — skip terminal events.
  const activeTasks = new Set<vscode.TaskExecution>();
  const activeDebugSessions = new Set<vscode.DebugSession>();

  const isRunEnabled = () =>
    vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorRun, true);

  // --- Task runs ---
  disposables.push(
    vscode.tasks.onDidStartTask((e) => {
      if (!isRunEnabled()) return;
      const name = e.execution.task.name.toLowerCase();
      const source = e.execution.task.source.toLowerCase();
      if (
        !name.includes("python") &&
        !source.includes("python") &&
        !name.includes(".py")
      ) {
        return;
      }
      activeTasks.add(e.execution);
    })
  );

  disposables.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (!isRunEnabled()) return;
      if (!activeTasks.delete(e.execution)) return;
      const kind =
        e.exitCode === 0 ? EVENT_KINDS.runSuccess : EVENT_KINDS.runError;
      const errorMessage =
        e.exitCode !== 0
          ? `Task "${e.execution.task.name}" failed with exit code ${e.exitCode}`
          : undefined;
      writer.append("run", kind, {
        source: "task",
        task: e.execution.task.name,
        exit_code: e.exitCode,
        error_message: errorMessage?.slice(0, 2000),
      });
    })
  );

  // --- Terminal runs (▶ button, manual commands) ---
  disposables.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      if (!isRunEnabled()) return;
      if (activeTasks.size > 0 || activeDebugSessions.size > 0) return;
      const cmd = e.execution.commandLine.value.toLowerCase();
      if (!cmd.includes("python") && !cmd.includes(".py")) return;
      (e.execution as any)._pylearner_tracked = true;
    })
  );

  disposables.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      if (!isRunEnabled()) return;
      if (!(e.execution as any)._pylearner_tracked) return;
      delete (e.execution as any)._pylearner_tracked;
      const exitCode = e.exitCode;
      if (exitCode === undefined) {
        // Shell integration disabled — no reliable exit code, skip silently
        console.warn(
          "Python Learner: terminal shell execution without exit code (shell integration off?)"
        );
        return;
      }
      const kind =
        exitCode === 0 ? EVENT_KINDS.runSuccess : EVENT_KINDS.runError;
      writer.append("run", kind, {
        source: "terminal",
        command: e.execution.commandLine.value.slice(0, 500),
        exit_code: exitCode,
      });
    })
  );

  return vscode.Disposable.from(...disposables);
}
