import * as vscode from "vscode";
import { CMD_IDS, VIEW_IDS } from "./constants";

export function activate(context: vscode.ExtensionContext) {
  console.log("Python Learner extension activated");

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.openChat, () => {
      vscode.commands.executeCommand(
        `${VIEW_IDS.sidebarContainer}.focus`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.newChat, () => {
      // Will be wired to ChatViewProvider in Task 6
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.toggleMonitor, () => {
      // Will be wired in Task 4
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