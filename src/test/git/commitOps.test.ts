import { describe, it, expect } from "vitest";
import { createGitClient, type ExecFn } from "../../git/gitClient";
import { submitAll, countDeleted, type SubmitDeps } from "../../git/commitOps";

// ── 提交原语：recorder 模式，按参数路由返回值，记录完整调用序列 ───────────

interface Opts {
  currentBranch?: string;
  status?: string;
  commitFail?: { stdout?: string; stderr?: string };
  rebaseFail?: boolean;
  firstPush?: boolean;   // 首推场景：远端学生分支尚不存在（首次 push 才创建）
  pushFail?: boolean;
  confirmDelete?: (n: number) => Promise<boolean>;
}

function makeDeps(opts?: Opts) {
  const calls: string[][] = [];
  const confirmCalls: number[] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push([...args]);
    const c = args.join(" ");
    if (c === "rev-parse --abbrev-ref HEAD") return { stdout: (opts?.currentBranch ?? "student-2025001") + "\n", stderr: "" };
    if (c === "status --porcelain") return { stdout: opts?.status ?? "M week-01/a.py\n", stderr: "" };
    if (c === "add -A") return { stdout: "", stderr: "" };
    if (c.startsWith("commit -m")) {
      if (opts?.commitFail) {
        const err = new Error(opts.commitFail.stderr || "git failed") as Error & { stdout: string; stderr: string };
        err.stdout = opts.commitFail.stdout ?? "";
        err.stderr = opts.commitFail.stderr ?? "";
        throw err;
      }
      return { stdout: "", stderr: "" };
    }
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
    if (c === "rev-parse HEAD") return { stdout: "feedc0de\n", stderr: "" };
    if (c === "rev-parse --verify origin/student-2025001") {
      if (opts?.firstPush) {
        const err = new Error("git exited with code 128") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "fatal: Invalid revision ref 'origin/student-2025001'";
        throw err;
      }
      return { stdout: "remote123\n", stderr: "" };
    }
    if (c === "rev-parse origin/student-2025001") {
      if (opts?.firstPush) {   // 首推：远端无分支 → 实现应走 ls-files 兜底
        const err = new Error("git exited with code 128") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "fatal: Invalid revision ref 'origin/student-2025001'";
        throw err;
      }
      return { stdout: "remote123\n", stderr: "" };
    }
    if (c === "ls-files") return { stdout: "week-01/a.py\n", stderr: "" };
    if (c === "diff --name-only remote123 HEAD") return { stdout: "week-01/a.py\n", stderr: "" };
    if (c.startsWith("push ")) {
      if (opts?.pushFail) {
        const err = new Error("git exited with code 128") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "fatal: unable to access 'https://gitea.example/': connection refused";
        throw err;
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`no route for: git ${c}`);
  };
  const deps: SubmitDeps = {
    git: createGitClient("C:/ws", exec),
    studentId: "2025001",
    studentName: "张三",
    remoteWithBasic: () => "https://2025001:tok@gitea.example/org/hw.git",
    confirmDelete: opts?.confirmDelete
      ? async (n: number) => { confirmCalls.push(n); return opts.confirmDelete!(n); }
      : undefined,
  };
  return { deps, calls, confirmCalls };
}

