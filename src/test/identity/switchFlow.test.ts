import { describe, it, expect } from "vitest";
import {
  archiveBeforeSwitch,
  refillAfterSwitch,
  semesterResetBeforeSwitch,
  type BeforeSwitchDeps,
  type AfterSwitchDeps,
} from "../../identity/switchFlow";
import { createGitClient, type ExecFn } from "../../git/gitClient";

// ── 一键换机：recorder 模式，fake exec 记录调用序列并按参数路由返回值 ──────

interface Route {
  match: (args: string[]) => boolean;
  stdout?: string;
  fail?: { stdout?: string; stderr?: string; message?: string };
}

function makeRecorder(routes: Route[]) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push([...args]);
    const route = routes.find((r) => r.match(args));
    if (!route) throw new Error(`no route for: git ${args.join(" ")}`);
    if (route.fail) {
      const err = new Error(route.fail.message ?? "git failed") as Error & { stdout: string; stderr: string };
      err.stdout = route.fail.stdout ?? "";
      err.stderr = route.fail.stderr ?? "";
      throw err;
    }
    return { stdout: route.stdout ?? "", stderr: "" };
  };
  return { calls, git: createGitClient("C:/ws", exec) };
}

const cmd = (s: string) => (args: string[]) => args.join(" ") === s;
const starts = (s: string) => (args: string[]) => args.join(" ").startsWith(s);
const joined = (calls: string[][]) => calls.map((c) => c.join(" "));

type Msg = { warn: boolean; text: string };

/** 旧学生 2025001 归档（submitAll）所需路由；可注入失败点 */
function archiveRoutes(opts?: { branch?: string; status?: string; nothingToCommit?: boolean; rebaseFail?: boolean; pushFail?: boolean }) {
  return [
    { match: cmd("rev-parse --abbrev-ref HEAD"), stdout: (opts?.branch ?? "student-2025001") + "\n" },
    { match: cmd("status --porcelain"), stdout: opts?.status ?? "M week-01/a.py\n?? notes.md\n" },
    { match: cmd("add -A") },
    {
      match: starts("commit -m submit"),
      fail: opts?.nothingToCommit
        ? { stdout: "On branch student-2025001\nnothing to commit, working tree clean", message: "git failed" }
        : undefined,
    },
    { match: cmd("fetch origin") },
    { match: cmd("rev-parse --verify origin/student-2025001"), stdout: "remote123\n" },   // 首推守卫：远端分支存在 → rebase 照常执行
    { match: cmd("ls-tree --name-only origin/student-2025001 -- .gitignore .vscode/settings.json") },   // rebase 前自产文件碰撞探测
    { match: cmd("rebase origin/student-2025001"), fail: opts?.rebaseFail ? { stderr: "CONFLICT (content)" } : undefined },
    { match: cmd("rebase --abort") },
    { match: cmd("rev-parse HEAD"), stdout: "feedc0de\n" },
    { match: cmd("rev-parse origin/student-2025001"), stdout: "remote123\n" },
    { match: cmd("diff --name-only remote123 HEAD"), stdout: "week-01/a.py\nnotes.md\n" },
    { match: starts("push https://"), fail: opts?.pushFail ? { stderr: "connection refused" } : undefined },
  ];
}

