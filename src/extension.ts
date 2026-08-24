import * as vscode from "vscode";
import { CMD_IDS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { ChatStore } from "./storage/chatStore";
import { LlmRouter } from "./llm/router";
import { ChatViewProvider } from "./chat/chatProvider";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { createDiagnosticsListener } from "./events/diagnosticsListener";

let chatProvider: ChatViewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log("Python Learner extension activated");

  try {
    activateCore(context);
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

function activateCore(context: vscode.ExtensionContext) {
  // Initialize core services
  const l1Writer = new L1Writer(context.globalStorageUri);
  const chatStore = new ChatStore(context.globalStorageUri);
  const router = new LlmRouter();

  // Register event listeners
  context.subscriptions.push(createEditListener(l1Writer));
  console.log("[pylearner] edit listener registered");
  context.subscriptions.push(createRunListener(l1Writer));
  console.log("[pylearner] run listener registered");
  context.subscriptions.push(createDiagnosticsListener(l1Writer));
  console.log("[pylearner] diagnostics listener registered");

  // Register Chat Webview Provider
  chatProvider = new ChatViewProvider(context, router, l1Writer, chatStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_IDS.chatView,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.openChat, () => {
      vscode.commands.executeCommand(`${VIEW_IDS.sidebarContainer}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.newChat, () => {
      chatProvider.postMessage({ type: "newChat" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.toggleMonitor, () => {
      // Write through to real config so the event listeners (which read
      // pylearner.monitor.* directly) actually honor the toggle, and so the
      // change is reflected in the Settings UI.
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

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.openSettings, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "pylearner"
      );
    })
  );
}

export function deactivate() {
  console.log("Python Learner extension deactivated");
}
