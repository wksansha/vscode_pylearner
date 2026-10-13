import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { OUTCOME_TEXT, makeSubmitCommand, type SubmitCommandDeps } from "../../submission/submitCommand";
import type { SubmissionTarget } from "../../submission/collectTargets";

describe("OUTCOME_TEXT（A3 手动兜底提示文案；V2.0 纯归档语义）", () => {
  it("五种结果均有面向学生的中文提示", () => {
    expect(OUTCOME_TEXT.submitted).toContain("已归档");
    expect(OUTCOME_TEXT.submitted).toContain("自动评审");
    expect(OUTCOME_TEXT.skipped).toContain("已归档过");
    expect(OUTCOME_TEXT["not-exercise"]).toContain("不是课堂练习");
    expect(OUTCOME_TEXT["identity-missing"]).toContain("身份");
    expect(OUTCOME_TEXT.error).toContain("失败");
  });
});

// ── V2.0 提交按钮：一键归档全部练习 ─────────────────────────
const ID_A = "01234567-89ab-cdef-0123-456789abcdef";
const ID_B = "11111111-2222-3333-4444-555555555555";
const hashOf = (content: string) => crypto.createHash("sha256").update(content).digest("hex");

type Msg = { level: "info" | "warn" | "error"; text: string };

function makeFakeVscode(folders?: { uri: { fsPath: string } }[]) {
  const messages: Msg[] = [];
  const vscode = {
    workspace: { workspaceFolders: folders },
    window: {
      activeTextEditor: undefined as unknown,
      showInformationMessage: (text: string) => { messages.push({ level: "info", text }); },
      showWarningMessage: (text: string) => { messages.push({ level: "warn", text }); },
      showErrorMessage: (text: string) => { messages.push({ level: "error", text }); },
      withProgress: async (_opts: unknown, task: () => Promise<void>) => task(),
    },
    ProgressLocation: { Notification: 15 },
  } as unknown as typeof import("vscode");
  return { vscode, messages };
}

function makeDeps(targets: SubmissionTarget[] | null, opts?: {
  identity?: { studentId: string | null; studentName: string | null };
  fetchStatus?: number;
  preHashes?: Record<string, string>;
}) {
  const posts: { url: string; body: unknown }[] = [];
  let hashes: Record<string, string> = opts?.preHashes ?? {};
  let identityMissingCalls = 0;
  const deps: SubmitCommandDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => opts?.identity ?? { studentId: "2025001", studentName: "张三" },
    onIdentityMissing: () => { identityMissingCalls++; },
    globalState: {
      get: (key: string) => (key === "pylearner.submission.lastHashes" ? hashes : undefined),
      update: async (key: string, value: unknown) => {
        if (key === "pylearner.submission.lastHashes") hashes = value as Record<string, string>;
      },
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: opts?.fetchStatus ?? 200 });
    }) as unknown as typeof fetch,
    // targets=null → 缺 collectTargets，走回退单文件路径
    ...(targets !== null
      ? { collectTargets: async () => targets }
      : { readFile: async () => `# exercise-id: ${ID_A}\nprint(1)` }),
  };
  return { deps, posts, identityMissingCalls: () => identityMissingCalls };
}

describe("makeSubmitCommand（V2.0 一键归档全部练习）", () => {
  const t1: SubmissionTarget = { label: "week-02/01-hello.py", filePath: "C:\\ws\\week-02\\01-hello.py", content: `# exercise-id: ${ID_A}\nprint(1)` };
  const t2: SubmissionTarget = { label: "week-03/weather-app", filePath: "C:\\ws\\week-03\\weather-app\\main.py", content: `# exercise-id: ${ID_B}\n# entry` };
  const ws = [{ uri: { fsPath: "C:\\ws" } }];

  it("全部新归档 → info 汇总：每个目标各 POST 一次", async () => {
    const { vscode, messages } = makeFakeVscode(ws);
    const { deps, posts } = makeDeps([t1, t2]);
    await makeSubmitCommand(deps, vscode)();
    expect(posts).toHaveLength(2);
    expect(messages[0]).toMatchObject({ level: "info", text: "✅ 提交完成：新归档 2 · 已是最新 0" });
  });

  it("幂等：已交内容 → 已是最新计入，不重复 POST", async () => {
    const { vscode, messages } = makeFakeVscode(ws);
    const { deps, posts } = makeDeps([t1, t2], { preHashes: { [ID_B]: hashOf(t2.content) } });
    await makeSubmitCommand(deps, vscode)();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ exerciseId: ID_A, source: "manual" });
    expect(messages[0]).toMatchObject({ level: "info", text: "✅ 提交完成：新归档 1 · 已是最新 1" });
  });

  it("失败计入 Z 并带 label → warning 汇总", async () => {
    const { vscode, messages } = makeFakeVscode(ws);
    const { deps, posts } = makeDeps([t1, t2], { fetchStatus: 500 });
    await makeSubmitCommand(deps, vscode)();
    expect(posts).toHaveLength(2);
    const warn = messages[0];
    expect(warn.level).toBe("warn");
    expect(warn.text).toContain("失败 2");
    expect(warn.text).toContain(t1.label);
    expect(warn.text).toContain(t2.label);
  });

  it("identity-missing → 停止 + 警告，不显示汇总，不 POST", async () => {
    const { vscode, messages } = makeFakeVscode(ws);
    const { deps, posts, identityMissingCalls } = makeDeps([t1, t2], { identity: { studentId: null, studentName: null } });
    await makeSubmitCommand(deps, vscode)();
    expect(identityMissingCalls()).toBeGreaterThanOrEqual(1);
    expect(posts).toHaveLength(0);
    expect(messages.some((m) => m.level === "warn" && m.text.includes("身份页"))).toBe(true);
    expect(messages.some((m) => m.level === "info")).toBe(false);
  });

  it("无目标 → 未找到课堂练习；无工作区 → 请先打开课堂文件夹", async () => {
    const v1 = makeFakeVscode(ws);
    const { deps: d1 } = makeDeps([]);
    await makeSubmitCommand(d1, v1.vscode)();
    expect(v1.messages[0]).toMatchObject({ level: "info", text: "未找到课堂练习（week-XX 目录）" });

    const v2 = makeFakeVscode(undefined);
    const { deps: d2 } = makeDeps([t1]);
    await makeSubmitCommand(d2, v2.vscode)();
    expect(v2.messages[0]).toMatchObject({ level: "warn", text: "请先打开课堂文件夹" });
  });

  it("缺 collectTargets → 回退旧单文件路径（活动编辑器）", async () => {
    const { vscode, messages } = makeFakeVscode(undefined);
    const { deps, posts } = makeDeps(null);
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: "C:\\ws\\week-02\\01-hello.py" }, isDirty: false },
    };
    await makeSubmitCommand(deps, vscode)();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ exerciseId: ID_A, source: "manual" });
    expect(messages[0]?.level).toBe("info");
  });
});
