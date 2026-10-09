import { describe, it, expect, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

describe("L1Writer.setSubmissionHandler（A2：仅 run success 分发）", () => {
  it("execution_success → handler；execution_error / diag 不分发", async () => {
    // vscode-mock 的 fs 方法均为 vi.fn()，此处按简报配置 readFile 返回空缓冲，
    // 否则 writeEvent 在 existing.length 处抛 TypeError。
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
    const writer = new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never);
    const handler = vi.fn();
    writer.setSubmissionHandler(handler);
    await writer.append("run", "execution_success", { source: "task", exit_code: 0 });
    await writer.append("run", "execution_error", { source: "task", exit_code: 1, error_message: "x" });
    await writer.append("diag", "diagnostics_change", { file: "a.py", errors: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0];
    expect(ev.kind).toBe("execution_success");
  });
});
