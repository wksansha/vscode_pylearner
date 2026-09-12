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
import { CMD_IDS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { ChatStore } from "./storage/chatStore";
import { LlmRouter } from "./llm/router";
import { ChatViewProvider } from "./chat/chatProvider";
import { ProfileViewProvider } from "./chat/profileViewProvider";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { createDiagnosticsListener } from "./events/diagnosticsListener";
import { createBehaviorListener } from "./events/behaviorListener";
import { registerUpdateProfileCommand, registerResetProfileCommand } from "./commands/updateProfile";
import { ProfileRefresher } from "./commands/autoRefresh";
import { registerMemoryGraphCommand } from "./commands/memoryGraph";

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log("Python Learner extension activated");

  try {
    outputChannel = vscode.window.createOutputChannel("Python Learner");
    context.subscriptions.push(outputChannel);
    console.log("[pylearner] output channel created");
  } catch (err) {
    console.error("[pylearner] failed to create output channel:", err);
    void vscode.window.showErrorMessage(
      `Python Learner activation failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
    return;
  }

  try {
    await activateCore(context);
    console.log("[pylearner] activation complete, listeners registered");
  } catch (err) {
    console.error("[pylearner] activation failed:", err);
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
  console.log("[pylearner] core services initialized");

  // Factory function - creates a fresh router with current config on demand
  const routerFactory = () => new LlmRouter();
  const refresher = new ProfileRefresher(
    context.globalStorageUri,
    context.secrets,
    routerFactory
  );
  console.log("[pylearner] profile refresher created");

  // Register event listeners
  try {
    context.subscriptions.push(createEditListener(l1Writer));
    console.log("[pylearner] edit listener registered");
  } catch (err) {
    console.error("[pylearner] failed to register edit listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createRunListener(l1Writer));
    console.log("[pylearner] run listener registered");
  } catch (err) {
    console.error("[pylearner] failed to register run listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createDiagnosticsListener(l1Writer));
    console.log("[pylearner] diagnostics listener registered");
  } catch (err) {
    console.error("[pylearner] failed to register diagnostics listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createBehaviorListener(l1Writer));
    console.log("[pylearner] behavior listener registered");
  } catch (err) {
    console.error("[pylearner] failed to register behavior listener:", err);
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
    console.log("[pylearner] chat view provider registered");
  } catch (err) {
    console.error("[pylearner] failed to register chat view provider:", err);
    throw err;
  }

  // Register Learner Profile webview view
  try {
    const profileProvider = new ProfileViewProvider(context, routerFactory, outputChannel);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS.profileView,
        profileProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    console.log("[pylearner] profile view provider registered");
  } catch (err) {
    console.error("[pylearner] failed to register profile view provider:", err);
    throw err;
  }

  // Register commands
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openChat, () => {
        vscode.commands.executeCommand(`${VIEW_IDS.sidebarContainer}.focus`);
      })
    );
    console.log("[pylearner] openChat command registered");
  } catch (err) {
    console.error("[pylearner] failed to register openChat command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.newChat, () => {
        chatProvider.postMessage({ type: "newChat" });
      })
    );
    console.log("[pylearner] newChat command registered");
  } catch (err) {
    console.error("[pylearner] failed to register newChat command:", err);
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
    console.log("[pylearner] toggleMonitor command registered");
  } catch (err) {
    console.error("[pylearner] failed to register toggleMonitor command:", err);
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
    console.log("[pylearner] openSettings command registered");
  } catch (err) {
    console.error("[pylearner] failed to register openSettings command:", err);
    throw err;
  }

  // Create profile update commands lazily. Instantiating LlmRouter during
  // activation races VS Code's configuration initialization and can crash the
  // extension host when the new window starts.
  try {
    context.subscriptions.push(registerUpdateProfileCommand(context, routerFactory, outputChannel));
    console.log("[pylearner] update-profile command registered");
  } catch (err) {
    console.error("[pylearner] failed to register updateProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerResetProfileCommand(context, routerFactory, outputChannel));
    console.log("[pylearner] reset-profile command registered");
  } catch (err) {
    console.error("[pylearner] failed to register resetProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerMemoryGraphCommand(context));
    console.log("[pylearner] memory-graph command registered");
  } catch (err) {
    console.error("[pylearner] failed to register memoryGraph command:", err);
    throw err;
  }

  // Lazy background refresh shortly after activation
  try {
    const refreshTimer = setTimeout(() => void refresher.maybeRefresh(), 5000);
    context.subscriptions.push({ dispose: () => clearTimeout(refreshTimer) });
    console.log("[pylearner] refresh timer set");
  } catch (err) {
    console.error("[pylearner] failed to set refresh timer:", err);
    throw err;
  }
}

export function deactivate() {
  console.log("Python Learner extension deactivated");
}
