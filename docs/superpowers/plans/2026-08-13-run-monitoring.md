# 运行监听扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 run 监听从仅 Task API 扩展为覆盖 ▶按钮/手动终端命令、F5 调试会话、断点变化，并新增文件保存与诊断问题事件，全部写入 L1 trace。

**Architecture:** 运行族事件（任务、终端 shell 执行、调试会话、断点）集中在 `runListener.ts`，模块内部用两个 Set 维护去重状态；保存事件并入 `editListener.ts`；诊断事件新建独立模块（1.5s 防抖 + 状态比对）。新 surface `debug` 与全部新 kind 字符串集中在 `constants.ts`。

**Tech Stack:** TypeScript (strict) + VS Code Extension API（全部稳定 API）+ esbuild 打包。无自动化测试框架（spec 非目标）——每任务验证 = `tsc --noEmit` + 手动 F5 矩阵。

## Global Constraints

- **禁用一切提案 API**（教训：`terminalDataWriteEvent` 曾导致激活崩溃）。只用稳定 API。
- Surface 集合：`edit` / `run` / `chat` / `debug`（spec 表）。
- 事件 kind 命名与 payload 字段严格按 spec 表格；kind 字符串只从 `EVENT_KINDS` 常量引用。
- 开关门控：`pylearner.monitor.runEnabled` 控制任务/终端/调试/断点事件；`pylearner.monitor.editEnabled` 控制编辑/保存/诊断事件。
- 去重规则：`activeTasks` 或 `activeDebugSessions` 非空时跳过终端 shell 执行事件。
- 诊断事件：仅 .py 文件、1.5s 防抖、仅在与上次记录状态不同时写入（含清零）。
- 代码风格沿用现状：`writer.append` fire-and-forget、既有 kind 字符串不迁移、防抖用 `setTimeout`。
- 每任务结束必须通过：`npx tsc --noEmit`（无输出）+ `npm run compile`（"Build complete."）+ 该任务的手动 F5 验证，然后 commit。
- trace 文件位置：`%APPDATA%\Code\User\globalStorage\deeptutor.vscode-pylearner\trace\<surface>\YYYY-MM-DD.jsonl`

---

### Task 1: constants.ts — 新 surface 与新 kind 常量

**Files:**
- Modify: `src/constants.ts`（SURFACES 定义处，第 36-37 行附近；MSG_TYPES 之后）

**Interfaces:**

- Produces: `SURFACES` 含 `"debug"`；`EVENT_KINDS` 常量对象（Task 2-6 全部引用）

- [ ] **Step 1: 修改 `src/constants.ts`**

把 SURFACES 两行改为：

```ts
export const SURFACES = ["edit", "run", "chat", "debug"] as const;
export type Surface = (typeof SURFACES)[number];
```

在 `MSG_TYPES` 定义块之后新增：

```ts
export const EVENT_KINDS = {
  runSuccess: "execution_success",
  runError: "execution_error",
  debugSessionStart: "session_start",
  debugSessionEnd: "session_end",
  breakpointChange: "breakpoint_change",
  fileSave: "file_save",
  diagnosticsChange: "diagnostics_change",
} as const;
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat: add debug surface and event kind constants"
```

---

### Task 2: runListener.ts — 任务 Set 化 + 终端 shell 执行监听（▶/手敲）

**Files:**
- Modify: `src/events/runListener.ts`（整文件重写为下方最终形态，本任务先写入「任务」+「终端」两个块；调试/断点块在 Task 3/4 追加）

**Interfaces:**

- Consumes: `EVENT_KINDS`（Task 1）、`CONFIG_KEYS.monitorRun`（既有）、`L1Writer.append(surface, kind, payload)`
- Produces: 模块内私有 `activeTasks`、`activeDebugSessions`、`isRunEnabled`（Task 3/4 复用）

- [ ] **Step 1: 用以下完整代码重写 `src/events/runListener.ts`**

