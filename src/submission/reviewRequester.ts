// src/submission/reviewRequester.ts
import type { TraceEvent } from "../events/types";
import { scanExerciseId } from "./exerciseHeader";
import type { SubmissionFile } from "./projectFiles";

export interface ReviewerDeps {
  teacherUrl: () => string;
  getIdentity: () => { studentId: string | null; studentName: string | null };
  buildProjectSnapshot: (filePath: string, content: string) => Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>;
  fetchImpl?: typeof fetch;
  notify: (message: string, isWarning: boolean) => void;
}

export type ReviewOutcome = "reviewed" | "not-exercise" | "identity-missing" | "error";

interface ReviewResponse {
  review: { status: "pass" | "fail" | "unreviewed"; reason: string };
  submissionId: string | null;
}

/** F5 运行成功 → 评审工作区快照（spec §5.3）；与提交互不触发 */
export async function requestReview(deps: ReviewerDeps, args: { filePath: string; content: string }): Promise<ReviewOutcome> {
  const snapshot = await deps.buildProjectSnapshot(args.filePath, args.content);
  const exerciseId = snapshot?.exerciseId ?? scanExerciseId(args.content);
  if (!exerciseId) return "not-exercise";
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) return "identity-missing";   // F5 静默，不弹身份页
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/reviews/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: identity.studentId, studentName: identity.studentName, exerciseId,
        code: snapshot ? snapshot.entryContent : args.content,
        ...(snapshot ? { files: snapshot.files } : {}),
      }),
    });
    if (!res.ok) return "error";
    const body = (await res.json()) as ReviewResponse;
    const { status, reason } = body.review;
    if (status === "pass") deps.notify(`✅ 评审通过${reason ? `：${reason}` : ""}`, false);
    else if (status === "fail") deps.notify(`❌ 评审未通过：${reason}`, true);
    else deps.notify("⚪ 本次未能完成评审，稍后再试", false);
    return "reviewed";
  } catch {
    return "error";
  }
}

/** run 成功事件入口（替代原自动提交链）：定位逻辑同源——payload.file 优先，活动编辑器兜底 */
export function makeRunSuccessReviewer(
  deps: ReviewerDeps,
  vscode: typeof import("vscode"),
  readFile: (fsPath: string) => Promise<string | null>,
): (event: TraceEvent) => Promise<void> {
  return async (event) => {
    try {
      const payload = event.payload as { file?: string };
      let filePath: string | null = payload.file ?? null;
      if (!filePath) {
        const active = vscode.window.activeTextEditor?.document;
        if (active && active.uri.fsPath.endsWith(".py")) filePath = active.uri.fsPath;
      }
      if (!filePath) return;
      const content = await readFile(filePath);
      if (content === null) return;
      await requestReview(deps, { filePath, content });
    } catch (err) {
      console.warn("[ReviewRequester] run review failed:", err instanceof Error ? err.message : String(err));
    }
  };
}
