// src/submission/reviewRequester.ts
import type { TraceEvent } from "../events/types";
import type { SubmissionFile } from "./projectFiles";

export interface ReviewerDeps {
  teacherUrl: () => string;
  getIdentity: () => { studentId: string | null; studentName: string | null };
  buildProjectSnapshot: (filePath: string, content: string) => Promise<{ files: SubmissionFile[]; entryContent: string } | null>;
  workspaceRoot: () => string;                 // toPosix 相对化基准（workspace 根 = 仓库根）
  getCommitHash: () => Promise<string>;        // git rev-parse HEAD；非 git 仓库由调用方 catch → ""
  fetchImpl?: typeof fetch;
  notify: (message: string, isWarning: boolean) => void;
}

export type ReviewOutcome = "reviewed" | "not-exercise" | "identity-missing" | "error";

/** fsPath → 相对 workspace 根的 POSIX 路径（lesson5/weather-app/main.py）；根外路径原样 POSIX 化 */
export function toPosix(fsPath: string, rootFsPath: string): string {
  const norm = fsPath.replace(/\//g, "\\");
  const root = rootFsPath.replace(/\//g, "\\").replace(/[\\/]+$/, "");
  const rel = root && norm.startsWith(root + "\\") ? norm.slice(root.length + 1) : norm.replace(/^\\+/, "");
  return rel.replace(/\\/g, "/");
}

interface ReviewResponse {
  review: { status: "pass" | "fail" | "unreviewed"; reason: string; source?: "llm" | "mock" | "timeout" | "not_configured" };
  submissionId: string | null;
}

/** F5 运行成功 → 评审当前文件（spec 2.1：练习定位 = 文件路径 + commitHash，学生端零识别）；与提交互不触发 */
export async function requestReview(deps: ReviewerDeps, args: { filePath: string; content: string }): Promise<ReviewOutcome> {
  const snapshot = await deps.buildProjectSnapshot(args.filePath, args.content);   // 项目题快照收集
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) return "identity-missing";   // F5 静默，不弹身份页
  const commitHash = await deps.getCommitHash().catch(() => "");                 // 非 git 仓库 / git 失败 → ""
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/reviews/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: identity.studentId, studentName: identity.studentName,
        filePath: toPosix(args.filePath, deps.workspaceRoot()),    // POSIX 相对路径（相对仓库根）
        code: snapshot ? snapshot.entryContent : args.content,
        commitHash,
        ...(snapshot ? { files: snapshot.files } : {}),
      }),
    });
    if (res.status === 404) return "not-exercise";   // 服务端未命中 exercises 表 → 静默（唯一注册表在服务端）
    if (!res.ok) return "error";
    const body = (await res.json()) as ReviewResponse;
    const { status, reason, source } = body.review;
    if (status === "pass") deps.notify(`✅ 评审通过${reason ? `：${reason}` : ""}`, false);
    else if (status === "fail") deps.notify(`❌ 评审未通过：${reason}`, true);
    else if (source === "not_configured") console.warn("[ReviewRequester] 本环境未启用 AI 评审，跳过提示");   // 未配置 LLM 的环境（如云上练习）：静默，不提示重试
    else deps.notify("⚪ 本次未能完成评审，稍后再试", false);
    return "reviewed";
  } catch {
    return "error";
  }
}

/** run 成功事件入口：定位逻辑同源——payload.file 优先，活动编辑器兜底 */
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
