import { describe, it, expect } from "vitest";
import { createGitClient, type ExecFn } from "../../git/gitClient";
import { hasLocalChanges, syncToRemoteState } from "../../git/syncOps";

// ── 同步原语：recorder 模式，fake exec 记录调用序列并按参数路由返回值 ──────

interface Opts {
  status?: string;
  rebaseFail?: boolean;
}

function makeRecorder(opts?: Opts) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push([...args]);
    const c = args.join(" ");
    if (c === "status --porcelain") return { stdout: opts?.status ?? "", stderr: "" };
    if (c.startsWith("stash push -u")) return { stdout: "", stderr: "" };
    if (c === "fetch origin") return { stdout: "", stderr: "" };
    if (c === "rebase origin/student-2025001") {
      if (opts?.rebaseFail) {
        const err = new Error("git exited with code 1") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "CONFLICT (content): Merge conflict in week-01/a.py";
        throw err;
      }
      return { stdout: "", stderr: "" };
    }
    if (c === "rebase --abort") return { stdout: "", stderr: "" };
    if (c === "checkout student-2025001 -- .") return { stdout: "", stderr: "" };
    throw new Error(`no route for: git ${c}`);
  };
  return { calls, git: createGitClient("C:/ws", exec) };
}

const joined = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("hasLocalChanges（spec 4.5 ①）", () => {
  it("porcelain 非空 → true", async () => {
    const { git } = makeRecorder({ status: " M week-01/a.py\n" });
    await expect(hasLocalChanges(git)).resolves.toBe(true);
  });

  it("工作区干净 → false", async () => {
    const { git } = makeRecorder({ status: "" });
    await expect(hasLocalChanges(git)).resolves.toBe(false);
  });
});

describe("syncToRemoteState（spec 4.5 三步）", () => {
  it("有未提交修改 → stash -u → fetch → rebase → checkout student-X -- .，stashed=true", async () => {
    const { calls, git } = makeRecorder({ status: " M week-01/a.py\n?? notes.md\n" });

    const r = await syncToRemoteState(git, "2025001");

    expect(r).toEqual({ kind: "ok", stashed: true });
    const seq = joined(calls);
    expect(seq[0]).toBe("status --porcelain");
    expect(seq[1]).toContain("stash push -u");            // -m 备注含时间戳，前缀断言
    expect(seq[2]).toBe("fetch origin");
    expect(seq[3]).toBe("rebase origin/student-2025001");
    expect(seq[4]).toBe("checkout student-2025001 -- .");
  });

  it("无修改 → 跳过 stash 直接收敛+还原，stashed=false", async () => {
    const { calls, git } = makeRecorder({ status: "" });

    const r = await syncToRemoteState(git, "2025001");

    expect(r).toEqual({ kind: "ok", stashed: false });
    expect(joined(calls)).toEqual([
      "status --porcelain",
      "fetch origin",
      "rebase origin/student-2025001",
      "checkout student-2025001 -- .",
    ]);
  });

  it("rebase 冲突 → rebase --abort 后返回 rebaseConflict，不 checkout", async () => {
    const { calls, git } = makeRecorder({ status: "", rebaseFail: true });

    const r = await syncToRemoteState(git, "2025001");

    expect(r).toEqual({ kind: "rebaseConflict" });
    const seq = joined(calls);
    expect(seq[seq.length - 1]).toBe("rebase --abort");
    expect(seq).not.toContain("checkout student-2025001 -- .");
  });
});
