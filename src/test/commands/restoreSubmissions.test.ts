import { describe, it, expect, vi } from "vitest";
import { restoreSubmissions } from "../../commands/restoreSubmissions";

function makeDeps(over: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  const publishedFetch = vi.fn(async () => ({
    ok: true,
    json: async () => [
      {
        id: "a1", title: "第 1 周作业", week: 1,
        exercises: [
          { id: "e1", filename: "exercise-01.py" },
          { id: "e2", filename: "test-01.py" },
        ],
      },
    ],
  }));
  const submissionsFetch = vi.fn(async () => ({
    ok: true,
    // 服务端按 submitted_at 降序：e1 最新是 B，A 是旧版
    json: async () => [
      { exerciseId: "e1", code: "print('B')", submittedAt: 200 },
      { exerciseId: "e1", code: "print('A')", submittedAt: 100 },
      { exerciseId: "e2", code: "print('C')", submittedAt: 150 },
      { exerciseId: "e9", code: "print('X')", submittedAt: 120 },
    ],
  }));
  const fetchImpl = vi.fn(async (url: string) =>
    url.includes("/submissions/student") ? submissionsFetch() : publishedFetch()
  );
  return {
    files,
    deps: {
      teacherUrl: () => "http://t:3000",
      getStudentId: () => "0001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFile: async (rel: string) => files.get(rel) ?? null,
      writeFile: async (rel: string, content: string) => { files.set(rel, content); },
      ...over,
    } as never,
  };
}

describe("restoreSubmissions（恢复我的提交）", () => {
  it("每个练习取最近一次提交写回；一致跳过；未映射计入 unmapped", async () => {
    const { deps, files } = makeDeps();
    files.set("week-01/test-01.py", "print('C')");   // 与最新提交一致 → identical
    const r = await restoreSubmissions(deps);
    expect(r.restored).toEqual(["week-01/exercise-01.py"]);
    expect(files.get("week-01/exercise-01.py")).toBe("print('B')");   // 最新版，非旧版 A
    expect(r.identical).toEqual(["week-01/test-01.py"]);
    expect(r.unmapped).toHaveLength(1);
  });

  it("confirm 返回 false → cancelled，不写任何文件", async () => {
    const { deps, files } = makeDeps();
    const r = await restoreSubmissions({
      ...deps,
      confirm: async () => false,
    } as never);
    expect(r.cancelled).toBe(true);
    expect(r.restored).toHaveLength(0);
    expect(files.size).toBe(0);
  });

  it("confirm 返回 true → 正常写入", async () => {
    const { deps, files } = makeDeps();
    const r = await restoreSubmissions({ ...deps, confirm: async () => true } as never);
    expect(r.cancelled).toBeUndefined();
    expect(r.restored).toEqual(["week-01/exercise-01.py", "week-01/test-01.py"]);
    expect(files.get("week-01/exercise-01.py")).toBe("print('B')");
    expect(files.get("week-01/test-01.py")).toBe("print('C')");
  });

  it("未设身份 → 抛 identity-missing（命令层转为友好提示）", async () => {
    const { deps } = makeDeps({ getStudentId: () => null });
    await expect(restoreSubmissions(deps)).rejects.toThrow("identity-missing");
  });

  it("服务端不可达 → 抛错（命令层显示恢复失败）", async () => {
    const { deps } = makeDeps({ fetchImpl: vi.fn(async () => { throw new Error("down"); }) });
    await expect(restoreSubmissions(deps)).rejects.toThrow();
  });
});
