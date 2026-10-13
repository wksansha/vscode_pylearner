// src/identity/sessionConfirm.ts
export interface GateDeps {
  vscode: typeof import("vscode");
  getIdentity: () => { studentId: string | null; studentName: string | null };
  onSwitchIdentity: () => void;   // 打开身份页
  onConfirmed: () => void;        // 状态栏恢复正常
}

/** 共享电脑防误用（spec §5.5/§5.6）：每窗口会话确认一次，未确认拦截关键动作 */
export function createSessionConfirmGate(deps: GateDeps) {
  let confirmed = false;
  return {
    isConfirmed: () => confirmed,
    reset() { confirmed = false; },
    async ensureConfirmed(): Promise<boolean> {
      const id = deps.getIdentity();
      if (!id.studentId || !id.studentName) {
        deps.onSwitchIdentity();
        return false;
      }
      if (confirmed) return true;
      const pick = await deps.vscode.window.showInformationMessage(
        `本机记录的课堂身份是：${id.studentId} · ${id.studentName}\n这是你本人吗？`,
        { modal: true },
        "是我本人",
        "切换身份",
      );
      if (pick === "是我本人") {
        confirmed = true;
        deps.onConfirmed();
        return true;
      }
      if (pick === "切换身份") deps.onSwitchIdentity();
      return false;   // Esc / 关闭同样视为未确认
    },
  };
}
