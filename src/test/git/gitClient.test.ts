import { describe, it, expect } from "vitest";
import { createGitClient, GitError, type ExecFn } from "../../git/gitClient";

// ── git CLI 封装：fake exec 注入，不触真实 git ───────────────────────────

describe("createGitClient", () => {
  it("run 成功 → 返回 stdout，且以 git + 原始参数 + 指定 cwd 调用", async () => {
    const calls: { file: string; args: string[]; cwd: string }[] = [];
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args: [...args], cwd: opts.cwd });
      return { stdout: "main\n", stderr: "" };
    };
    const git = createGitClient("C:/ws", exec);

    await expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"])).resolves.toBe("main\n");
    expect(calls).toEqual([{ file: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "C:/ws" }]);
  });

  it("非 0 退出 → 抛 GitError，message 取 stderr，stdout/stderr 均保留", async () => {
    const exec: ExecFn = async () => {
      const err = new Error("git exited with code 128") as Error & { stdout: string; stderr: string };
      err.stdout = "partial output";
      err.stderr = "fatal: not a git repository";
      throw err;
    };
    const git = createGitClient("C:/ws", exec);

    const caught = await git.run(["status"]).then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(GitError);
    const gitErr = caught as GitError;
    expect(gitErr.message).toBe("fatal: not a git repository");
    expect(gitErr.stderr).toBe("fatal: not a git repository");
    expect(gitErr.stdout).toBe("partial output");
  });
});