/** 新学生 2025002 分支重建与同步所需路由 */
function refillRoutes(opts?: { branchMissing?: boolean; pullFail?: boolean; newFiles?: string; newOnlyFail?: boolean }) {
  return [
    { match: cmd("fetch origin") },
    { match: cmd("rev-parse --verify origin/student-2025002"), stdout: opts?.branchMissing ? "" : "a1b2c3d\n" },
    { match: cmd("branch --list student-2025002") },
    { match: cmd("branch --track student-2025002 origin/student-2025002") },
    { match: cmd("branch --no-track student-2025002 origin/main") },
    { match: cmd("ls-tree --name-only student-2025002 -- .gitignore .vscode/settings.json") },   // checkout 前自产文件碰撞探测
    { match: cmd("checkout student-2025002") },
    { match: cmd("clean -fdX") },
    { match: cmd("pull origin student-2025002"), fail: opts?.pullFail ? { stderr: "CONFLICT" } : undefined },
    { match: cmd("ls-tree --name-only origin/student-2025002 -- .gitignore .vscode/settings.json") },   // pullNewOnly rebase 前碰撞探测
    { match: cmd("rebase origin/student-2025002"), fail: opts?.newOnlyFail ? { stderr: "CONFLICT" } : undefined },
    { match: cmd("diff --diff-filter=A --name-only HEAD origin/main"), stdout: opts?.newFiles ?? "" },
    { match: starts("ls-tree --name-only origin/main -- ") },   // main 新增文件 checkout 前碰撞探测
    { match: starts("checkout origin/main -- ") },
    { match: starts("commit -m pull:") },
  ];
}

function makeBeforeDeps(git: ReturnType<typeof createGitClient>, opts?: {
  cancel?: boolean;
  confirmDelete?: (n: number) => Promise<boolean>;
}) {
  const messages: Msg[] = [];
  const confirms: { oldId: string; newId: string; count: number }[] = [];
  const deps: BeforeSwitchDeps = {
    git,
    studentId: "2025001",
    studentName: "张三",
    remoteWithBasic: () => "https://2025001:tok@gitea.example/org/hw.git",
    confirmDelete: opts?.confirmDelete,
    confirm: async (info) => { confirms.push(info); return !opts?.cancel; },
    notify: (text, warn) => { messages.push({ text, warn }); },
  };
  return { deps, messages, confirms };
}

function makeAfterDeps(git: ReturnType<typeof createGitClient>) {
  const messages: Msg[] = [];
  const deps: AfterSwitchDeps = {
    git,
    newStudentId: "2025002",
    notify: (text, warn) => { messages.push({ text, warn }); },
  };
  return { deps, messages };
}

