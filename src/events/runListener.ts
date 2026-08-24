import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";

// ── Python error parsing ──────────────────────────────────────────────

// Type alias (not interface) so it is assignable to Record<string, unknown>.
type PythonErrorInfo = {
  error_type?: string;
  error_message?: string;
  file?: string;
  line?: number;
};

// Terminal output often carries ANSI escape sequences (PowerShell prompt,
// shell integration markers); strip them before pattern matching.
const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function parsePythonError(output: string): PythonErrorInfo {
  const lines = stripAnsi(output).split(/\r?\n/);
  const result: PythonErrorInfo = {};
  // Last exception header, e.g. "TypeError: unsupported operand type(s)..."
  // (covers Error/Exception suffixes plus SystemExit/KeyboardInterrupt).
  const excRe =
    /^([A-Za-z_]\w*(?:\.\w+)*(?:Error|Exception|Interrupt|Exit)):\s*(.*)$/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(excRe);
    if (m) {
      result.error_type = m[1];
      result.error_message = m[2].slice(0, 500);
      break;
    }
  }
  // Last '  File "...", line N' — nearest to the exception header.
  const fileRe = /^  File "([^"]+)", line (\d+)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(fileRe);
    if (m) {
      result.file = m[1];
      result.line = parseInt(m[2], 10);
      break;
    }
  }
  return result;
}

// ── Listener ──────────────────────────────────────────────────────────

