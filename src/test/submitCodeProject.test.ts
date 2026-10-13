// src/test/submitCodeProject.test.ts
import { describe, it, expect } from "vitest";
import { submitCode, type SubmissionDeps } from "../submission/submissionReporter";
import { canonicalFilesHash } from "../submission/projectFiles";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
function makeDeps() {
  const state = new Map<string, unknown>();
  const posts: unknown[] = [];
  const deps: SubmissionDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    onIdentityMissing: () => {},
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => { state.set(k, v); },
    },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ submission: {} }), { status: 201 });
    }) as unknown as typeof fetch,
    saveIfDirty: async () => {},
    buildProjectSnapshot: async () => ({
      exerciseId: ID,
      files: [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }],
      entryContent: "m",
    }),
  };
  return { deps, posts, state };
}

describe("submitCode 项目化", () => {
  it("项目题：payload 携带 files，code=入口内容，幂等键=canonicalFilesHash", async () => {
    const { deps, posts, state } = makeDeps();
    const r = await submitCode(deps, { filePath: "C:\\ws\\week-03\\app\\utils.py", content: "# u", source: "manual" });
    expect(r).toBe("submitted");
    const body = posts[0] as { files?: unknown[]; code?: string };
    expect(body.files!.length).toBe(2);
    expect(body.code).toBe("m");
    const last = state.get("pylearner.submission.lastHashes") as Record<string, string>;
    expect(last[ID]).toBe(canonicalFilesHash([{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }]));
  });
  it("同快照重复提交 → skipped", async () => {
    const { deps } = makeDeps();
    await submitCode(deps, { filePath: "x", content: "c", source: "manual" });
    expect(await submitCode(deps, { filePath: "x", content: "c", source: "manual" })).toBe("skipped");
  });
  it("单文件题（无快照函数）：旧行为 payload 无 files", async () => {
    const { deps, posts } = makeDeps();
    (deps as unknown as { buildProjectSnapshot: undefined }).buildProjectSnapshot = undefined;
    const r = await submitCode(deps, { filePath: "C:\\ws\\week-03\\01.py", content: `# exercise-id: ${ID}\nprint(1)`, source: "manual" });
    expect(r).toBe("submitted");
    expect((posts[0] as { files?: unknown }).files).toBeUndefined();
  });
});