// ── 阶段一 archiveBeforeSwitch（确认 + 旧身份提交归档）────────────────────
describe("archiveBeforeSwitch（阶段一：确认 + submitAll 归档）", () => {
  it("确认 + 归档成功 → true，push 推旧分支、成功通知", async () => {
    const rec = makeRecorder(archiveRoutes());
    const { deps, messages, confirms } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(true);

    expect(confirms).toEqual([{ oldId: "2025001", newId: "2025002", count: 2 }]);
    expect(joined(rec.calls)).toContain("push https://2025001:tok@gitea.example/org/hw.git HEAD:refs/heads/student-2025001");
    expect(messages).toEqual([{ warn: false, text: "已保存 2025001 的当前作业，服务器已留档" }]);
  });

  it("工作区无变更（nothing to commit）→ true + 提示无需保存", async () => {
    const rec = makeRecorder(archiveRoutes({ nothingToCommit: true }));
    const { deps, messages } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(true);
    expect(messages).toEqual([{ warn: false, text: "当前作业没有修改，无需保存" }]);
  });

  it("用户取消确认 → false，不触发任何归档动作", async () => {
    const rec = makeRecorder(archiveRoutes());
    const { deps, messages } = makeBeforeDeps(rec.git, { cancel: true });

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(joined(rec.calls)).toEqual(["status --porcelain"]);   // 只探测变更数
    expect(messages).toHaveLength(0);
  });

  it("分支不匹配（当前在 main）→ false + 警告（保存中止，身份未切换）", async () => {
    const rec = makeRecorder(archiveRoutes({ branch: "main" }));
    const { deps, messages } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("保存中止");
    expect(messages[0].text).toContain("2025001");
  });

  it("push 失败 → false + 警告（防代码丢失，中止切换）", async () => {
    const rec = makeRecorder(archiveRoutes({ pushFail: true }));
    const { deps, messages } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("推送失败");
  });

  it("rebase 冲突 → false + 警告，且以 rebase --abort 收尾", async () => {
    const rec = makeRecorder(archiveRoutes({ rebaseFail: true }));
    const { deps, messages } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(joined(rec.calls)[joined(rec.calls).length - 1]).toBe("rebase --abort");
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("冲突");
  });

  it("删除确认被取消 → false，不 add 不提示", async () => {
    const rec = makeRecorder(archiveRoutes({ status: "M week-01/a.py\nD  week-02/old.py\n" }));
    const { deps, messages } = makeBeforeDeps(rec.git, { confirmDelete: async () => false });

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(joined(rec.calls)).not.toContain("add -A");
    expect(messages).toHaveLength(0);
  });

  it("git 异常（如非仓库）→ false + 警告（不向调用方抛出）", async () => {
    const rec = makeRecorder([]);   // 无路由 = git 全部失败
    const { deps, messages } = makeBeforeDeps(rec.git);

    await expect(archiveBeforeSwitch(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("保存失败");
  });
});

// ── 阶段二 refillAfterSwitch（checkout 新分支 → 清理 → 同步）──────────────
describe("refillAfterSwitch（阶段二：checkout → clean → pull → pullNewOnly）", () => {
  it("正常链路：远端分支存在 + main 有新题 → 严格按序执行并汇总", async () => {
    const rec = makeRecorder(refillRoutes({ newFiles: "week-04/new.py\n" }));
    const { deps, messages } = makeAfterDeps(rec.git);

    await refillAfterSwitch(deps);

    expect(joined(rec.calls)).toEqual([
      "fetch origin",
      "rev-parse --verify origin/student-2025002",
      "branch --list student-2025002",
      "branch --track student-2025002 origin/student-2025002",
      "ls-tree --name-only student-2025002 -- .gitignore .vscode/settings.json",
      "checkout student-2025002",
      "clean -fdX",
      "rev-parse --verify origin/student-2025002",
      "pull origin student-2025002",
      "fetch origin",
      "rev-parse --verify origin/student-2025002",
      "ls-tree --name-only origin/student-2025002 -- .gitignore .vscode/settings.json",
      "rebase origin/student-2025002",
      "diff --diff-filter=A --name-only HEAD origin/main",
      "ls-tree --name-only origin/main -- week-04/new.py",
      "checkout origin/main -- week-04/new.py",
      "commit -m pull: 1 new file(s) from main",
    ]);
    expect(messages).toEqual([{ warn: false, text: "已切换到 2025002 的作业目录：拉取新作业 1 个文件" }]);
  });

  it("新学生首用（远端无分支）→ 自 origin/main 建分支、跳过 pull、仍同步新增", async () => {
    const rec = makeRecorder(refillRoutes({ branchMissing: true }));
    const { deps, messages } = makeAfterDeps(rec.git);

    await refillAfterSwitch(deps);

    const seq = joined(rec.calls);
    expect(seq).toContain("branch --no-track student-2025002 origin/main");
    expect(seq).not.toContain("pull origin student-2025002");
    expect(messages).toEqual([{ warn: false, text: "已切换到 2025002 的作业目录（暂无新作业）" }]);
  });

  it("checkout 新分支失败（fetch 断网）→ 警告并停止（不动工作区）", async () => {
    const rec = makeRecorder([{ match: cmd("fetch origin"), fail: { stderr: "network down" } }]);
    const { deps, messages } = makeAfterDeps(rec.git);

    await refillAfterSwitch(deps);

    expect(joined(rec.calls)).toEqual(["fetch origin"]);
    expect(messages).toHaveLength(1);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("准备作业目录失败");
  });

  it("pull 远端提交失败 → 警告并停止（不再继续 pullNewOnly）", async () => {
    const rec = makeRecorder(refillRoutes({ pullFail: true }));
    const { deps, messages } = makeAfterDeps(rec.git);

    await refillAfterSwitch(deps);

    const seq = joined(rec.calls);
    expect(seq).toContain("pull origin student-2025002");
    expect(seq).not.toContain("diff --diff-filter=A --name-only HEAD origin/main");
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("恢复你在服务器上的作业失败");
  });

  it("pullNewOnly 失败 → 警告 + 仍有汇总（分支已切换不回滚）", async () => {
    const rec = makeRecorder(refillRoutes({ newOnlyFail: true }));
    const { deps, messages } = makeAfterDeps(rec.git);

    await refillAfterSwitch(deps);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ warn: true, text: expect.stringContaining("同步新增作业失败") });
    expect(messages[1]).toEqual({ warn: false, text: "已切换到 2025002 的作业目录（暂无新作业）" });
  });
});

