// src/test/reviewRequester.test.ts
import { describe, it, expect } from "vitest";
import { requestReview, type ReviewerDeps } from "../submission/reviewRequester";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
function makeDeps(status: "pass" | "fail" | "unreviewed", reason = "边界未处理") {
  const notices: [string, boolean][] = [];
  const posts: unknown[] = [];
  const deps: ReviewerDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    buildProjectSnapshot: async () => null,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ review: { status, reason, reviewedAt: 1, model: "m", source: "llm" }, submissionId: "s1" }), { status: 200 });
    }) as unknown as typeof fetch,
    notify: (m, w) => notices.push([m, w]),
  };
  return { deps, notices, posts };
}

describe("requestReview（F5 评审）", () => {
  it("单文件：payload 无 files，回执按三态", async () => {
    const { deps, notices } = makeDeps("pass", "通过");
    const r = await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(r).toBe("reviewed");
    expect(notices[0][0]).toContain("评审通过");
  });
  it("fail → warning 回执带 reason", async () => {
    const { deps, notices } = makeDeps("fail");
    await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(notices[0][0]).toContain("评审未通过");
    expect(notices[0][0]).toContain("边界未处理");
    expect(notices[0][1]).toBe(true);
  });
  it("unreviewed → 中性提示", async () => {
    const { deps, notices } = makeDeps("unreviewed");
    await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(notices[0][0]).toContain("未能完成评审");
    expect(notices[0][1]).toBe(false);
  });
  it("项目：buildProjectSnapshot 命中 → payload 携带 files + code=入口", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.buildProjectSnapshot = async () => ({ exerciseId: ID, files: [{ path: "main.py", content: "M" }], entryContent: "M" });
    await requestReview(deps, { filePath: "app/utils.py", content: "# u" });
    const body = posts[0] as { files?: unknown[]; code?: string };
    expect(body.files!.length).toBe(1);
    expect(body.code).toBe("M");
  });
  it("非练习文件 → not-exercise 静默；无身份 → identity-missing", async () => {
    const d1 = makeDeps("pass");
    expect(await requestReview(d1.deps, { filePath: "x", content: "print(1)" })).toBe("not-exercise");
    const d2 = makeDeps("pass");
    d2.deps.getIdentity = () => ({ studentId: null, studentName: null });
    expect(await requestReview(d2.deps, { filePath: "x", content: `# exercise-id: ${ID}\n` })).toBe("identity-missing");
  });
});
