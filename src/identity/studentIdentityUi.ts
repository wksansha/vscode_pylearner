/**
 * 学生身份的 VS Code UI 层：InputBox 弹窗、首启提示。
 * 存储与校验逻辑在 studentIdentity.ts（纯逻辑，可单测）。
 */
import * as vscode from "vscode";
import {
  loadStudentIdentity,
  saveStudentIdentity,
  validateStudentId,
  validateStudentName,
  type KeyValueStore,
  type StudentIdentityInput,
} from "./studentIdentity";

/** 连续两个输入框：学号 → 姓名；用户取消（Esc）返回 undefined */
export async function promptForIdentity(
  current?: { studentId?: string | null; studentName?: string | null }
): Promise<StudentIdentityInput | undefined> {
  const studentId = await vscode.window.showInputBox({
    title: "课堂助手 · 学号",
    prompt: current?.studentId ? "修改学号（作为你的唯一标识）" : "首次使用，请输入你的学号（作为课堂系统中的唯一标识）",
    placeHolder: "例如：20240101",
    value: current?.studentId ?? "",
    validateInput: validateStudentId,
    ignoreFocusOut: true,
  });
  if (studentId === undefined) return undefined;

  const studentName = await vscode.window.showInputBox({
    title: "课堂助手 · 姓名",
    prompt: "请输入你的姓名",
    placeHolder: "例如：张三",
    value: current?.studentName ?? "",
    validateInput: validateStudentName,
    ignoreFocusOut: true,
  });
  if (studentName === undefined) return undefined;

  return { studentId: studentId.trim(), studentName: studentName.trim() };
}

/**
 * 首启提示：globalState 里没有学号时弹窗让输入。
 * 取消则本次启动不再打扰，下次启动继续问（填一次即止）。
 */
export async function maybePromptFirstRun(
  state: KeyValueStore,
  onSaved?: () => void
): Promise<void> {
  if (loadStudentIdentity(state).studentId) return;
  const identity = await promptForIdentity();
  if (!identity) return;
  await saveStudentIdentity(state, identity);
  vscode.window.showInformationMessage(
    `身份已保存：${identity.studentId} ${identity.studentName}（可随时点击左下角状态栏修改）`
  );
  onSaved?.();
}
