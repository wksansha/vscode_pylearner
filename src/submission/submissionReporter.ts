import crypto from "node:crypto";
import type { KeyValueStore } from "../identity/studentIdentity";
import { scanExerciseId } from "./exerciseHeader";
import { canonicalFilesHash, type SubmissionFile } from "./projectFiles";

export type SubmitOutcome = "submitted" | "skipped" | "not-exercise" | "identity-missing" | "error";

export interface SubmissionDeps {
  teacherUrl: () => string;
  getIdentity: () => { studentId: string | null; studentName: string | null };
  onIdentityMissing: () => void;
  globalState: KeyValueStore;
  fetchImpl?: typeof fetch;
  saveIfDirty?: (filePath: string) => Promise<void>;
  /** 项目题快照（V2.0）：返回 null = 非项目文件；缺省时仅支持单文件头部 id */
  buildProjectSnapshot?: (filePath: string, content: string) => Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>;
}

const LAST_HASHES_KEY = "pylearner.submission.lastHashes";   // { [exerciseId]: codeHash }（A7 防抖）

/** 提交链核心（spec §6.2 六步；纯依赖注入，可单测） */
export async function submitCode(deps: SubmissionDeps, args: { filePath: string; content: string; source: "auto" | "manual" }): Promise<SubmitOutcome> {
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) {           // 步骤 4：身份门控（A8）
    deps.onIdentityMissing();
    return "identity-missing";
  }
  await deps.saveIfDirty?.(args.filePath);                      // 步骤 3：dirty 防御（A27，提交=学生眼前版本）

  // 定位（V2.0）：项目快照优先，回退单文件头部 id
  let exerciseId: string | null = null;
  let files: SubmissionFile[] | undefined;
  let payloadCode = args.content;
  const snapshot = deps.buildProjectSnapshot ? await deps.buildProjectSnapshot(args.filePath, args.content) : null;
  if (snapshot) {
    exerciseId = snapshot.exerciseId;
    files = snapshot.files;
    payloadCode = snapshot.entryContent;
  } else {
    exerciseId = scanExerciseId(args.content);
  }
  if (!exerciseId) return "not-exercise";                       // 步骤 2：非练习文件跳过

  const codeHash = files ? canonicalFilesHash(files) : crypto.createHash("sha256").update(args.content).digest("hex");
  const last = (deps.globalState.get(LAST_HASHES_KEY) ?? {}) as Record<string, string>;
  if (last[exerciseId] === codeHash) return "skipped";          // 步骤 5：防抖（A7）
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exerciseId, studentId: identity.studentId, studentName: identity.studentName,
        code: payloadCode, filePath: args.filePath, source: args.source,   // spec §2.3 wire payload
        ...(files ? { files } : {}),
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
