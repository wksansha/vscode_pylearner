// src/test/reviewRequester.test.ts
import { describe, it, expect } from "vitest";
import { requestReview, makeRunSuccessReviewer, type ReviewerDeps } from "../submission/reviewRequester";
import type { TraceEvent } from "../events/types";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
function makeDeps(status: "pass" | "fail" | "unreviewed", reason = "边界未处理") {
  const notices: [string, boolean][] = [];
  const posts: unknown[] = [];
  const urls: string[] = [];
  const deps: ReviewerDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    buildProjectSnapshot: async () => null,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      urls.push(_url);
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ review: { status, reason, reviewedAt: 1, model: "m", source: "llm" }, submissionId: "s1" }), { status: 200 });
    }) as unknown as typeof fetch,
    notify: (m, w) => notices.push([m, w]),
  };
  return { deps, notices, posts, urls };
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

describe("makeRunSuccessReviewer（F5 运行成功 → 自动评审）", () => {
  const vscodeNone = { window: { activeTextEditor: undefined } } as unknown as typeof import("vscode");
  function makeEvent(file?: string): TraceEvent {
    return {
      id: "run:e1",
      ts: "2026-10-13T00:00:00.000Z",
      surface: "run",
      kind: "run_success",
      payload: file === undefined ? {} : { file },
    };
  }

  it("payload.file 命中：readFile → POST /api/reviews/request → 评审通过回执", async () => {
    const { deps, notices, posts, urls } = makeDeps("pass", "边界完整");
    const reads: string[] = [];
    const reviewer = makeRunSuccessReviewer(deps, vscodeNone, async (p) => {
      reads.push(p);
      return `# exercise-id: ${ID}\nprint(1)`;
    });
    await reviewer(makeEvent("C:\\x\\a.py"));
    expect(reads).toEqual(["C:\\x\\a.py"]);
    expect(urls[0]).toBe("http://t/api/reviews/request");
    const body = posts[0] as { exerciseId: string; code: string };
    expect(body.exerciseId).toBe(ID);
    expect(body.code).toContain("print(1)");
    expect(notices[0][0]).toContain("评审通过");
  });

  it("无 payload.file → 活动编辑器兜底；非练习文件静默", async () => {
    const { deps, notices, posts } = makeDeps("pass");
    const vscode = { window: { activeTextEditor: { document: { uri: { fsPath: "C:\\x\\b.py" } } } } } as unknown as typeof import("vscode");
    const reads: string[] = [];
    const reviewer = makeRunSuccessReviewer(deps, vscode, async (p) => {
      reads.push(p);
      return "print(1)";
    });
    await reviewer(makeEvent());
    expect(reads).toEqual(["C:\\x\\b.py"]);
    expect(posts).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("fetch 拒绝 → error 静默，不向调用方抛出", async () => {
    const { deps, notices } = makeDeps("pass");
    deps.fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const reviewer = makeRunSuccessReviewer(deps, vscodeNone, async () => `# exercise-id: ${ID}\nprint(1)`);
    await expect(reviewer(makeEvent("C:\\x\\a.py"))).resolves.toBeUndefined();
    expect(notices).toHaveLength(0);
  });

  it("readFile 返回 null → 不发起请求、不回执", async () => {
    const { deps, notices, posts } = makeDeps("pass");
    const reviewer = makeRunSuccessReviewer(deps, vscodeNone, async () => null);
    await reviewer(makeEvent("C:\\x\\a.py"));
    expect(posts).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });
});
