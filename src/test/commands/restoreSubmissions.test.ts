import { describe, it, expect, vi } from "vitest";
import { restoreSubmissions, makeRestoreCommand } from "../../commands/restoreSubmissions";

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

// ── makeRestoreCommand（恢复 + 补全未交题目）─────────────────────────────
const PUB = [
  { id: "a1", title: "第一周", week: 1, exercises: [{ id: "e1", filename: "exercise-01.py" }, { id: "e2", filename: "test-01.py" }] },
  { id: "a2", title: "第二周", week: 2, exercises: [{ id: "e3", filename: "exercise-01.py" }] },
];
const SUBS = [
  { exerciseId: "e1", code: "print('B')", submittedAt: 200 },
  { exerciseId: "e2", code: "print('C')", submittedAt: 150 },
  { exerciseId: "e9", code: "print('X')", submittedAt: 120 },
];

function makeCmd(opts?: { confirmPick?: string; breakPull?: boolean }) {
  const files = new Map<string, string>();   // key: fsPath（反斜杠）
  const infos: string[] = [];
  const warns: string[] = [];
  const joinPath = (uri: { fsPath: string }, ...parts: string[]) => {
    let p = uri.fsPath;
    for (const raw of parts) {
      for (const seg of raw.split("/")) {
        if (!seg || seg === ".") continue;
        p = `${p}\\${seg}`;
      }
    }
    return { fsPath: p };
  };
  const vscode = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "C:\\ws" } }],
      fs: {
        stat: async (uri: { fsPath: string }) => {
          if (!files.has(uri.fsPath)) throw new Error("missing");
          return {};
        },
        readFile: async (uri: { fsPath: string }) => {
          if (!files.has(uri.fsPath)) throw new Error("missing");
          return new TextEncoder().encode(files.get(uri.fsPath)!);
        },
        createDirectory: async () => {},
        writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
          files.set(uri.fsPath, new TextDecoder().decode(content));
        },
      },
    },
    Uri: { joinPath },
    window: {
      showInformationMessage: (t: string) => { infos.push(t); return undefined; },
      showWarningMessage: (t: string) => { warns.push(t); return opts?.confirmPick ?? undefined; },
      showErrorMessage: (t: string) => { warns.push(`ERR:${t}`); return undefined; },
    },
  } as unknown as typeof import("vscode");
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/submissions/student")) return new Response(JSON.stringify(SUBS), { status: 200 });
    if (/\/exercises\/[^/]+\/content$/.test(u)) {
      const id = u.match(/\/exercises\/([^/]+)\/content$/)![1];
      return new Response(JSON.stringify({ kind: "file", filename: "exercise-01.py", content: `teacher-${id}` }), { status: 200 });
    }
    return new Response(JSON.stringify(PUB), { status: 200 });
  }) as unknown as typeof fetch;
  const store = {
    get: (key: string) => {
      if (key === "pylearner.identity.studentId") return "0001";
      if (key === "pylearner.identity.studentName") return "张三";
      return undefined;
    },
    update: async (key: string) => { if (opts?.breakPull && key === "pylearner.pull.versions") throw new Error("store down"); },
  };
  const cmd = makeRestoreCommand({ teacherUrl: () => "http://t", globalState: store, fetchImpl }, vscode);
  return { cmd, files, infos, warns };
}

describe("makeRestoreCommand（恢复 + 自动补全未交题目）", () => {
  it("先恢复后补全 → 合并通知；已交文件=你的版本，未交缺失文件=教师原始版", async () => {
    const { cmd, files, infos, warns } = makeCmd({ confirmPick: "恢复" });
    files.set("C:\\ws\\week-01\\test-01.py", "print('C')");   // 与最新提交一致 → identical
    await cmd();
    expect(infos).toEqual([
      "已恢复 1 个（你的提交） · 1 个与本地一致 · 补全 1 个（未交题目） · 1 个提交找不到对应练习（题目可能已下线）",
    ]);
    expect(files.get("C:\\ws\\week-01\\exercise-01.py")).toBe("print('B')");   // 恢复=你的提交
    expect(files.get("C:\\ws\\week-02\\exercise-01.py")).toBe("teacher-e3");   // 补全=教师原始版
    expect(warns).toEqual(["将从服务端恢复 1 个作业文件（覆盖为你的最近一次提交）：\nweek-01/exercise-01.py"]);   // 仅确认弹窗，无额外警告
  });

  it("取消恢复 → 不补全，仅提示已取消", async () => {
    const { cmd, files, infos, warns } = makeCmd();
    await cmd();
    expect(infos).toEqual(["已取消恢复"]);
    expect(files.has("C:\\ws\\week-01\\exercise-01.py")).toBe(false);
    expect(files.has("C:\\ws\\week-02\\exercise-01.py")).toBe(false);
    expect(warns).toEqual(["将从服务端恢复 2 个作业文件（覆盖为你的最近一次提交）：\nweek-01/exercise-01.py\nweek-01/test-01.py"]);   // 仅弹窗本身
  });

  it("补全失败 → 仍有恢复汇总 + 警告指引手动拉取", async () => {
    const { cmd, infos, warns } = makeCmd({ confirmPick: "恢复", breakPull: true });
    await cmd();
    expect(infos[0]).toContain("已恢复 2 个（你的提交）");
    expect(infos[0]).toContain("补全 0 个（未交题目）");
    expect(warns.some((w) => w.includes("补全未交题目失败") && w.includes("store down"))).toBe(true);
  });
});