const joined = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("submitAll", () => {
  it("正常链路 → ok，git 严格按序：断言→status→add→commit→fetch→守卫→rebase→rev-parse→diff→push（notify 已退役）", async () => {
    const { deps, calls } = makeDeps();

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "ok" });
    expect(joined(calls)).toEqual([
      "rev-parse --abbrev-ref HEAD",
      "status --porcelain",
      "add -A",
      "commit -m submit: workspace by 2025001 张三 --author=2025001 张三 <2025001@classroom>",
      "fetch origin",
      "rev-parse --verify origin/student-2025001",
      "rebase origin/student-2025001",
      "rev-parse HEAD",
      "rev-parse origin/student-2025001",
      "diff --name-only remote123 HEAD",
      "push https://2025001:tok@gitea.example/org/hw.git HEAD:refs/heads/student-2025001",
    ]);
  });

  it("首推（远端学生分支不存在）→ 跳过 rebase + ls-files 全量清单 + push 创建远端分支 → ok", async () => {
    const { deps, calls } = makeDeps({ firstPush: true });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "ok" });
    expect(joined(calls)).toEqual([
      "rev-parse --abbrev-ref HEAD",
      "status --porcelain",
      "add -A",
      "commit -m submit: workspace by 2025001 张三 --author=2025001 张三 <2025001@classroom>",
      "fetch origin",
      "rev-parse --verify origin/student-2025001",
      "rev-parse HEAD",
      "rev-parse origin/student-2025001",
      "ls-files",
      "push https://2025001:tok@gitea.example/org/hw.git HEAD:refs/heads/student-2025001",
    ]);
    expect(joined(calls).some((c) => c.startsWith("rebase"))).toBe(false);
  });

  it("nothing to commit → { kind: nothing }，不 fetch/rebase/push（天然幂等）", async () => {
    const { deps, calls } = makeDeps({
      commitFail: { stdout: "On branch student-2025001\nnothing to commit, working tree clean", stderr: "" },
    });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "nothing" });
    const seq = joined(calls);
    expect(seq[seq.length - 1]).toContain("commit -m");
    expect(seq.some((c) => c.startsWith("fetch") || c.startsWith("push"))).toBe(false);
  });

  it("分支不匹配（在 main 上）→ branchMismatch，仅断言分支后即停", async () => {
    const { deps, calls } = makeDeps({ currentBranch: "main" });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "branchMismatch" });
    expect(joined(calls)).toEqual(["rev-parse --abbrev-ref HEAD"]);
  });

  it("status 含 D 条目 + confirmDelete=false → deleteCancelled，不 add", async () => {
    const { deps, calls, confirmCalls } = makeDeps({
      status: "D  week-02/old.py\n M week-01/a.py\n",
      confirmDelete: async () => false,
    });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "deleteCancelled" });
    expect(confirmCalls).toEqual([1]);
    expect(joined(calls)).toEqual(["rev-parse --abbrev-ref HEAD", "status --porcelain"]);
  });

  it("status 含 D 条目 + confirmDelete=true → 正常提交到 ok", async () => {
    const { deps, calls, confirmCalls } = makeDeps({
      status: "D  week-02/old.py\n",
      confirmDelete: async () => true,
    });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "ok" });
    expect(confirmCalls).toEqual([1]);
    expect(joined(calls)).toContain("add -A");
  });

  it("rebase 冲突 → rebase --abort 后返回 rebaseConflict，不 push", async () => {
    const { deps, calls } = makeDeps({ rebaseFail: true });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "rebaseConflict" });
    const seq = joined(calls);
    const rebaseIdx = seq.indexOf("rebase origin/student-2025001");
    expect(rebaseIdx).toBeGreaterThan(-1);
    expect(seq[rebaseIdx + 1]).toBe("rebase --abort");
    expect(seq[seq.length - 1]).toBe("rebase --abort");
    expect(seq.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("push 失败 → pushFailed，本地提交保留（无 reset/abort 等撤销动作）", async () => {
    const { deps, calls } = makeDeps({ pushFail: true });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "pushFailed" });
    const seq = joined(calls);
    expect(seq[seq.length - 1]).toContain("push ");
    expect(seq.some((c) => c.startsWith("reset") || c.startsWith("rebase --abort"))).toBe(false);
  });

  it("status 含 MD 条目（暂存修改+工作区删除）→ 同样触发删除确认（Task 345 缺口回归）", async () => {
    const { deps, calls, confirmCalls } = makeDeps({
      status: "MD week-02/old.py\n",
      confirmDelete: async () => false,
    });

    const res = await submitAll(deps);

    expect(res).toEqual({ kind: "deleteCancelled" });
    expect(confirmCalls).toEqual([1]);
    expect(joined(calls)).toEqual(["rev-parse --abbrev-ref HEAD", "status --porcelain"]);
  });
});

describe("countDeleted（porcelain 删除检测，X/Y 任一位为 D）", () => {
  it.each([
    ["D  week-02/a.py\n", 1],      // 暂存删除
    [" D week-02/a.py\n", 1],      // 工作区删除
    ["MD week-01/a.py\n", 1],      // 暂存修改 + 工作区删除（旧正则漏检）
    ["AD week-01/a.py\n", 1],      // 暂存新增 + 工作区删除
    [" M week-01/a.py\n", 0],
    ["A  week-01/new.py\n", 0],
    ["?? notes.md\n", 0],
    ["R  old.py -> new.py\n", 0],
    ["D  a.py\n D b.py\nMD c.py\n M d.py\n", 3],
  ])("%j → %i", (status, n) => {
    expect(countDeleted(status)).toBe(n);
  });
});
