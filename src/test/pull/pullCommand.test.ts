import { describe, it, expect, vi } from "vitest";
import { pullAssignments } from "../../pull/pullCommand";

function makeDeps(over: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  const state = new Map<string, unknown>();
  const contentFetch = vi.fn(async () => ({ ok: true, text: async () => "# exercise-id: x\nprint(1)\n" }));
  const listFetch = vi.fn(async () => ({
    ok: true,
    json: async () => [{
      id: "a1", title: "第 1 周作业", week: 1,
      exercises: [
        { id: "e1", filename: "exercise-01.py", versionHash: "v1" },
        { id: "e2", filename: "exercise-02.py", versionHash: "v1" },
      ],
    }],
  }));
  const fetchImpl = vi.fn(async (url: string) => url.includes("/content") ? contentFetch() : listFetch());
  return {
    files, state,
    deps: {
      teacherUrl: () => "http://t:3000",
      globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => state.set(k, v) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fileExists: async (rel: string) => files.has(rel),
      writeFile: async (rel: string, content: string) => { files.set(rel, content); },
      ...over,
    } as never,
  };
}

describe("pullAssignments（A26/A30）", () => {
  it("缺失文件下载到 week-NN/，版本记录；已有文件跳过不下载", async () => {
    const { deps, files, state } = makeDeps();
    files.set("week-01/exercise-02.py", "# 学生已写\n");       // 已存在 → 跳过
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(1);
    expect(files.get("week-01/exercise-01.py")).toContain("print(1)");
    expect(files.get("week-01/exercise-02.py")).toBe("# 学生已写\n");   // 绝不覆盖
    const versions = state.get("pylearner.pull.versions") as Record<string, string>;
    expect(versions.e1).toBe("v1");
    expect(versions.e2).toBe("v1");
  });
  it("versionHash 变化 → 仅通知不覆盖（A30）；无变化无通知", async () => {
    const { deps, files, state } = makeDeps();
    state.set("pylearner.pull.versions", { e1: "v0", e2: "v1" });
    files.set("week-01/exercise-01.py", "旧内容");
    files.set("week-01/exercise-02.py", "内容");
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(0);
    expect(r.updateNotices).toEqual(["week-01/exercise-01.py 题目已更新，本地文件未改动，请注意最新要求"]);
    expect(files.get("week-01/exercise-01.py")).toBe("旧内容");
    expect((state.get("pylearner.pull.versions") as Record<string, string>).e1).toBe("v1");  // 版本记录更新
  });
  it("服务端不可达 → 抛错（调用方显示重试指引）", async () => {
    const { deps } = makeDeps({ fetchImpl: vi.fn(async () => { throw new Error("down"); }) });
    await expect(pullAssignments(deps)).rejects.toThrow();
  });
});
