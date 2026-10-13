// src/test/storage/l1Writer-identity.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

const today = new Date().toISOString().slice(0, 10);

function makeWriter() {
  return new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never);
}
const writtenPaths = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.map((c) => (c[0] as { path: string }).path);
const identityWrites = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.filter((c) => (c[0] as { path: string }).path.endsWith(".identity.json"));

beforeEach(() => {
  // vitest 默认不跨用例清空 mock 调用历史，先清掉再重设实现，保证各用例计数独立
  vi.clearAllMocks();
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
  vi.mocked(vscode.workspace.fs.createDirectory).mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
});

describe("L1Writer 按学号落盘", () => {
  it("有身份 → trace/<学号>/<surface>/<date>.jsonl，并写 .identity.json", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    const paths = writtenPaths();
    expect(paths.some((p) => p === `/tmp/x/trace/2024001/edit/${today}.jsonl`)).toBe(true);
    expect(identityWrites()).toHaveLength(1);
    const payload = JSON.parse(new TextDecoder().decode(identityWrites()[0][1] as Uint8Array));
    expect(payload).toEqual({ studentId: "2024001", studentName: "张三", classId: "default" });
  });

  it("未设身份 → trace/unknown/，不写 identity.json", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => undefined);
    await w.append("edit", "code_change", {});
    expect(writtenPaths().some((p) => p === `/tmp/x/trace/unknown/edit/${today}.jsonl`)).toBe(true);
    expect(identityWrites()).toHaveLength(0);
  });

  it("非法学号 → unknown", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "../x", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    expect(writtenPaths().some((p) => p.startsWith(`/tmp/x/trace/unknown/`))).toBe(true);
    expect(identityWrites()).toHaveLength(0);
  });

  it("身份切换 → 下一条事件落新目录，identity.json 覆写", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    w.setIdentityProvider(() => ({ studentId: "2024002", studentName: "李四", classId: "c2" }));
    await w.append("edit", "code_change", {});
    const paths = writtenPaths();
    expect(paths.some((p) => p.startsWith("/tmp/x/trace/2024001/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/tmp/x/trace/2024002/"))).toBe(true);
    expect(identityWrites()).toHaveLength(2);
    const second = JSON.parse(new TextDecoder().decode(identityWrites()[1][1] as Uint8Array));
    expect(second).toEqual({ studentId: "2024002", studentName: "李四", classId: "c2" });
  });

  it("同身份连续 append → identity.json 只写一次", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    await w.append("edit", "code_change", {});
    expect(identityWrites()).toHaveLength(1);
  });

  it("identity.json 首次写失败 → 未标记缓存，下一条事件重试且事件落盘不受阻", async () => {
    let identityWriteCalls = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p.endsWith(".identity.json")) {
        identityWriteCalls += 1;
        if (identityWriteCalls === 1) throw new Error("EACCES"); // 仅首次失败
      }
      // 事件文件写入照常 resolve
    });
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    await w.append("edit", "code_change", {});
    // 失败未标记缓存 → 第二次 append 重试了快照写入（共尝试 2 次，第二次成功）
    expect(identityWriteCalls).toBe(2);
    expect(identityWrites()).toHaveLength(2);
    // 两次事件文件写入均未受快照失败阻塞
    expect(writtenPaths().filter((p) => p.endsWith(`${today}.jsonl`))).toHaveLength(2);
  });
});
