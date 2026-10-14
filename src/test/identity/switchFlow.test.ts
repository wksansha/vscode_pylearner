import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  weekDirsToRemove,
  confirmAndArchive,
  clearAndRefill,
  type SwitchArchiveDeps,
  type PostSwitchDeps,
} from "../../identity/switchFlow";
import type { SubmissionTarget } from "../../submission/collectTargets";

// ── 一键换机：阶段一 confirmAndArchive（确认 + 旧身份归档）────────────────
const ID_A = "01234567-89ab-cdef-0123-456789abcdef";
const ID_B = "11111111-2222-3333-4444-555555555555";

const t1: SubmissionTarget = { label: "week-02/01-hello.py", filePath: "C:\\ws\\week-02\\01-hello.py", content: `# exercise-id: ${ID_A}\nprint(1)` };
const t2: SubmissionTarget = { label: "week-03/weather-app", filePath: "C:\\ws\\week-03\\weather-app\\main.py", content: `# exercise-id: ${ID_B}\n# entry` };

type Msg = { warn: boolean; text: string };

function makeSwitchDeps(opts?: {
  targets?: SubmissionTarget[];
  cancel?: boolean;
  fetchStatus?: number;
  root?: string;
  identity?: { studentId: string | null; studentName: string | null };
}) {
  const messages: Msg[] = [];
  const posts: unknown[] = [];
  let hashes: Record<string, string> = {};
  let identityMissingCalls = 0;
  const deps: SwitchArchiveDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => opts?.identity ?? { studentId: "2025001", studentName: "张三" },
    onIdentityMissing: () => { identityMissingCalls++; },
    globalState: {
      get: (key: string) => (key === "pylearner.submission.lastHashes" ? hashes : undefined),
      update: async (key: string, value: unknown) => {
        if (key === "pylearner.submission.lastHashes") hashes = value as Record<string, string>;
      },
    },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: opts?.fetchStatus ?? 200 });
    }) as unknown as typeof fetch,
    rootFsPath: () => (opts && "root" in opts ? opts.root : "C:\\ws"),   // 显式传 undefined = 无工作区
    collectTargets: async () => opts?.targets ?? [t1, t2],
    confirm: async () => !opts?.cancel,
    notify: (text, warn) => { messages.push({ text, warn }); },
  };
  return { deps, messages, posts, identityMissingCalls: () => identityMissingCalls };
}

describe("confirmAndArchive（阶段一：确认 + 旧身份归档）", () => {
  it("确认 + 归档成功 → true，逐目标 POST，通知归档计数", async () => {
    const { deps, messages, posts } = makeSwitchDeps();
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ studentId: "2025001" });   // 归档归属旧身份
    expect(messages[0]).toEqual({ warn: false, text: "已用 2025001 归档 2 个练习" });
  });

  it("归档有失败 → false + 警告（身份未切换，可重试）", async () => {
    const { deps, messages, posts } = makeSwitchDeps({ fetchStatus: 500 });
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(posts).toHaveLength(2);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("归档未完成");
    expect(messages[0].text).toContain("2 个失败");
    expect(messages[0].text).toContain(t1.label);
  });

  it("用户取消确认 → false，不发起任何归档请求", async () => {
    const { deps, messages, posts } = makeSwitchDeps({ cancel: true });
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(posts).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it("无工作区 → false + 警告，不触发收集", async () => {
    const { deps, messages, posts } = makeSwitchDeps({ root: undefined });
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(posts).toHaveLength(0);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("请先打开课堂文件夹");
  });

  it("空工作区（0 练习）+ 确认 → true（新机器首次切换场景）", async () => {
    const { deps, messages } = makeSwitchDeps({ targets: [] });
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(true);
    expect(messages[0]).toEqual({ warn: false, text: "已用 2025001 归档 0 个练习" });
  });

  it("identity-missing → false + 警告，不产生汇总", async () => {
    const { deps, messages, posts, identityMissingCalls } = makeSwitchDeps({ identity: { studentId: null, studentName: null } });
    await expect(confirmAndArchive(deps, "2025001", "2025002")).resolves.toBe(false);
    expect(identityMissingCalls()).toBeGreaterThanOrEqual(1);
    expect(posts).toHaveLength(0);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("身份信息缺失");
  });
});

