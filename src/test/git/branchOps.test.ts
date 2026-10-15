import { describe, it, expect } from "vitest";
import { createGitClient, type ExecFn } from "../../git/gitClient";
import { ensureStudentBranch, assertCurrentBranch, cleanIgnored, remoteStudentBranchExists } from "../../git/branchOps";

// ── 分支保障：recorder 模式，fake exec 记录调用序列并按参数路由返回值 ──────

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

describe("ensureStudentBranch", () => {
  it("本地无 + 远端无 → 自 origin/main 建分支并 checkout（新学生首用）", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("branch --list student-2025001") },
      { match: cmd("rev-parse --verify origin/student-2025001"), fail: { stderr: "fatal: ambiguous argument 'origin/student-2025001'" } },
      { match: cmd("branch student-2025001 origin/main") },
      { match: cmd("checkout student-2025001") },
    ]);

    await ensureStudentBranch(git, "2025001");

    expect(joined(calls)).toEqual([
      "fetch origin",
      "branch --list student-2025001",
      "rev-parse --verify origin/student-2025001",
      "branch student-2025001 origin/main",
      "checkout student-2025001",
    ]);
  });

  it("本地无 + 远端有 → 基于 origin/student-X 建（换电脑场景，保住历史）", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("branch --list student-2025001") },
      { match: cmd("rev-parse --verify origin/student-2025001"), stdout: "a1b2c3d\n" },
      { match: cmd("branch student-2025001 origin/student-2025001") },
      { match: cmd("checkout student-2025001") },
    ]);

    await ensureStudentBranch(git, "2025001");

    expect(joined(calls)).toEqual([
      "fetch origin",
      "branch --list student-2025001",
      "rev-parse --verify origin/student-2025001",
      "branch student-2025001 origin/student-2025001",
      "checkout student-2025001",
    ]);
  });

  it("本地已有 → 不建分支直接 checkout（不触碰 rev-parse）", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("branch --list student-2025001"), stdout: "* student-2025001\n" },
      { match: cmd("checkout student-2025001") },
    ]);

    await ensureStudentBranch(git, "2025001");

    expect(joined(calls)).toEqual([
      "fetch origin",
      "branch --list student-2025001",
      "checkout student-2025001",
    ]);
  });

  it("F1 幂等：同一入口重复调用 → 第二次不再建分支（branch 创建仅一次，checkout 可重复）", async () => {
    const calls: string[][] = [];
    let created = false;   // 模拟本地分支状态：首次 branch 创建后 --list 可见
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      const c = args.join(" ");
      if (c === "fetch origin") return { stdout: "", stderr: "" };
      if (c === "branch --list student-2025001") return { stdout: created ? "* student-2025001\n" : "", stderr: "" };
      if (c === "rev-parse --verify origin/student-2025001") {
        const err = new Error("git failed") as Error & { stdout: string; stderr: string };
        err.stdout = ""; err.stderr = "fatal: ambiguous argument 'origin/student-2025001'";
        throw err;   // 新学生首用：远端无分支
      }
      if (c === "branch student-2025001 origin/main") { created = true; return { stdout: "", stderr: "" }; }
      if (c === "checkout student-2025001") return { stdout: "", stderr: "" };
      throw new Error(`no route for: git ${c}`);
    };
    const git = createGitClient("C:/ws", exec);

    await ensureStudentBranch(git, "2025001");
    await ensureStudentBranch(git, "2025001");   // 命令体/入口重复保障（幂等）

    const seq = joined(calls);
    expect(seq.filter((c) => c === "branch student-2025001 origin/main")).toHaveLength(1);
    expect(seq.filter((c) => c === "checkout student-2025001")).toHaveLength(2);
    expect(seq.filter((c) => c.startsWith("rev-parse --verify"))).toHaveLength(1);   // 第二次走"本地已有"短路
  });
});

describe("assertCurrentBranch", () => {
  it("当前分支匹配 student-X → true", async () => {
    const { git } = makeRecorder([
      { match: cmd("rev-parse --abbrev-ref HEAD"), stdout: "student-2025001\n" },
    ]);
    await expect(assertCurrentBranch(git, "2025001")).resolves.toBe(true);
  });

  it("当前分支不匹配（如 main）→ false", async () => {
    const { git } = makeRecorder([
      { match: cmd("rev-parse --abbrev-ref HEAD"), stdout: "main\n" },
    ]);
    await expect(assertCurrentBranch(git, "2025001")).resolves.toBe(false);
  });
});

describe("cleanIgnored / remoteStudentBranchExists（spec 4.6 切换辅助）", () => {
  it("cleanIgnored → clean -fdX", async () => {
    const { calls, git } = makeRecorder([{ match: cmd("clean -fdX") }]);
    await cleanIgnored(git);
    expect(joined(calls)).toEqual(["clean -fdX"]);
  });

  it("远端学生分支存在 → true；rev-parse 失败 → false", async () => {
    const exists = makeRecorder([
      { match: cmd("rev-parse --verify origin/student-2025001"), stdout: "a1b2c3d\n" },
    ]);
    await expect(remoteStudentBranchExists(exists.git, "2025001")).resolves.toBe(true);

    const missing = makeRecorder([
      { match: cmd("rev-parse --verify origin/student-2025002"), fail: { stderr: "fatal: ambiguous argument" } },
    ]);
    await expect(remoteStudentBranchExists(missing.git, "2025002")).resolves.toBe(false);
  });
});