// ── 共用机场景：A 的 untracked 自建文件经 add -A 归档后，checkout 新分支时消失 ──
describe("共用机场景（A → B 切换全链）", () => {
  it("归档段 add -A + push student-2025001 在前，切换段 checkout student-2025002 + clean -fdX 在后", async () => {
    const rec = makeRecorder([...archiveRoutes(), ...refillRoutes({ newFiles: "" })]);
    const before = makeBeforeDeps(rec.git);
    const after = makeAfterDeps(rec.git);

    await expect(archiveBeforeSwitch(before.deps, "2025001", "2025002")).resolves.toBe(true);
    await refillAfterSwitch(after.deps);

    const seq = joined(rec.calls);
    const addIdx = seq.indexOf("add -A");                       // A 的 untracked 自建文件一并归档
    const pushIdx = seq.findIndex((c) => c.startsWith("push https://"));
    const checkoutBIdx = seq.indexOf("checkout student-2025002"); // checkout 后 A 的未跟踪文件从工作区消失（git 语义）
    const cleanIdx = seq.indexOf("clean -fdX");                 // 再清掉 B 视角下的 ignored 缓存垃圾
    expect(addIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(addIdx);
    expect(checkoutBIdx).toBeGreaterThan(pushIdx);
    expect(cleanIdx).toBeGreaterThan(checkoutBIdx);
    expect(seq).not.toContain("checkout student-2025001 -- .");  // 归档段不会还原工作区
  });
});

// ── 学期更替三分叉：旧学号不在名册 → 清空工作区回 main 基线（spec roster §3）──
describe("semesterResetBeforeSwitch（学期更替三分叉，spec roster §3）", () => {
  function makeDeps(confirmResult: boolean, failOn?: string) {
    const calls: string[][] = [];
    const exec: ExecFn = async (_f, args) => {
      calls.push([...args]);
      if (failOn && args.join(" ") === failOn) throw new Error("git failed");
      return { stdout: "", stderr: "" };
    };
    const confirmed: Array<{ oldId: string; newId: string }> = [];
    const notes: string[] = [];
    return {
      calls, confirmed, notes,
      deps: {
        git: createGitClient("C:/ws", exec),
        confirm: async (info) => { confirmed.push(info); return confirmResult; },
        notify: (m: string, _warn: boolean) => { notes.push(m); },
      } as Parameters<typeof semesterResetBeforeSwitch>[0],
    };
  }

  it("确认 → 清空三连（fetch/reset/clean）→ true（调用方可保存新身份）", async () => {
    const { calls, confirmed, deps } = makeDeps(true);
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(true);
    expect(confirmed).toEqual([{ oldId: "2025001", newId: "2026001" }]);
    expect(calls.map((c) => c.join(" "))).toEqual(["fetch origin", "reset --hard origin/main", "clean -fdx -e .vscode"]);
  });
  it("用户取消 → false，不执行任何 git 命令", async () => {
    const { calls, deps } = makeDeps(false);
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
  it("reset 失败 → false + 告警提示可重试（中止，不保存新身份）", async () => {
    const { calls, notes, deps } = makeDeps(true, "reset --hard origin/main");
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(false);
    expect(calls.map((c) => c.join(" "))).toEqual(["fetch origin", "reset --hard origin/main"]);   // clean 未执行
    expect(notes[0]).toContain("重置失败");
  });
});
