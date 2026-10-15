import { describe, it, expect } from "vitest";
import { createGitClient, type ExecFn } from "../../git/gitClient";
import { pullNewOnly } from "../../git/pullOps";

// ── 只新增拉取：recorder 模式，断言调用顺序（rebase 必须先于 diff）────────

interface Route {
  match: (args: string[]) => boolean;
  stdout?: string;
  fail?: { stderr?: string; message?: string };
}

function makeRecorder(routes: Route[]) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push([...args]);
    const route = routes.find((r) => r.match(args));
    if (!route) throw new Error(`no route for: git ${args.join(" ")}`);
    if (route.fail) {
      const err = new Error(route.fail.message ?? "git failed") as Error & { stdout: string; stderr: string };
      err.stdout = "";
      err.stderr = route.fail.stderr ?? "";
      throw err;
    }
    return { stdout: route.stdout ?? "", stderr: "" };
  };
  return { calls, git: createGitClient("C:/ws", exec) };
}

const cmd = (s: string) => (args: string[]) => args.join(" ") === s;
const joined = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("pullNewOnly", () => {
  it("有新增 → fetch → 守卫通过 → rebase(先于 diff) → diff(只新增) → checkout → commit，返回新增清单", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("rev-parse --verify origin/student-2025001"), stdout: "abc123\n" },
      { match: cmd("rebase origin/student-2025001") },
      { match: cmd("diff --diff-filter=A --name-only HEAD origin/main"), stdout: "week-03/01-new.py\nweek-04/readme.md\n" },
      { match: cmd("checkout origin/main -- week-03/01-new.py week-04/readme.md") },
      { match: cmd("commit -m pull: 2 new file(s) from main") },
    ]);

    const res = await pullNewOnly(git, "2025001");

    const seq = joined(calls);
    expect(seq).toEqual([
      "fetch origin",
      "rev-parse --verify origin/student-2025001",
      "rebase origin/student-2025001",
      "diff --diff-filter=A --name-only HEAD origin/main",
      "checkout origin/main -- week-03/01-new.py week-04/readme.md",
      "commit -m pull: 2 new file(s) from main",
    ]);
    expect(seq.findIndex((c) => c.startsWith("rebase"))).toBeLessThan(seq.findIndex((c) => c.startsWith("diff")));
    expect(res).toEqual({ pulled: ["week-03/01-new.py", "week-04/readme.md"] });
  });

  it("无新增 → 守卫通过后 rebase，不 checkout 不 commit，返回空清单", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("rev-parse --verify origin/student-2025001"), stdout: "abc123\n" },
      { match: cmd("rebase origin/student-2025001") },
      { match: cmd("diff --diff-filter=A --name-only HEAD origin/main"), stdout: "  \n" },
    ]);

    const res = await pullNewOnly(git, "2025001");

    expect(joined(calls)).toEqual([
      "fetch origin",
      "rev-parse --verify origin/student-2025001",
      "rebase origin/student-2025001",
      "diff --diff-filter=A --name-only HEAD origin/main",
    ]);
    expect(res).toEqual({ pulled: [] });
  });

  it("首用（远端学生分支不存在）→ rev-parse --verify 失败跳过 rebase，直接 diff 只新增", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("rev-parse --verify origin/student-2025001"), fail: { stderr: "fatal: Invalid revision ref origin/student-2025001" } },
      { match: cmd("diff --diff-filter=A --name-only HEAD origin/main"), stdout: "week-03/01-new.py\n" },
      { match: cmd("checkout origin/main -- week-03/01-new.py") },
      { match: cmd("commit -m pull: 1 new file(s) from main") },
    ]);

    const res = await pullNewOnly(git, "2025001");

    const seq = joined(calls);
    expect(seq).toEqual([
      "fetch origin",
      "rev-parse --verify origin/student-2025001",
      "diff --diff-filter=A --name-only HEAD origin/main",
      "checkout origin/main -- week-03/01-new.py",
      "commit -m pull: 1 new file(s) from main",
    ]);
    expect(seq.some((c) => c.startsWith("rebase"))).toBe(false);
    expect(res).toEqual({ pulled: ["week-03/01-new.py"] });
  });
});
