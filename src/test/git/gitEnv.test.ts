import { describe, it, expect } from "vitest";
import { remoteWithToken, probeGit, isGitWorkTree, bootstrapClone, updateOriginUrl } from "../../git/gitEnv";
import type { ExecFn } from "../../git/gitClient";

const okExec = (async () => ({ stdout: "", stderr: "" })) as unknown as ExecFn;
const failExec = (async () => { throw new Error("ENOENT"); }) as unknown as ExecFn;

describe("remoteWithToken", () => {
  it("https URL 前缀替换为 oauth2 凭证形式", () => {
    expect(remoteWithToken("https://gitea.example.com/org/hw.git", "tok123"))
      .toBe("https://oauth2:tok123@gitea.example.com/org/hw.git");
  });

  it("token 含特殊字符原样嵌入不转义", () => {
    expect(remoteWithToken("https://gitea.example.com/org/hw.git", "a1b2+c3/d=~_x"))
      .toBe("https://oauth2:a1b2+c3/d=~_x@gitea.example.com/org/hw.git");
  });

  it("只替换协议段的 ://，端口冒号不受影响", () => {
    expect(remoteWithToken("https://gitea.example.com:8443/org/hw.git", "t"))
      .toBe("https://oauth2:t@gitea.example.com:8443/org/hw.git");
  });
});

describe("probeGit", () => {
  it("git --version 退出 0 → true", async () => {
    const exec = (async () => ({ stdout: "git version 2.43.0", stderr: "" })) as unknown as ExecFn;
    await expect(probeGit(exec)).resolves.toBe(true);
  });

  it("git 缺失（exec 抛错）→ false", async () => {
    await expect(probeGit(failExec)).resolves.toBe(false);
  });
});

describe("isGitWorkTree", () => {
  it("rev-parse --is-inside-work-tree 成功 → true", async () => {
    await expect(isGitWorkTree("C:/ws", okExec)).resolves.toBe(true);
  });

  it("非 git 仓库（退出码非 0）→ false", async () => {
    await expect(isGitWorkTree("C:/ws", failExec)).resolves.toBe(false);
  });
});

describe("bootstrapClone（clone 要求空目录，.vscode-only 场景用 init+fetch+checkout 等价实现）", () => {
  it("严格按序 init → remote add origin → fetch → checkout -B main origin/main", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };

    await bootstrapClone("C:/ws", "https://oauth2:tok@gitea.example/org/hw.git", exec);

    expect(calls.map((c) => c.join(" "))).toEqual([
      "init",
      "remote add origin https://oauth2:tok@gitea.example/org/hw.git",
      "fetch origin",
      "checkout -B main origin/main",
    ]);
  });

  it("fetch 失败 → 抛错（引导失败由调用方提示，不落地半初始化状态之外的动作）", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      if (args.join(" ") === "fetch origin") {
        const err = new Error("git exited with code 128") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "fatal: unable to access: connection refused";
        throw err;
      }
      return { stdout: "", stderr: "" };
    };

    await expect(bootstrapClone("C:/ws", "https://oauth2:tok@gitea.example/org/hw.git", exec)).rejects.toThrow();
    expect(calls.map((c) => c.join(" "))).toEqual(["init", "remote add origin https://oauth2:tok@gitea.example/org/hw.git", "fetch origin"]);
  });
});

describe("updateOriginUrl", () => {
  it("remote set-url origin <url>", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
    const { createGitClient } = await import("../../git/gitClient");

    await updateOriginUrl(createGitClient("C:/ws", exec), "https://oauth2:newtok@gitea.example/org/hw.git");

    expect(calls.map((c) => c.join(" "))).toEqual(["remote set-url origin https://oauth2:newtok@gitea.example/org/hw.git"]);
  });
});
