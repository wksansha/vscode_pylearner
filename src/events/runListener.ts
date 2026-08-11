import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS } from "../constants";

export function createRunListener(writer: L1Writer): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  // Listen to task start
  disposables.push(
    vscode.tasks.onDidStartTask((e) => {
      const enabled = vscode.workspace
        .getConfiguration()
        .get<boolean>(CONFIG_KEYS.monitorRun, true);
      if (!enabled) return;

      const name = e.execution.task.name.toLowerCase();
      const source = e.execution.task.source.toLowerCase();
      if (
        !name.includes("python") &&
        !source.includes("python") &&
        !name.includes(".py")
      ) {
        return;
      }
      // Tag the task execution for tracking
      (e.execution as any)._pylearner_tracked = true;
    })
  );

  // Listen to task end — read terminal output
  disposables.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const enabled = vscode.workspace
        .getConfiguration()
        .get<boolean>(CONFIG_KEYS.monitorRun, true);
      if (!enabled) return;

      if (!(e.execution as any)._pylearner_tracked) return;

      const kind = e.exitCode === 0 ? "execution_success" : "execution_error";

      // Extract error info from terminal output
      let errorType = "";
      let errorMessage = "";
      let file = "";
      let line = 0;

      if (e.exitCode !== 0) {
        // Read recent terminal output if accessible
        const terminals = vscode.window.terminals;
        for (const t of terminals) {
          // Try to match the task's terminal — best-effort
          const ts = t.creationOptions as any;
          const exec = e.execution.task.execution as any;
          if (
            ts?.name &&
            exec?.args &&
            ts.name.includes(exec.args.join(" "))
          ) {
            // extract info from last line of terminal if available
            break;
          }
        }
        // Parse Python traceback pattern from the task name/source
        errorMessage = `Task "${e.execution.task.name}" failed with exit code ${e.exitCode}`;
      }

      writer.append("run", kind, {
        task: e.execution.task.name,
        exit_code: e.exitCode,
        error_type: errorType || undefined,
        error_message: errorMessage.slice(0, 2000) || undefined,
        file: file || undefined,
        line: line || undefined,
      });
    })
  );

  // Also listen to terminal output for Python execution patterns
  disposables.push(
    vscode.window.onDidWriteTerminalData((e) => {
      // Best-effort tracking: look for `python *.py` in written data
      const enabled = vscode.workspace
        .getConfiguration()
        .get<boolean>(CONFIG_KEYS.monitorRun, true);
      if (!enabled) return;

      // We don't parse individual terminal lines here — task-based listening
      // is the primary mechanism. This is a hook for future enhancement.
    })
  );

  return vscode.Disposable.from(...disposables);
}
