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
import { registerUpdateProfileCommand } from "./commands/updateProfile";
import { ProfileRefresher } from "./commands/autoRefresh";

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
  const refresher = new ProfileRefresher(
    context.globalStorageUri,
    context.secrets,
    router
  );

  // Register event listeners
  context.subscriptions.push(createEditListener(l1Writer));
  console.log("[pylearner] edit listener registered");
  context.subscriptions.push(createRunListener(l1Writer));
  console.log("[pylearner] run listener registered");
  context.subscriptions.push(createDiagnosticsListener(l1Writer));
  console.log("[pylearner] diagnostics listener registered");

  // Register Chat Webview Provider
  chatProvider = new ChatViewProvider(context, router, l1Writer, chatStore, refresher);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_IDS.chatView,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register Learner Profile webview view
  const profileProvider = new ProfileViewProvider(context, router);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_IDS.profileView,
      profileProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  console.log("[pylearner] profile view provider registered");

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

  context.subscriptions.push(registerUpdateProfileCommand(context, router));
  console.log("[pylearner] update-profile command registered");

  // Lazy background refresh shortly after activation, so a user who has been
  // coding without opening chat still gets a fresh profile. Fire-and-forget;
  // threshold + cooldown are enforced inside the refresher.
  const refreshTimer = setTimeout(() => void refresher.maybeRefresh(), 5000);
  context.subscriptions.push({ dispose: () => clearTimeout(refreshTimer) });
}

export function deactivate() {
  console.log("Python Learner extension deactivated");
}
