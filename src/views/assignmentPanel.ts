// src/views/assignmentPanel.ts
import * as vscode from "vscode";
import { CMD_IDS } from "../constants";

interface PanelItem {
  label: string;
  command: string;
  icon: vscode.ThemeIcon;
}

/** 「运行和调试」侧边栏的课堂作业面板（spec §5.5）：三行入口，点击执行既有命令 */
export function createAssignmentPanel(): vscode.TreeDataProvider<PanelItem> {
  const items: PanelItem[] = [
    { label: "拉取作业", command: CMD_IDS.pullAssignments, icon: new vscode.ThemeIcon("repo-pull") },
    { label: "提交作业", command: CMD_IDS.submitExercise, icon: new vscode.ThemeIcon("cloud-upload") },
    { label: "恢复我的提交", command: CMD_IDS.restoreSubmissions, icon: new vscode.ThemeIcon("history") },
  ];
  return {
    getChildren: () => items,
    getTreeItem: (item) => {
      const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      tree.command = { command: item.command, title: item.label };
      tree.iconPath = item.icon;
      return tree;
    },
  };
}
