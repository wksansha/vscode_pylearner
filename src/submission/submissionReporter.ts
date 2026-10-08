import crypto from "node:crypto";
import type { TraceEvent } from "../events/types";
import type { KeyValueStore } from "../identity/studentIdentity";
import { scanExerciseId } from "./exerciseHeader";

export type SubmitOutcome = "submitted" | "skipped" | "not-exercise" | "identity-missing" | "error";

export interface SubmissionDeps {
  teacherUrl: () => string;
  getIdentity: () => { studentId: string | null; studentName: string | null };
  onIdentityMissing: () => void;
  globalState: KeyValueStore;
  fetchImpl?: typeof fetch;
  saveIfDirty?: (filePath: string) => Promise<void>;
}

const LAST_HASHES_KEY = "pylearner.submission.lastHashes";   // { [exerciseId]: codeHash }（A7 防抖）

/** 提交链核心（spec §6.2 六步；纯依赖注入，可单测） */
export async function submitCode(deps: SubmissionDeps, args: { filePath: string; content: string; source: "auto" | "manual" }): Promise<SubmitOutcome> {
  const exerciseId = scanExerciseId(args.content);
  if (!exerciseId) return "not-exercise";                       // 步骤 2：非练习文件跳过
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) {           // 步骤 4：身份门控（A8）
    deps.onIdentityMissing();
    return "identity-missing";
  }
  await deps.saveIfDirty?.(args.filePath);                      // 步骤 3：dirty 防御（A27，提交=学生眼前版本）
  const codeHash = crypto.createHash("sha256").update(args.content).digest("hex");
  const last = (deps.globalState.get(LAST_HASHES_KEY) ?? {}) as Record<string, string>;
  if (last[exerciseId] === codeHash) return "skipped";          // 步骤 5：防抖（A7）
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exerciseId, studentId: identity.studentId, studentName: identity.studentName,
        code: args.content, filePath: args.filePath, source: args.source,   // spec §2.3 wire payload
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "" })) as { error?: string };
      if (body.error === "学号不在名册") {                       // 服务端终校验（A8 最后防线）
        deps.onIdentityMissing();
        return "identity-missing";
      }
      return "error";
    }
    last[exerciseId] = codeHash;
    await deps.globalState.update(LAST_HASHES_KEY, last);
    return "submitted";
  } catch {
    return "error";
  }
}

/** run 成功事件入口（A27：优先 payload.file；活动编辑器兜底）——vscode 胶水，T16 装配 */
export function makeHandleRunSuccess(
  deps: SubmissionDeps,
  vscode: typeof import("vscode"),
  readFile: (fsPath: string) => Promise<string | null>,
): (event: TraceEvent) => Promise<void> {
  return async (event) => {
    try {
      const payload = event.payload as { file?: string; command?: string };
      let filePath: string | null = payload.file ?? null;
      if (!filePath) {
        const active = vscode.window.activeTextEditor?.document;
        if (active && active.uri.fsPath.endsWith(".py")) filePath = active.uri.fsPath;
      }
      if (!filePath) return;                                    // 定位失败 → 手动命令兜底（A22）
      const content = await readFile(filePath);
      if (content === null) return;
      await submitCode(deps, { filePath, content, source: "auto" });
    } catch (err) {
      console.warn("[SubmissionReporter] auto submit failed:", err instanceof Error ? err.message : String(err));
    }
  };
}
