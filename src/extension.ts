import * as vscode from "vscode";
import { CMD_IDS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { getConfig } from "./settings/config";

let monitorEnabled = true;
let l1Writer: L1Writer;

export function activate(context: vscode.ExtensionContext) {
  console.log("Python Learner extension activated");

  // Initialize L1 writer with global storage
  l1Writer = new L1Writer(context.globalStorageUri);
  monitorEnabled = getConfig().monitor.editEnabled || getConfig().monitor.runEnabled;

  // Register event listeners
  context.subscriptions.push(createEditListener(l1Writer));
  context.subscriptions.push(createRunListener(l1Writer));

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.openChat, () => {
      vscode.commands.executeCommand(`${VIEW_IDS.sidebarContainer}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.newChat, () => {
      vscode.commands.executeCommand(
        "workbench.action.webview.reloadWebviewAction"
      );
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
