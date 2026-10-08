import * as vscode from "vscode";
import { submitCode, type SubmitOutcome, type SubmissionDeps } from "./submissionReporter";

export const OUTCOME_TEXT: Record<SubmitOutcome, string> = {
  submitted: "✅ 已提交，等待评审（结果见教师端作业矩阵）",
  skipped: "该代码已提交过，未重复提交",
  "not-exercise": "当前文件不是课堂练习（缺少课堂头部），无需提交",
  "identity-missing": "请先在身份页设置学号与姓名",
  error: "提交失败，请稍后重试或联系教员",
};

/** 手动提交命令（A3 兜底）：活动编辑器文件；dirty 先保存（A27） */
export function makeSubmitCommand(deps: SubmissionDeps, readFile: (fsPath: string) => Promise<string | null>) {
  return async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.uri.fsPath.endsWith(".py")) {
      vscode.window.showWarningMessage("请先打开要提交的练习 .py 文件");
      return;
    }
    const filePath = editor.document.uri.fsPath;
    if (editor.document.isDirty) await editor.document.save();
    const content = await readFile(filePath);
    if (content === null) {
      vscode.window.showErrorMessage("无法读取文件");
      return;
    }
    const outcome = await submitCode(deps, { filePath, content, source: "manual" });
    if (outcome === "identity-missing") vscode.window.showWarningMessage(OUTCOME_TEXT[outcome]);
    else vscode.window.showInformationMessage(OUTCOME_TEXT[outcome]);
  };
}