// ── weekDirsToRemove（清空范围识别）──────────────────────────────────────
describe("weekDirsToRemove（清空范围：只认一级 week-* 目录）", () => {
  it("宽容非补零；忽略文件、非 week 目录与伪周名", () => {
    expect(weekDirsToRemove([
      ["week-02", true], ["week-5", true], ["week-10", true],
      [".vscode", true], ["notes.txt", false], ["weekly", true], ["week-", true],
    ])).toEqual(["week-02", "week-5", "week-10"]);
  });
});

// ── clearAndRefill（阶段二：清空 → 拉取 → 恢复）──────────────────────────
function makePostDeps(opts?: {
  entries?: [string, boolean][] | null;
  failDelete?: boolean;
  failPull?: boolean;
  failRestore?: boolean;
}) {
  const messages: Msg[] = [];
  const calls: string[] = [];
  const deleted: string[] = [];
  const deps: PostSwitchDeps = {
    listEntries: async () => {
      calls.push("list");
      return opts?.entries !== undefined
        ? opts.entries
        : [["week-02", true], ["week-5", true], [".vscode", true], ["notes.txt", false]];
    },
    deleteDir: async (name) => {
      calls.push(`delete:${name}`);
      if (opts?.failDelete) throw new Error("disk locked");
      deleted.push(name);
    },
    pull: async () => {
      calls.push("pull");
      if (opts?.failPull) throw new Error("network down");
      return { pulled: 3 };
    },
    restore: async () => {
      calls.push("restore");
      if (opts?.failRestore) throw new Error("server 500");
      return { restored: 2 };
    },
    notify: (text, warn) => { messages.push({ text, warn }); },
  };
  return { deps, messages, calls, deleted };
}

describe("clearAndRefill（阶段二：清空 → 拉取 → 恢复）", () => {
  it("正常链路：只删 week-* 目录，严格按顺序执行并汇总", async () => {
    const { deps, messages, calls, deleted } = makePostDeps();
    await clearAndRefill(deps);
    expect(deleted).toEqual(["week-02", "week-5"]);
    expect(calls).toEqual(["list", "delete:week-02", "delete:week-5", "pull", "restore"]);
    expect(messages).toEqual([
      { warn: false, text: "已切换工作区：清空 2 个周目录 · 拉取 3 个文件 · 恢复 2 个提交" },
    ]);
  });

  it("清空失败 → 警告并完全停止（不拉取不恢复，防误删后续动作）", async () => {
    const { deps, messages, calls } = makePostDeps({ failDelete: true });
    await clearAndRefill(deps);
    expect(calls).toEqual(["list", "delete:week-02"]);   // 删除抛错即停
    expect(messages).toHaveLength(1);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("清空旧作业目录失败");
  });

  it("拉取失败 → 警告并停止（不恢复），不产生汇总", async () => {
    const { deps, messages, calls } = makePostDeps({ failPull: true });
    await clearAndRefill(deps);
    expect(calls).toEqual(["list", "delete:week-02", "delete:week-5", "pull"]);
    expect(messages).toHaveLength(1);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("拉取作业失败");
  });

  it("恢复失败 → 警告 + 仍有汇总（拉取已成功不回滚）", async () => {
    const { deps, messages } = makePostDeps({ failRestore: true });
    await clearAndRefill(deps);
    expect(messages).toHaveLength(2);
    expect(messages[0].warn).toBe(true);
    expect(messages[0].text).toContain("恢复历史提交失败");
    expect(messages[1]).toEqual({ warn: false, text: "已切换工作区：清空 2 个周目录 · 拉取 3 个文件 · 恢复 0 个提交" });
  });

  it("无工作区（null 条目）→ 不清空但仍拉取+恢复", async () => {
    const { deps, messages, calls, deleted } = makePostDeps({ entries: null });
    await clearAndRefill(deps);
    expect(deleted).toEqual([]);
    expect(calls).toEqual(["list", "pull", "restore"]);
    expect(messages[0]).toEqual({ warn: false, text: "已切换工作区：清空 0 个周目录 · 拉取 3 个文件 · 恢复 2 个提交" });
  });
});
