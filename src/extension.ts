// ===== 启动日志 - 写入固定目录，确保在崩溃时也能保存 =====
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function setupStartupLogger() {
  try {
    const logDir = process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, "extension-startup.log");
    const now = new Date().toISOString();

    fs.appendFileSync(logFile, `\n=== Extension Startup ===\n`);
    fs.appendFileSync(logFile, `[${now}] Process started (PID: ${process.pid})\n`);
    fs.appendFileSync(logFile, `[${now}] Node: ${process.version}, Platform: ${process.platform}\n`);
    fs.appendFileSync(logFile, `[${now}] Working directory: ${process.cwd()}\n`);
    fs.appendFileSync(logFile, `[${now}] Module loading...\n`);
  } catch (e) {
    // 最早阶段若写失败，只能后悔了
  }
}

// 模块级执行日志
setupStartupLogger();

import * as vscode from "vscode";
import { CMD_IDS, CONFIG_KEYS, SECRET_KEYS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { ChatStore } from "./storage/chatStore";
import { LlmRouter } from "./llm/router";
import { ChatViewProvider } from "./chat/chatProvider";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { createDiagnosticsListener } from "./events/diagnosticsListener";
import { createBehaviorListener } from "./events/behaviorListener";
import { registerUpdateProfileCommand, registerResetProfileCommand } from "./commands/updateProfile";
import { ProfileRefresher } from "./commands/autoRefresh";
import { registerMemoryGraphCommand } from "./commands/memoryGraph";
import { createTeacherReporter } from "./teacher/reporter";
import { loadStudentIdentity, migrateLegacyIdentity } from "./identity/studentIdentity";
import { openIdentityPage, maybeOpenIdentityPage } from "./identity/identityPage";
import {
  makeHandleRunSuccess,
  type SubmissionDeps,
} from "./submission/submissionReporter";
import { makeSubmitCommand } from "./submission/submitCommand";
import { makeRunPull } from "./pull/pullCommand";

// Global error handlers to prevent uncaught exceptions from crashing the extension host
process.on("uncaughtException", (err) => {
  const now = new Date().toISOString();
  const logFile = path.join(
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs"),
    "extension-startup.log"
  );
  const stack = err instanceof Error ? err.stack ?? String(err) : String(err);
  fs.appendFileSync(
    logFile,
    `[${now}] UNCAUGHT EXCEPTION: ${stack}\n`
  );
  console.error("[pylearner] UNCAUGHT EXCEPTION:", stack);
});

process.on("unhandledRejection", (reason) => {
  const now = new Date().toISOString();
  const logFile = path.join(
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs"),
    "extension-startup.log"
  );
  const detail =
    reason instanceof Error ? reason.stack ?? String(reason) : String(reason);
  fs.appendFileSync(
    logFile,
    `[${now}] UNHANDLED REJECTION: ${detail}\n`
  );
  console.error("[pylearner] UNHANDLED REJECTION:", detail);
});

let chatProvider: ChatViewProvider;
let outputChannel: vscode.OutputChannel;

function log(message: string, ...args: unknown[]): void {
  console.log(message, ...args);
  if (outputChannel) {
    outputChannel.appendLine(message);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log("Python Learner extension activated");

  try {
    outputChannel = vscode.window.createOutputChannel("Python Learner");
    context.subscriptions.push(outputChannel);
    log("[pylearner] output channel created");
  } catch (err) {
    log("[pylearner] failed to create output channel:", err);
    void vscode.window.showErrorMessage(
      `Python Learner activation failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
    return;
  }

  try {
    await activateCore(context);
    log("[pylearner] activation complete, listeners registered");
  } catch (err) {
    log("[pylearner] activation failed:", err);
    void vscode.window.showErrorMessage(
      `Python Learner activation failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
  }
}

async function activateCore(context: vscode.ExtensionContext): Promise<void> {
  // Initialize core services - DEFER router creation until first use
  const l1Writer = new L1Writer(context.globalStorageUri);
  const chatStore = new ChatStore(context.globalStorageUri);
  log("[pylearner] core services initialized");

  // 共享身份读取（A8）：无 machineId/"Unknown" 回退，未设身份时为 null，由消费方（reporter/提交链）门控
  // 身份在每次调用时读取（学号/姓名修改后下一次上报/提交立即生效）
  const getIdentity = () => {
    const id = loadStudentIdentity(context.globalState);
    return { studentId: id.studentId, studentName: id.studentName }; // 可能为 null
  };

  // 初始化教师端上报器（如果启用）
  let currentReporter: ReturnType<typeof createTeacherReporter> | undefined;
  async function applyTeacherReporter() {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    const enabled = cfg.get<boolean>(CONFIG_KEYS.teacherEnabled, false);
    if (enabled) {
      const teacherUrl =
        cfg.get<string>(CONFIG_KEYS.teacherUrl, "http://localhost:3000") ||
        "http://localhost:3000";
      currentReporter = createTeacherReporter({ teacherUrl, getIdentity });
      l1Writer.setTeacherReporter(currentReporter);
      log("[pylearner] teacher reporter enabled");
    } else {
      currentReporter = undefined;
      l1Writer.setTeacherReporter(undefined);
      log("[pylearner] teacher reporter disabled");
    }
  }
  applyTeacherReporter();

  // 监听教师端配置变化，动态开关上报
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("pylearner.teacher.enabled") ||
        e.affectsConfiguration("pylearner.teacher.url")
      ) {
        applyTeacherReporter();
      }
    })
  );

  // ── 学生身份：状态栏 + 修改命令 + 首启弹窗 ──────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = "课堂身份";
  statusBar.command = CMD_IDS.setStudentIdentity;
  const updateStatusBar = () => {
    const id = loadStudentIdentity(context.globalState);
    statusBar.text = id.studentId
      ? `$(account) ${id.studentId} ${id.studentName ?? ""}`.trim()
      : "$(account) 设置学号";
    statusBar.tooltip = "课堂助手身份：点击设置学号/姓名";
    statusBar.show();
  };
  updateStatusBar();
  context.subscriptions.push(statusBar);

  // —— 作业系统装配（A1/A3/A8/A25/A26/A27）——
  const identityDeps = {
    teacherUrl: () =>
      vscode.workspace
        .getConfiguration("pylearner")
        .get<string>(CONFIG_KEYS.teacherUrl, "http://localhost:3000"),
    onSaved: () => updateStatusBar(),
  };
  // 身份命令（A25：InputBox 弹窗删除，统一走身份页；状态栏点击即打开该页）
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.setStudentIdentity, () =>
      openIdentityPage(identityDeps, context)
    )
  );
  log("[pylearner] setStudentIdentity command registered");

  const readFile = async (fsPath: string): Promise<string | null> => {
    try {
      return new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))
      );
    } catch {
      return null;
    }
  };
  const saveIfDirty = async (filePath: string) => {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === filePath
    );
    if (doc?.isDirty) await doc.save();
  };
  const submissionDeps: SubmissionDeps = {
    teacherUrl: identityDeps.teacherUrl,
    getIdentity,
    onIdentityMissing: () =>
      maybeOpenIdentityPage(identityDeps, context, loadStudentIdentity(context.globalState)),
    globalState: context.globalState,
    saveIfDirty,
  };
  const handleRunSuccess = makeHandleRunSuccess(submissionDeps, vscode, readFile);
  l1Writer.setSubmissionHandler((ev) => {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    if (!cfg.get<boolean>(CONFIG_KEYS.submissionEnabled, true)) return;
    if (!cfg.get<boolean>(CONFIG_KEYS.submissionAutoSubmit, true)) return;
    void handleRunSuccess(ev);   // 内部整体 try/catch，不会产生未处理拒绝
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_IDS.submitExercise,
      makeSubmitCommand(submissionDeps, readFile)
    )
  );

  // 拉取：命令 + 激活时自动（A26）
  const pullDeps = {
    teacherUrl: identityDeps.teacherUrl,
    globalState: context.globalState,
    // PullDeps 类型要求这两个成员；makeRunPull 内部一律用 vscode.workspace.fs 实现覆盖它们
    fileExists: async () => false,
    writeFile: async () => {},
  };
  const runPull = makeRunPull(
    pullDeps,
    vscode,
    (m, warn) =>
      warn ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.pullAssignments, () => void runPull())
  );

  // Factory function - creates a fresh router with current config on demand
  const routerFactory = () => new LlmRouter();
  const refresher = new ProfileRefresher(
    context.globalStorageUri,
    context.secrets,
    routerFactory
  );
  log("[pylearner] profile refresher created");

  // Register event listeners
  try {
    context.subscriptions.push(createEditListener(l1Writer));
    log("[pylearner] edit listener registered");
  } catch (err) {
    log("[pylearner] failed to register edit listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createRunListener(l1Writer));
    log("[pylearner] run listener registered");
  } catch (err) {
    log("[pylearner] failed to register run listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createDiagnosticsListener(l1Writer));
    log("[pylearner] diagnostics listener registered");
  } catch (err) {
    log("[pylearner] failed to register diagnostics listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createBehaviorListener(l1Writer));
    log("[pylearner] behavior listener registered");
  } catch (err) {
    log("[pylearner] failed to register behavior listener:", err);
    throw err;
  }

  // Register Chat Webview Provider - pass factory, not instance
  try {
    chatProvider = new ChatViewProvider(context, routerFactory, l1Writer, chatStore, refresher);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS.chatView,
        chatProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    log("[pylearner] chat view provider registered");
  } catch (err) {
    log("[pylearner] failed to register chat view provider:", err);
    throw err;
  }

  // Register commands
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openChat, () => {
        vscode.commands.executeCommand(`${VIEW_IDS.sidebarContainer}.focus`);
      })
    );
    log("[pylearner] openChat command registered");
  } catch (err) {
    log("[pylearner] failed to register openChat command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.newChat, () => {
        chatProvider.postMessage({ type: "newChat" });
      })
    );
    log("[pylearner] newChat command registered");
  } catch (err) {
    log("[pylearner] failed to register newChat command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.toggleMonitor, () => {
        const cfg = vscode.workspace.getConfiguration("pylearner");
        const current = cfg.get<boolean>("monitor.editEnabled") ?? true;
        const next = !current;
        const target = vscode.ConfigurationTarget.Global;
        void cfg.update("monitor.editEnabled", next, target);
        void cfg.update("monitor.runEnabled", next, target);
        vscode.window.showInformationMessage(
          `Python Learner monitoring: ${next ? "ON" : "OFF"}`
        );
      })
    );
    log("[pylearner] toggleMonitor command registered");
  } catch (err) {
    log("[pylearner] failed to register toggleMonitor command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openSettings, () => {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "pylearner"
        );
      })
    );
    log("[pylearner] openSettings command registered");
  } catch (err) {
    log("[pylearner] failed to register openSettings command:", err);
    throw err;
  }

  // Create profile update commands lazily. Instantiating LlmRouter during
  // activation races VS Code's configuration initialization and can crash the
  // extension host when the new window starts.
  try {
    context.subscriptions.push(registerUpdateProfileCommand(context, routerFactory, outputChannel));
    log("[pylearner] update-profile command registered");
  } catch (err) {
    log("[pylearner] failed to register updateProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerResetProfileCommand(context, routerFactory, outputChannel));
    log("[pylearner] reset-profile command registered");
  } catch (err) {
    log("[pylearner] failed to register resetProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerMemoryGraphCommand(context));
    log("[pylearner] memory-graph command registered");
  } catch (err) {
    log("[pylearner] failed to register memoryGraph command:", err);
    throw err;
  }

  // 自动刷新画像功能已停用，待后续评估后再开启
  // 这里保留 refresher 的创建，但不再触发定时刷新
  log("[pylearner] auto profile refresh disabled");

  // 首启迁移旧 SecretStorage 身份；无身份 → 打开身份页；有身份 → 静默复核一次（A25）+ 激活自动拉取（A26，异步不阻塞激活）
  void (async () => {
    try {
      await migrateLegacyIdentity(context.globalState, context.secrets, {
        studentId: SECRET_KEYS.studentId,
        studentName: SECRET_KEYS.studentName,
      });
      const id = loadStudentIdentity(context.globalState);
      if (!id.studentId) {
        openIdentityPage(identityDeps, context);
      } else {
        try {
          const res = await fetch(`${identityDeps.teacherUrl()}/api/identity/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: id.studentId, studentName: id.studentName }),
          });
          if (!res.ok) {
            statusBar.tooltip = "身份校验失败（名册可能已更新），点击重新设置";
            openIdentityPage(identityDeps, context);
          }
        } catch {
          /* 服务器不可达：静默，下次再复核 */
        }
      }
      void runPull(); // 激活自动拉取（A26，后台）
    } catch (err) {
      log("[pylearner] identity first-run check failed:", err);
    }
  })();
}

export function deactivate() {
  log("Python Learner extension deactivated");
}
