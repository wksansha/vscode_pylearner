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

  // 初始化教师端上报器（如果启用）
  let currentReporter: ReturnType<typeof createTeacherReporter> | undefined;
  async function applyTeacherReporter() {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    const enabled = cfg.get<boolean>(CONFIG_KEYS.teacherEnabled, true);
    if (enabled) {
      const teacherUrl =
        cfg.get<string>(CONFIG_KEYS.teacherUrl, "http://localhost:3000") ||
        "http://localhost:3000";
      const studentId =
        (await context.secrets.get(SECRET_KEYS.studentId)) || vscode.env.machineId;
      const studentName =
        (await context.secrets.get(SECRET_KEYS.studentName)) || "Unknown";
      const classId = await context.secrets.get(SECRET_KEYS.classId);
      currentReporter = createTeacherReporter({
        teacherUrl,
        studentId,
        studentName,
        classId,
      });
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
}

export function deactivate() {
  log("Python Learner extension deactivated");
}
