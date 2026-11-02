// src/test/update/updateChecker.test.ts
import { describe, it, expect, vi } from "vitest";
import { compareVersions, checkForUpdate, installUpdate, type InstallUpdateDeps } from "../../update/updateChecker";

// 插件自更新（spec 2026-11-02-plugin-auto-update）：失败静默 / 白名单防穿越 / 版本按段数值比较

const TEACHER = "http://t:3002";
const okManifest = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ version: "1.0.9", file: "vscode-pylearner-1.0.9.vsix", notes: "修复", ...over }), { status: 200 });
const fetchOk = (over: Record<string, unknown> = {}) => (async () => okManifest(over)) as unknown as typeof fetch;

describe("compareVersions", () => {
  it("按段数值比较：1.10.0 > 1.9.0", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
  });
  it("跨版本线：2.0.8 > 1.0.8；相等 → 0", () => {
    expect(compareVersions("1.0.8", "2.0.8")).toBe(-1);
    expect(compareVersions("1.0.8", "1.0.8")).toBe(0);
  });
  it("段数不齐补 0：1.0 = 1.0.0", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
  });
  it("非数字段按 0", () => {
    expect(compareVersions("1.0.x", "1.0.0")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  it("新版本 → 返回 UpdateInfo，downloadUrl 由 teacherUrl + file 拼接", async () => {
    const info = await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: fetchOk() });
    expect(info).toEqual({
      version: "1.0.9",
      file: "vscode-pylearner-1.0.9.vsix",
      downloadUrl: `${TEACHER}/downloads/pylearner/vscode-pylearner-1.0.9.vsix`,
      notes: "修复",
    });
  });

  it("HTTP 404（服务器未放包）→ null", async () => {
    const f = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: f })).toBeNull();
  });

  it("非法 JSON → null", async () => {
    const f = (async () => new Response("{ bad", { status: 200 })) as unknown as typeof fetch;
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: f })).toBeNull();
  });

  it("file 含路径穿越/非法字符 → null（防下载任意文件）", async () => {
    for (const file of ["../evil.vsix", "a b.vsix", "a/b.vsix", ""]) {
      const info = await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: fetchOk({ file }) });
      expect(info, `file=${JSON.stringify(file)}`).toBeNull();
    }
  });

  it("版本不高于当前（相等/更低）→ null", async () => {
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.9", fetchImpl: fetchOk() })).toBeNull();
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "2.0.0", fetchImpl: fetchOk() })).toBeNull();
  });

  it("网络异常 → null 不抛", async () => {
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: f })).toBeNull();
  });

  it("超时 abort → null", async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      )) as unknown as typeof fetch;
    expect(await checkForUpdate({ teacherUrl: TEACHER, currentVersion: "1.0.8", fetchImpl: f, timeoutMs: 10 })).toBeNull();
  });
});

function makeInstallDeps(over: Partial<InstallUpdateDeps> = {}) {
  const calls: string[] = [];
  const deps: InstallUpdateDeps = {
    info: { version: "1.0.9", file: "vscode-pylearner-1.0.9.vsix", downloadUrl: `${TEACHER}/downloads/pylearner/vscode-pylearner-1.0.9.vsix`, notes: "" },
    showProgress: async (_title, task) => task(),
    showMessage: async () => true,
    showError: (m) => calls.push(`error:${m}`),
    executeCommand: (cmd) => { calls.push(`cmd:${cmd}`); return Promise.resolve(); },
    writeFile: async (p) => { calls.push(`write:${p}`); },
    tmpDir: "C:\\Temp",
    joinPath: (...s) => s.join("/"),
    toUri: (p) => ({ fsPath: p }),
    fetchImpl: (async () => new Response("vsix-bytes", { status: 200 })) as unknown as typeof fetch,
    ...over,
  };
  return { deps, calls };
}

describe("installUpdate", () => {
  it("happy path：写临时文件 → installVSIX → 确认后 reloadWindow", async () => {
    const { deps, calls } = makeInstallDeps();
    await installUpdate(deps);
    expect(calls.some((c) => c.startsWith("write:"))).toBe(true);
    expect(calls).toContain("cmd:workbench.extensions.action.installVSIX");
    expect(calls).toContain("cmd:workbench.action.reloadWindow");
    expect(calls.every((c) => !c.startsWith("error:"))).toBe(true);
  });

  it("下载失败 → showError 一次，不执行安装", async () => {
    const { deps, calls } = makeInstallDeps({
      fetchImpl: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    });
    await installUpdate(deps);
    expect(calls.filter((c) => c.startsWith("error:"))).toHaveLength(1);
    expect(calls.every((c) => !c.includes("installVSIX"))).toBe(true);
  });

  it("写盘/安装抛错 → showError 一次，不再重试", async () => {
    const { deps, calls } = makeInstallDeps({ writeFile: async () => { throw new Error("disk full"); } });
    await installUpdate(deps);
    expect(calls.filter((c) => c.startsWith("error:"))).toHaveLength(1);
  });

  it("用户不点「重新加载」→ 不执行 reloadWindow", async () => {
    const { deps, calls } = makeInstallDeps({ showMessage: async () => false });
    await installUpdate(deps);
    expect(calls).toContain("cmd:workbench.extensions.action.installVSIX");
    expect(calls.every((c) => !c.includes("reloadWindow"))).toBe(true);
  });

  it("showProgress 收到下载中文案", async () => {
    const spy = vi.fn(async (_t: string, task: () => Promise<string>) => task());
    const { deps } = makeInstallDeps({ showProgress: spy as unknown as InstallUpdateDeps["showProgress"] });
    await installUpdate(deps);
    expect(spy).toHaveBeenCalledWith("正在下载课堂助手更新…", expect.any(Function));
  });
});
