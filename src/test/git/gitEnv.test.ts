import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remoteWithBasic, probeGit, isGitWorkTree, bootstrapClone, clearUntrackedCollisions, updateOriginUrl, configureCommitter, configureStudentFetchRefSpec, disableNativeGitUi } from "../../git/gitEnv";
import { createGitClient, type ExecFn } from "../../git/gitClient";

const okExec = (async () => ({ stdout: "", stderr: "" })) as unknown as ExecFn;
const failExec = (async () => { throw new Error("ENOENT"); }) as unknown as ExecFn;

describe("remoteWithBasic", () => {
  it("https URL 前缀替换为「学号:密码」Basic 凭证形式", () => {
    expect(remoteWithBasic("https://gitea.example.com/org/hw.git", "2025001", "tok123"))
      .toBe("https://2025001:tok123@gitea.example.com/org/hw.git");
  });

  it("密码含特殊字符原样嵌入不转义", () => {
    expect(remoteWithBasic("https://gitea.example.com/org/hw.git", "2025001", "a1b2+c3/d=~_x"))
      .toBe("https://2025001:a1b2+c3/d=~_x@gitea.example.com/org/hw.git");
  });

  it("只替换协议段的 ://，端口冒号不受影响", () => {
    expect(remoteWithBasic("https://gitea.example.com:8443/org/hw.git", "2025001", "t"))
      .toBe("https://2025001:t@gitea.example.com:8443/org/hw.git");
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
  it("新学生（远端无分支）→ 严格按序 init → config → remote add → fetch → 探测落点 → checkout -B main，并写含 .vscode/ 规则的 .gitignore", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    try {
      const calls: string[][] = [];
      const exec: ExecFn = async (_file, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };

      await bootstrapClone(dir, "https://oauth2:tok@gitea.example/org/hw.git", "2025001", exec);

      expect(calls.map((c) => c.join(" "))).toEqual([
        "init",
        "config core.quotepath false",   // 中文文件名不转义，diff --name-only 清单与 checkout 路径可直用
        "remote add origin https://oauth2:tok@gitea.example/org/hw.git",
        "config --replace-all remote.origin.fetch +refs/heads/main:refs/remotes/origin/main",
        "config --add remote.origin.fetch +refs/heads/student-2025001:refs/remotes/origin/student-2025001",
        "fetch origin",
        "rev-parse --verify origin/student-2025001",   // 落点探测：远程学生分支不存在
        "checkout -B main origin/main",
      ]);
      expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("__pycache__/\n*.pyc\n.venv/\n.vscode/\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("老学生（远端分支已存在，换电脑/重装）→ 直接落到自己分支（与一键换机同语义，绕开 main 中转的自产文件碰撞）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    try {
      const calls: string[][] = [];
      const exec: ExecFn = async (_file, args) => {
        calls.push([...args]);
        if (args.join(" ") === "rev-parse --verify origin/student-2025001") return { stdout: "a1b2c3d\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };

      await bootstrapClone(dir, "https://oauth2:tok@gitea.example/org/hw.git", "2025001", exec);

      const seq = calls.map((c) => c.join(" "));
      expect(seq).toContain("checkout -B student-2025001 --track origin/student-2025001");
      expect(seq.some((c) => c === "checkout -B main origin/main")).toBe(false);
      expect(seq.indexOf("rev-parse --verify origin/student-2025001")).toBeLessThan(seq.indexOf("checkout -B student-2025001 --track origin/student-2025001"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已存在 .gitignore（题库 main / 学生分支自带）→ 不覆写（覆写会让 tracked 文件变已修改，拉取 rebase 被脏工作区拒绝）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    try {
      const exec: ExecFn = (async () => ({ stdout: "", stderr: "" })) as unknown as ExecFn;
      fs.writeFileSync(path.join(dir, ".gitignore"), "# Python\n__pycache__/\n", "utf8");

      await bootstrapClone(dir, "https://oauth2:tok@gitea.example/org/hw.git", "2025001", exec);

      expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("# Python\n__pycache__/\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetch 失败 → 抛错且不写 .gitignore（引导失败由调用方提示，不落地半初始化状态之外的动作）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    try {
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

      await expect(bootstrapClone(dir, "https://oauth2:tok@gitea.example/org/hw.git", "2025001", exec)).rejects.toThrow();
      expect(calls.map((c) => c.join(" "))).toEqual([
        "init",
        "config core.quotepath false",
        "remote add origin https://oauth2:tok@gitea.example/org/hw.git",
        "config --replace-all remote.origin.fetch +refs/heads/main:refs/remotes/origin/main",
        "config --add remote.origin.fetch +refs/heads/student-2025001:refs/remotes/origin/student-2025001",
        "fetch origin",
      ]);
      expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearUntrackedCollisions（目标树 tracked 的白名单文件，清掉本地未跟踪副本防 checkout/rebase 被拦截）", () => {
  const LS_TREE = ["ls-tree", "--name-only", "student-2025001", "--", ".gitignore", ".vscode/settings.json"];

  function makeGit(lsTreeStdout: string) {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      if (args[0] === "ls-tree") return { stdout: lsTreeStdout, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    return { calls, git: createGitClient("C:/ws", exec) };
  }

  it("目标树 tracked 白名单文件 → clean -fx 精确清道（仅限命中路径）", async () => {
    const { calls, git } = makeGit(".gitignore\n.vscode/settings.json\n");

    await clearUntrackedCollisions(git, "student-2025001", [".gitignore", ".vscode/settings.json"]);

    expect(calls.map((c) => c.join(" "))).toEqual([
      "ls-tree --name-only student-2025001 -- .gitignore .vscode/settings.json",
      "clean -fx -- .gitignore .vscode/settings.json",
    ]);
  });

  it("目标树部分命中 → 只清命中的（.vscode/settings.json 未被分支跟踪时保留本地副本）", async () => {
    const { calls, git } = makeGit(".gitignore\n");

    await clearUntrackedCollisions(git, "student-2025001", [".gitignore", ".vscode/settings.json"]);

    expect(calls.map((c) => c.join(" "))).toEqual([
      "ls-tree --name-only student-2025001 -- .gitignore .vscode/settings.json",
      "clean -fx -- .gitignore",
    ]);
  });

  it("目标树未跟踪白名单文件 → 零动作（不发起 clean，防 __pycache__ 失去忽略规则）", async () => {
    const { calls, git } = makeGit("");

    await clearUntrackedCollisions(git, "student-2025001", [".gitignore", ".vscode/settings.json"]);

    expect(calls.map((c) => c.join(" "))).toEqual([
      "ls-tree --name-only student-2025001 -- .gitignore .vscode/settings.json",
    ]);
  });

  it("空路径清单 → 不发起任何 git 调用", async () => {
    const { calls, git } = makeGit("");

    await clearUntrackedCollisions(git, "student-2025001", []);

    expect(calls).toEqual([]);
  });
});

describe("configureCommitter（F2：机房批量安装的 git 默认无全局身份，commit --author 只覆盖 author，committer 缺失被 git 拒绝）", () => {
  it("local config 写 user.name=学号 + user.email=学号@classroom，按序两条", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
    const { createGitClient } = await import("../../git/gitClient");

    await configureCommitter(createGitClient("C:/ws", exec), "2025001");

    expect(calls.map((c) => c.join(" "))).toEqual([
      "config user.name 2025001",
      "config user.email 2025001@classroom",
    ]);
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

describe("configureStudentFetchRefSpec（fetch 收敛：只拉 main + 本人分支，不背全班历史）", () => {
  it("按序两条：--replace-all 覆盖默认全量通配为 main，--add 补本人分支", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };

    await configureStudentFetchRefSpec(createGitClient("C:/ws", exec), "2025001");

    expect(calls.map((c) => c.join(" "))).toEqual([
      "config --replace-all remote.origin.fetch +refs/heads/main:refs/remotes/origin/main",
      "config --add remote.origin.fetch +refs/heads/student-2025001:refs/remotes/origin/student-2025001",
    ]);
  });
});

describe("disableNativeGitUi（工作区 settings.json 写 git.enabled=false，关闭内置 Git 扩展，摘掉切他人分支的便捷通道）", () => {
  it("无 .vscode 目录 → 创建 settings.json 且仅含 git.enabled=false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));

    disableNativeGitUi(dir);

    const written = JSON.parse(fs.readFileSync(path.join(dir, ".vscode", "settings.json"), "utf8"));
    expect(written).toEqual({ "git.enabled": false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("已有其他配置 → 合并保留，git.enabled 强制 false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".vscode", "settings.json"),
      JSON.stringify({ "editor.fontSize": 14, "git.enabled": true }),
      "utf8",
    );

    disableNativeGitUi(dir);

    const written = JSON.parse(fs.readFileSync(path.join(dir, ".vscode", "settings.json"), "utf8"));
    expect(written).toEqual({ "editor.fontSize": 14, "git.enabled": false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("已是 false → 零写入（内容含其他配置原样保留，不重写）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    const file = path.join(dir, ".vscode", "settings.json");
    fs.writeFileSync(file, `{\n  "git.enabled": false,\n  "editor.tabSize": 2\n}\n`, "utf8");
    const before = fs.readFileSync(file, "utf8");

    disableNativeGitUi(dir);

    expect(fs.readFileSync(file, "utf8")).toBe(before);   // 零写入：字节级不变
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("settings.json 含注释解析失败 → 从空重建为 git.enabled=false（不抛错）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-gitenv-"));
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".vscode", "settings.json"), `{ // comment\n  "git.enabled": true\n}`, "utf8");

    expect(() => disableNativeGitUi(dir)).not.toThrow();

    const written = JSON.parse(fs.readFileSync(path.join(dir, ".vscode", "settings.json"), "utf8"));
    expect(written).toEqual({ "git.enabled": false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