```ts
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
      const exitCode = e.execution.exitCode;
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
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 3: 手动验证（F5 矩阵）**

1. F5 启动开发宿主，打开任意工作区
2. ▶ 按钮运行一个 .py（成功场景）；再在终端手敲 `python -c "import sys; sys.exit(3)"`（失败场景）

Run（Git Bash）:

```bash
tail -n 4 "$APPDATA/Code/User/globalStorage/deeptutor.vscode-pylearner/trace/run/$(date +%F).jsonl"
```

Expected: 新增 `execution_success`（source:"terminal"，exit_code 0，command 含 python/.py）和 `execution_error`（exit_code 3）各一行；既有的 `execution_success` 任务事件行带 `"source":"task"`。

- [ ] **Step 4: Commit**

```bash
git add src/events/runListener.ts
git commit -m "feat: record terminal python runs via shell execution events"
```

---

### Task 3: runListener.ts — F5 调试会话监听

**Files:**
- Modify: `src/events/runListener.ts`（在「终端」块之后、`return` 之前插入调试块）

**Interfaces:**

- Consumes: `activeDebugSessions`、`isRunEnabled`、`EVENT_KINDS.debugSessionStart/End`（Task 2/1）
- Produces: 无新导出

- [ ] **Step 1: 插入以下代码（`return vscode.Disposable.from(...)` 之前）**

```ts
  // --- Debug sessions (F5) ---
  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!isRunEnabled()) return;
      const type = session.configuration?.type?.toLowerCase() ?? "";
      if (!type.includes("python") && !type.includes("debugpy")) return;
      activeDebugSessions.add(session);
      writer.append("debug", EVENT_KINDS.debugSessionStart, {
        name: session.configuration?.name,
        type: session.configuration?.type,
        program: session.configuration?.program,
      });
    })
  );

  disposables.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (!isRunEnabled()) return;
      if (!activeDebugSessions.delete(session)) return;
      writer.append("debug", EVENT_KINDS.debugSessionEnd, {
        name: session.configuration?.name,
        type: session.configuration?.type,
      });
    })
  );
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 3: 手动验证（F5 矩阵）**

1. F5 启动开发宿主，打开含 .py 的工作区
2. 在 .py 上按 F5（选 Python Debugger 配置），跑几秒后点停止按钮

Run:

```bash
cat "$APPDATA/Code/User/globalStorage/deeptutor.vscode-pylearner/trace/debug/$(date +%F).jsonl"
```

Expected: `session_start`（含 name/type/program）+ `session_end` 各一行。同时确认 `trace/run/` 里没有因调试终端启动命令产生的重复 `execution_*`（去重生效）。

- [ ] **Step 4: Commit**

```bash
git add src/events/runListener.ts
git commit -m "feat: record python debug sessions"
```

---

### Task 4: runListener.ts — 断点变化监听

**Files:**
- Modify: `src/events/runListener.ts`（调试块之后插入断点块）

**Interfaces:**

- Consumes: `isRunEnabled`、`EVENT_KINDS.breakpointChange`（Task 2/1）

- [ ] **Step 1: 插入以下代码（调试块之后、`return` 之前）**

```ts
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
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 3: 手动验证（F5 矩阵）**

1. F5 启动开发宿主，打开 .py 文件
2. 断点区点一下加断点 → 再点掉 → 再加一个断点并右键编辑条件

Run:

```bash
tail -n 3 "$APPDATA/Code/User/globalStorage/deeptutor.vscode-pylearner/trace/debug/$(date +%F).jsonl"
```

Expected: `breakpoint_change` 行，added/removed/changed 计数正确，locations 含 `file:line`；非 .py 文件的断点不产生事件。

- [ ] **Step 4: Commit**

```bash
git add src/events/runListener.ts
git commit -m "feat: record python breakpoint changes"
```

---

### Task 5: editListener.ts — 文件保存监听

**Files:**
- Modify: `src/events/editListener.ts`

**Interfaces:**

- Consumes: `EVENT_KINDS.fileSave`（Task 1）、`CONFIG_KEYS.monitorEdit`（既有）

- [ ] **Step 1: 修改 import（第 3 行）**

```ts
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";
```

- [ ] **Step 2: 在 `const disposable = vscode.workspace.onDidChangeTextDocument(...)` 之后、`return` 之前插入保存监听**

```ts
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
```

- [ ] **Step 3: 更新返回的 dispose 块，完整内容如下**

```ts
  return {
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      flush(); // flush any pending changes
      disposable.dispose();
      saveDisposable.dispose();
    },
  };
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 5: 手动验证（F5 矩阵）**

