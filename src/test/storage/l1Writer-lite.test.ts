import { describe, it, expect, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

// public-lite 精简模式（构造选项 lite: true）：
// 不写本地 jsonl；实时上报仅保留 run 与 behavior（登录态信号）；提交通道分发跳过（无评审）

function makeLiteWriter() {
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
  const writer = new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never, { lite: true });
  const report = vi.fn().mockResolvedValue(undefined);
  writer.setTeacherReporter({ report } as never);
  const submission = vi.fn();
  writer.setSubmissionHandler(submission);
  return { writer, report, submission };
}

describe("L1Writer lite 模式（public-lite）", () => {
  it("edit/diag/debug → 不上报、不写本地文件", async () => {
    const { writer, report, submission } = makeLiteWriter();
    await writer.append("edit", "code_change", { file: "a.py" });
    await writer.append("diag", "diagnostics_change", { file: "a.py", errors: 1 });
    await writer.append("debug", "breakpoint_change", {});
    expect(report).not.toHaveBeenCalled();
    expect(submission).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it("run/behavior → 实时上报保留，但同样不写本地文件", async () => {
    const { writer, report } = makeLiteWriter();
    await writer.append("run", "execution_success", { exit_code: 0 }, "s1");
    await writer.append("behavior", "identity_confirmed", { machine_id: "m1" });
    const surfaces = report.mock.calls.map((c) => (c[0] as { surface: string }).surface);
    expect(surfaces).toEqual(["run", "behavior"]);
    const run = report.mock.calls[0][0] as { session_id?: string };
    expect(run.session_id).toBe("s1");
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
  });

  it("提交通道分发跳过（lite 无评审）", async () => {
    const { writer, submission } = makeLiteWriter();
    await writer.append("run", "execution_success", { exit_code: 0 });
    expect(submission).not.toHaveBeenCalled();
  });
});
