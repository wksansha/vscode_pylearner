// src/test/reviewRequester.test.ts
import { describe, it, expect } from "vitest";
import { requestReview, makeRunSuccessReviewer, toPosix, type ReviewerDeps } from "../submission/reviewRequester";
import type { TraceEvent } from "../events/types";

function makeDeps(status: "pass" | "fail" | "unreviewed", reason = "边界未处理") {
  const notices: [string, boolean][] = [];
  const posts: unknown[] = [];
  const urls: string[] = [];
  const deps: ReviewerDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    buildProjectSnapshot: async () => null,
    workspaceRoot: () => "C:\\ws",
    getCommitHash: async () => "abc1234",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      urls.push(_url);
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ review: { status, reason, reviewedAt: 1, model: "m", source: "llm" }, submissionId: "s1" }), { status: 200 });
    }) as unknown as typeof fetch,
    notify: (m, w) => notices.push([m, w]),
  };
  return { deps, notices, posts, urls };
}

describe("toPosix（fsPath → 相对仓库根 POSIX 路径）", () => {
  it("根内路径：反斜杠→斜杠 + 剥根前缀", () => {
    expect(toPosix("C:\\ws\\lesson5\\weather-app\\main.py", "C:\\ws")).toBe("lesson5/weather-app/main.py");
  });
  it("容忍正斜杠与根尾反斜杠", () => {
    expect(toPosix("C:/ws/lesson5/a.py", "C:\\ws\\")).toBe("lesson5/a.py");
  });
  it("根外路径：原样 POSIX 化（交服务端 404 判定）", () => {
    expect(toPosix("D:\\other\\a.py", "C:\\ws")).toBe("D:/other/a.py");
  });
});

describe("requestReview（F5 评审，filePath + commitHash）", () => {
  it("命中：POST body 含 POSIX filePath + commitHash + code，pass → 回执", async () => {
    const { deps, notices, posts, urls } = makeDeps("pass", "通过");
    const r = await requestReview(deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" });
    expect(r).toBe("reviewed");
    expect(urls[0]).toBe("http://t/api/reviews/request");
    const body = posts[0] as { filePath: string; commitHash: string; code: string; studentId: string; studentName: string };
    expect(body.filePath).toBe("lesson5/a.py");
    expect(body.commitHash).toBe("abc1234");
    expect(body.code).toBe("print(1)");
    expect(body.studentId).toBe("2025001");
    expect(notices[0][0]).toContain("评审通过");
  });
  it("fail → warning 回执带 reason；unreviewed → 中性提示", async () => {
    const d1 = makeDeps("fail");
    await requestReview(d1.deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" });
    expect(d1.notices[0][0]).toContain("评审未通过");
    expect(d1.notices[0][0]).toContain("边界未处理");
    expect(d1.notices[0][1]).toBe(true);
    const d2 = makeDeps("unreviewed");
    await requestReview(d2.deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" });
    expect(d2.notices[0][0]).toContain("未能完成评审");
    expect(d2.notices[0][1]).toBe(false);
  });
  it("服务端 404 → not-exercise 静默（无 notify 弹窗）", async () => {
    const { deps, notices } = makeDeps("pass");
    deps.fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await requestReview(deps, { filePath: "C:\\ws\\notes\\todo.py", content: "print(1)" })).toBe("not-exercise");
    expect(notices).toHaveLength(0);
  });
  it("非 git 仓库：getCommitHash 返回 \"\" → 请求仍发（commitHash: \"\"）", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.getCommitHash = async () => "";
    await requestReview(deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" });
    expect((posts[0] as { commitHash: string }).commitHash).toBe("");
  });
  it("getCommitHash 抛错（非 git 仓库）→ 兜底 \"\"，请求仍发", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.getCommitHash = async () => { throw new Error("not a git repo"); };
    expect(await requestReview(deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" })).toBe("reviewed");
    expect((posts[0] as { commitHash: string }).commitHash).toBe("");
  });
  it("项目题：files 快照随请求，code=入口内容", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.buildProjectSnapshot = async () => ({ files: [{ path: "main.py", content: "M" }, { path: "utils.py", content: "u" }], entryContent: "M" });
    await requestReview(deps, { filePath: "C:\\ws\\lesson5\\weather-app\\utils.py", content: "# u" });
    const body = posts[0] as { files?: unknown[]; code?: string; filePath: string };
    expect(body.files!.length).toBe(2);
    expect(body.code).toBe("M");
    expect(body.filePath).toBe("lesson5/weather-app/utils.py");
  });
  it("无身份 → identity-missing（不发请求）", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.getIdentity = () => ({ studentId: null, studentName: null });
    expect(await requestReview(deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "print(1)" })).toBe("identity-missing");
    expect(posts).toHaveLength(0);
  });
  it("非 2xx（非 404）→ error；fetch 拒绝 → error", async () => {
    const d1 = makeDeps("pass");
    d1.deps.fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await requestReview(d1.deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "x" })).toBe("error");
    const d2 = makeDeps("pass");
    d2.deps.fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await requestReview(d2.deps, { filePath: "C:\\ws\\lesson5\\a.py", content: "x" })).toBe("error");
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

  it("payload.file 命中：readFile → POST 带 POSIX filePath + commitHash → 评审通过回执", async () => {
    const { deps, notices, posts, urls } = makeDeps("pass", "边界完整");
    deps.workspaceRoot = () => "C:\\x";
    const reads: string[] = [];
    const reviewer = makeRunSuccessReviewer(deps, vscodeNone, async (p) => {
      reads.push(p);
      return "print(1)";
    });
    await reviewer(makeEvent("C:\\x\\a.py"));
    expect(reads).toEqual(["C:\\x\\a.py"]);
    expect(urls[0]).toBe("http://t/api/reviews/request");
    const body = posts[0] as { filePath: string; commitHash: string; code: string };
    expect(body.filePath).toBe("a.py");
    expect(body.commitHash).toBe("abc1234");
    expect(body.code).toContain("print(1)");
    expect(notices[0][0]).toContain("评审通过");
  });

  it("无 payload.file → 活动编辑器兜底发起评审", async () => {
    const { deps, notices, posts } = makeDeps("pass");
    deps.workspaceRoot = () => "C:\\x";
    const vscode = { window: { activeTextEditor: { document: { uri: { fsPath: "C:\\x\\b.py" } } } } } as unknown as typeof import("vscode");
    const reviewer = makeRunSuccessReviewer(deps, vscode, async () => "print(1)");
    await reviewer(makeEvent());
    expect((posts[0] as { filePath: string }).filePath).toBe("b.py");
    expect(notices[0][0]).toContain("评审通过");
  });

  it("fetch 拒绝 → error 静默，不向调用方抛出", async () => {
    const { deps, notices } = makeDeps("pass");
    deps.fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const reviewer = makeRunSuccessReviewer(deps, vscodeNone, async () => "print(1)");
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