1. F5 启动开发宿主，打开 .py 文件
2. Ctrl+S 保存一次；保存一个非 .py 文件（如 .txt）对照

Run:

```bash
tail -n 3 "$APPDATA/Code/User/globalStorage/deeptutor.vscode-pylearner/trace/edit/$(date +%F).jsonl"
```

Expected: `file_save` 行含 file 相对路径；非 .py 保存不产生事件。

- [ ] **Step 6: Commit**

```bash
git add src/events/editListener.ts
git commit -m "feat: record python file saves"
```

---

### Task 6: diagnosticsListener.ts — 诊断问题监听 + 注册

**Files:**
- Create: `src/events/diagnosticsListener.ts`
- Modify: `src/extension.ts`（import 与注册）

**Interfaces:**

- Consumes: `EVENT_KINDS.diagnosticsChange`（Task 1）、`CONFIG_KEYS.monitorEdit`、`L1Writer`
- Produces: `createDiagnosticsListener(writer: L1Writer): vscode.Disposable`

- [ ] **Step 1: 创建 `src/events/diagnosticsListener.ts`，完整内容如下**

```ts
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
```

- [ ] **Step 2: 修改 `src/extension.ts` 注册**

在 import 区加：

```ts
import { createDiagnosticsListener } from "./events/diagnosticsListener";
```

在 `context.subscriptions.push(createRunListener(l1Writer));` 之后加：

```ts
  context.subscriptions.push(createDiagnosticsListener(l1Writer));
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run compile`
Expected: 无输出（tsc）+ `Build complete.`

- [ ] **Step 4: 手动验证（F5 矩阵）**

1. F5 启动开发宿主，打开 .py 文件
2. 输入 `x = (`（制造语法错误）→ 等 2 秒 → 修复 → 再等 2 秒

Run:

```bash
tail -n 4 "$APPDATA/Code/User/globalStorage/deeptutor.vscode-pylearner/trace/edit/$(date +%F).jsonl"
```

Expected: `diagnostics_change` 行 errors ≥ 1（samples 含错误消息）；修复后出现 errors:0 的 `diagnostics_change`；持续打字不刷屏（每文件最多 1.5s 一次，且计数不变时不写）。

- [ ] **Step 5: Commit**

```bash
git add src/events/diagnosticsListener.ts src/extension.ts
git commit -m "feat: record python diagnostics changes with debounce"
```

---

## Final Verification（全部任务完成后）

Run 全矩阵一遍（spec 验证计划表）：

| # | 触发动作 | 预期 |
| --- | --- | --- |
| 1 | ▶ 按钮运行 .py（成功+失败各一次）、终端手敲 `python -c "import sys; sys.exit(3)"` | `trace/run/` `execution_success`+`execution_error`（source:terminal） |
| 2 | F5 调试 .py 后停止 | `trace/debug/` `session_start`+`session_end` |
| 3 | 加/删/改 .py 断点 | `trace/debug/` `breakpoint_change` |
| 4 | Ctrl+S 保存 .py | `trace/edit/` `file_save` |
| 5 | 引入语法错误 → 等 2s → 修复 | `trace/edit/` `diagnostics_change`（含清零） |
| 去重 | F5 调试时观察 `trace/run/` | 无调试终端命令的重复 execution_* 事件 |
| 回归 | 既有：编辑 .py、聊天、Run Task | 既有事件正常（任务事件带 source:"task"） |

全部通过后：`git status` 干净，`git log` 含 6 个 feat commit。
