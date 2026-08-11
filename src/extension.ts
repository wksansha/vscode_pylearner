import * as vscode from "vscode";
import { CMD_IDS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { ChatStore } from "./storage/chatStore";
import { LlmRouter } from "./llm/router";
import { ChatViewProvider } from "./chat/chatProvider";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { getConfig } from "./settings/config";

let monitorEnabled = true;
let chatProvider: ChatViewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log("Python Learner extension activated");

  // Initialize core services
  const l1Writer = new L1Writer(context.globalStorageUri);
  const chatStore = new ChatStore(context.globalStorageUri);
  const router = new LlmRouter();
  monitorEnabled = getConfig().monitor.editEnabled || getConfig().monitor.runEnabled;

  // Register event listeners
  context.subscriptions.push(createEditListener(l1Writer));
  context.subscriptions.push(createRunListener(l1Writer));

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
      monitorEnabled = !monitorEnabled;
      vscode.window.showInformationMessage(
        `Python Learner monitoring: ${monitorEnabled ? "ON" : "OFF"}`
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
