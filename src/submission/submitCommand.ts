import { submitCode, type SubmitOutcome, type SubmissionDeps } from "./submissionReporter";
import type { SubmissionTarget } from "./collectTargets";

export const OUTCOME_TEXT: Record<SubmitOutcome, string> = {
  submitted: "✅ 已归档（运行成功后会自动评审并给出回执）",
  skipped: "该代码已归档过，未重复提交",
  "not-exercise": "当前文件不是课堂练习（缺少课堂头部），无需提交",
  "identity-missing": "请先在身份页设置学号与姓名",
  error: "归档失败，请稍后重试或联系教员",
};

export interface SubmitCommandDeps extends SubmissionDeps {
  /** V2.0 提交按钮：一键归档——遍历工作区收集全部提交目标；缺省回退旧的"当前文件"单文件路径 */
  collectTargets?: (rootFsPath: string) => Promise<SubmissionTarget[]>;
  /** 回退单文件路径读活动编辑器文件用（extension.ts 始终提供 collectTargets，此字段仅供回退） */
  readFile?: (fsPath: string) => Promise<string | null>;
}

/** 归档结果汇总（供提交命令展示与切换身份流程编排） */
export interface ArchiveSummary {
  submitted: number;
  skipped: number;
  failed: number;
  failedLabels: string[];
  identityMissing: boolean;
}

/** 归档循环核心（无 UI）：逐目标调用 submitCode；identity-missing 立即停止。供提交命令与切换身份流程共用 */
export async function archiveWorkspaceTargets(deps: SubmissionDeps, targets: SubmissionTarget[]): Promise<ArchiveSummary> {
  const summary: ArchiveSummary = { submitted: 0, skipped: 0, failed: 0, failedLabels: [], identityMissing: false };
  for (const target of targets) {
    const outcome = await submitCode(deps, { filePath: target.filePath, content: target.content, source: "manual" });
    if (outcome === "submitted") summary.submitted++;
    else if (outcome === "skipped") summary.skipped++;
    else if (outcome === "identity-missing") { summary.identityMissing = true; return summary; }   // 身份缺失 → 停止
    else { summary.failed++; summary.failedLabels.push(target.label); }                            // error / not-exercise
  }
  return summary;
}

/** 提交命令（V2.0）：一键归档工作区全部练习（week-XX），幂等跳过已交；F5 评审链不变。缺 collectTargets 时回退单文件路径（A3 兜底） */
export function makeSubmitCommand(deps: SubmitCommandDeps, vscode: typeof import("vscode")) {
  return async (): Promise<void> => {
    if (!deps.collectTargets) return submitActiveEditor(deps, vscode);

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      vscode.window.showWarningMessage("请先打开课堂文件夹");
      return;
    }
    const targets = await deps.collectTargets(root.uri.fsPath);
    if (targets.length === 0) {
      vscode.window.showInformationMessage("未找到课堂练习（week-XX 目录）");
      return;
    }
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在提交作业…" },
      () => archiveWorkspaceTargets(deps, targets),
    );
    if (summary.identityMissing) {
      deps.onIdentityMissing();
      vscode.window.showWarningMessage("请先在身份页设置学号与姓名");
      return;
    }
    let msg = `✅ 提交完成：新归档 ${summary.submitted} · 已是最新 ${summary.skipped}`;
    if (summary.failed > 0) msg += ` · 失败 ${summary.failed}：${summary.failedLabels.join("、")}`;
    if (summary.failed > 0) vscode.window.showWarningMessage(msg);
    else vscode.window.showInformationMessage(msg);
  };
}

/** 回退：旧的"当前文件"单文件提交（A3 兜底；dirty 先保存 A27） */
async function submitActiveEditor(deps: SubmitCommandDeps, vscode: typeof import("vscode")): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.uri.fsPath.endsWith(".py")) {
    vscode.window.showWarningMessage("请先打开要提交的练习 .py 文件");
    return;
  }
  const filePath = editor.document.uri.fsPath;
  if (editor.document.isDirty) await editor.document.save();
  const content = await deps.readFile?.(filePath);
  if (content === null || content === undefined) {
    vscode.window.showErrorMessage("无法读取文件");
    return;
  }
  const outcome = await submitCode(deps, { filePath, content, source: "manual" });
  if (outcome === "identity-missing") vscode.window.showWarningMessage(OUTCOME_TEXT[outcome]);
  else vscode.window.showInformationMessage(OUTCOME_TEXT[outcome]);
}
