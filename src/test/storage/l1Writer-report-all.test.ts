import { describe, it, expect, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

describe("L1Writer 全 surface 上报（spec §6.2：门控放开）", () => {
  it("edit/chat/behavior/debug 事件均调用 reporter.report，session_id 透传", async () => {
    // vscode-mock 的 fs 方法均为 vi.fn()，此处按简报配置 readFile 返回空缓冲，
    // 否则 writeEvent 在 existing.length 处抛 TypeError。
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
    const writer = new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never);
    const report = vi.fn().mockResolvedValue(undefined);
    writer.setTeacherReporter({ report } as never);
    await writer.append("edit", "code_change", { file: "a.py" });
    await writer.append("chat", "user_message", { text: "你好" }, "s1");
    await writer.append("behavior", "typing_session", {});
    await writer.append("debug", "breakpoint_change", {});
    expect(report).toHaveBeenCalledTimes(4);
    const surfaces = report.mock.calls.map((c) => (c[0] as { surface: string }).surface);
    expect(surfaces).toEqual(["edit", "chat", "behavior", "debug"]);
    const chat = report.mock.calls[1][0] as { session_id?: string };
    expect(chat.session_id).toBe("s1");
  });
});
