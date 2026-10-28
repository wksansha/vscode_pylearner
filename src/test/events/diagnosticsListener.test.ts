import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { createDiagnosticsListener } from "../../events/diagnosticsListener";

// 存活窗口（PERSIST_MS=30s）：瞬态打字中间态（窗口内消失）永不报；
// 持续存在的真错误在满窗口对账时上报一次；消失后再现视为新错误可再报。

const uri = {
  scheme: "file", fsPath: "/w/a.py",
  toString: () => "file:///w/a.py",
} as never as vscode.Uri;

const errDiag = (message: string, line = 0) => ({
  message, severity: vscode.DiagnosticSeverity.Error,
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

function makeListener() {
  const writer = { append: vi.fn().mockResolvedValue(undefined) };
  const listener = createDiagnosticsListener(writer as never);
  const handler = (vscode.languages.onDidChangeDiagnostics as ReturnType<typeof vi.fn>)
    .mock.calls[0][0] as (e: { uris: vscode.Uri[] }) => void;
  return { writer, listener, handler };
}

describe("diagnosticsListener 存活窗口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("观察期：错误 5s 内消失（打字噪音）→ 永不上报", async () => {
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("Expected name after 'def'")] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);            // 收敛去抖
    vi.advanceTimersByTime(5_000);                    // 停顿 5s（窗口未满）
    // 错误消失：诊断清空
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(60_000);                   // 越过窗口也不会补报
    expect(writer.append).not.toHaveBeenCalled();
    listener.dispose();
  });

  it("持久上报：错误存活满 30s → 上报一次；持续存在不重复报", async () => {
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);           // 收敛，指纹首见
    vi.advanceTimersByTime(30_000);                   // 存活满窗口 → 对账上报
    expect(writer.append).toHaveBeenCalledTimes(1);
    const payload = (writer.append as ReturnType<typeof vi.fn>).mock.calls[0][2] as { errors: number; samples: string[] };
    expect(payload.errors).toBe(1);
    expect(payload.samples[0]).toContain("unresolved reference");
    vi.advanceTimersByTime(120_000);                  // 错误仍在 → 不重复报
    expect(writer.append).toHaveBeenCalledTimes(1);
    listener.dispose();
  });

  it("消失后再现 → 视为新错误，重新计时后可再次上报", async () => {
    const { writer, listener, handler } = makeListener();
    const mockGet = vi.mocked(vscode.languages.getDiagnostics);
    mockGet.mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(30_000);                   // 第一次上报
    expect(writer.append).toHaveBeenCalledTimes(1);
    // 消失
    mockGet.mockReturnValue([] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    // 再现（同指纹）
    mockGet.mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(10_000);                   // 新窗口未满
    expect(writer.append).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25_000);                   // 满 30s → 再报
    expect(writer.append).toHaveBeenCalledTimes(2);
    listener.dispose();
  });

  it("monitorEdit 关闭 → 完全不采集", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("some error")] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(60_000);
    expect(writer.append).not.toHaveBeenCalled();
    listener.dispose();
  });
});