export function createRunListener(writer: L1Writer): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  // Dedupe state: one ▶ run fires BOTH a task event and a terminal shell
  // execution. The terminal path is primary — shell integration lets it read
  // the output (error_type/file/line); the task path is the fallback for
  // environments without shell integration. A terminal execution is "owned"
  // by the most recently started Python task (Map = insertion order).
  const activeTasks = new Map<vscode.TaskExecution, true>();
  const capturedTasks = new Set<vscode.TaskExecution>();
  const trackedTerminals = new Map<
    vscode.TerminalShellExecution,
    {
      task: vscode.TaskExecution | null;
      output: string;
      reading: Promise<void>;
      ended: boolean;
      chunks: number;
    }
  >();

  const isRunEnabled = () =>
    vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG_KEYS.monitorRun, true);

  // NOTE: no raw terminal-data fallback here. window.onDidWriteTerminalData
  // exists only as a PROPOSED API (terminalDataWriteEvent) and using it
  // without the proposal declared aborts activation. The read() stream is
  // the single capture path; output_chars diagnostics tell us if it fails.

  const mostRecentTask = (): vscode.TaskExecution | null => {
    let last: vscode.TaskExecution | null = null;
    for (const key of activeTasks.keys()) last = key;
    return last;
  };

  const isPythonTask = (task: vscode.Task): boolean => {
    const name = task.name.toLowerCase();
    const source = task.source.toLowerCase();
    return (
      name.includes("python") ||
      source.includes("python") ||
      name.includes(".py")
    );
  };

  // Skip non-Python commands and debug launchers (the debug listener owns
  // debugpy-launched runs).
  const isPythonCommand = (cmd: string): boolean => {
    const c = cmd.toLowerCase();
    return (
      (c.includes("python") || c.includes(".py")) && !c.includes("debugpy")
    );
  };

  // --- Task runs (fallback: no shell integration available) ---
  disposables.push(
    vscode.tasks.onDidStartTask((e) => {
      if (!isRunEnabled()) return;
      if (!isPythonTask(e.execution.task)) return;
      activeTasks.set(e.execution, true);
      // ms-python's ▶ run can fire the terminal shell execution BEFORE the
      // task-start event. Adopt any still-unowned terminal executions so the
      // dedupe pairing works regardless of event order.
      for (const tag of trackedTerminals.values()) {
        if (tag.task === null) tag.task = e.execution;
      }
    })
  );

  disposables.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (!activeTasks.delete(e.execution)) return;
      if (!isRunEnabled()) return;
      // Already recorded by a terminal execution, or a tracked terminal is
      // still about to finish — the terminal handler owns the record then.
      if (capturedTasks.has(e.execution)) {
        capturedTasks.delete(e.execution);
        return;
      }
      const pending = [...trackedTerminals.values()].some(
        (t) => t.task === e.execution
      );
      if (pending) return;
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

  // --- Terminal runs (primary: reads output via shell integration) ---
  disposables.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      if (!isRunEnabled()) return;
      if (!isPythonCommand(e.execution.commandLine.value)) return;
      // read() is a LIVE stream — chunks must be consumed while the command
      // runs. Start consuming now and keep a bounded tail buffer; the end
      // handler waits for `reading` and parses `output`.
      const state = {
        task: mostRecentTask(),
        output: "",
        reading: Promise.resolve(),
        ended: false,
        chunks: 0,
      };
      state.reading = (async () => {
        try {
          for await (const chunk of e.execution.read()) {
            state.output += chunk;
            if (state.output.length > 4000) {
              state.output = state.output.slice(-4000);
            }
            // The end handler flags `ended` — stop consuming promptly.
            if (state.ended) break;
            // Defensive bounds so a pathological stream (never closes,
            // emits forever) can't starve the extension host:
            // 1) yield to the event loop periodically,
            // 2) hard-cap the chunk count.
            if (++state.chunks % 64 === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            if (state.chunks > 100000) break;
          }
        } catch {
          // stream unavailable (shell integration edge) — output stays empty
        }
      })();
      trackedTerminals.set(e.execution, state);
    })
  );

  disposables.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      if (!isRunEnabled()) return;
      const tag = trackedTerminals.get(e.execution);
      if (!tag) return;
      trackedTerminals.delete(e.execution);
      // Stop the stream consumer promptly.
      tag.ended = true;
      // Only suppress the task event while the task is still pending; a task
      // that already ended doesn't need the marker (avoids set growth).
      const markCaptured = () => {
        if (tag.task && activeTasks.has(tag.task)) capturedTasks.add(tag.task);
      };

      const exitCode = e.exitCode;
      if (exitCode === undefined) {
        // Shell integration disabled. A task-owned run falls back to a
        // task-style event (we can't read output or even tell success).
        if (tag.task) {
          markCaptured();
          writer.append("run", EVENT_KINDS.runError, {
            source: "task",
            task: tag.task.task.name,
            error_message:
              "exit code unavailable (shell integration disabled)",
          });
        } else {
          console.warn(
            "Python Learner: terminal shell execution without exit code (shell integration off?)"
          );
        }
        return;
      }
      markCaptured();

      void (async () => {
        let errorFields: Record<string, unknown> = {};
        if (exitCode !== 0) {
          // Wait briefly for the live-stream consumer started at execution
          // start (bounded so a stuck stream can't hold the record forever).
          await Promise.race([
            tag.reading,
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
          ]);
          const tail =
            tag.output.length > 2000
              ? tag.output.slice(-2000)
              : tag.output;
          if (tail.trim()) {
            errorFields = parsePythonError(tail);
            if (!errorFields.error_type) {
              // Diagnostic (privacy-safe, no content): output was captured
              // but no exception signature matched it.
              errorFields.output_chars = tail.length;
            }
          } else {
            // Diagnostic: the read() stream yielded no output for this run.
            errorFields.output_chars = 0;
          }
        }
        await writer.append(
          "run",
          exitCode === 0 ? EVENT_KINDS.runSuccess : EVENT_KINDS.runError,
          {
            source: "terminal",
            command: e.execution.commandLine.value.slice(0, 500),
            exit_code: exitCode,
            ...errorFields,
          }
        );
      })();
    })
  );

  // --- Debug sessions (F5) ---
  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!isRunEnabled()) return;
      const type = session.configuration?.type?.toLowerCase() ?? "";
      if (!type.includes("python") && !type.includes("debugpy")) return;
      writer.append(
        "debug",
        EVENT_KINDS.debugSessionStart,
        {
          name: session.configuration?.name,
          type: session.configuration?.type,
          program: session.configuration?.program,
        },
        session.id
      );
    })
  );

  disposables.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (!isRunEnabled()) return;
      writer.append(
        "debug",
        EVENT_KINDS.debugSessionEnd,
        {
          name: session.configuration?.name,
          type: session.configuration?.type,
        },
        session.id
      );
    })
  );

  // --- Breakpoint changes ---
  const pyLocation = (bp: vscode.Breakpoint): string => {
    if (!(bp instanceof vscode.SourceBreakpoint)) return "";
    const uri = bp.location.uri;
    if (uri.scheme !== "file" || !uri.fsPath.endsWith(".py")) return "";
    return `${uri.fsPath}:${bp.location.range.start.line + 1}`;
  };

  disposables.push(
    vscode.debug.onDidChangeBreakpoints((e) => {
      if (!isRunEnabled()) return;
      const added = e.added.map(pyLocation).filter(Boolean);
      const removed = e.removed.map(pyLocation).filter(Boolean);
      const changed = e.changed.map(pyLocation).filter(Boolean);
      if (added.length + removed.length + changed.length === 0) return;
      writer.append("debug", EVENT_KINDS.breakpointChange, {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        locations: [...added, ...removed, ...changed].slice(0, 10),
      });
    })
  );

  return vscode.Disposable.from(...disposables);
}
