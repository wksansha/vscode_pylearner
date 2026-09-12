import { describe, it, expect } from "vitest";
import { BehaviorSessionTracker } from "../../events/behaviorListener";
import type { TypingSessionPayload } from "../../events/behaviorFeatures";

function drain(tracker: BehaviorSessionTracker): TypingSessionPayload[] {
  return tracker.drain();
}

describe("BehaviorSessionTracker", () => {
  it("ends a session on editor switch and emits one payload", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "print(1)", 0);
    tracker.onEdit("main.py", 1, 0, 1, "print()", 1_000);
    tracker.onEdit("main.py", 2, 3, 0, "print()\nx=1", 2_000);
    tracker.onEditorSwitch("main.py", 3_000);

    const out = drain(tracker);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("main.py");
    expect(out[0].ended_by).toBe("editor_switch");
    expect(out[0].typing.changes).toBe(3);
    expect(out[0].duration_ms).toBe(3_000);
  });

  it("drops sessions with fewer than 3 changes", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 0, 1, "", 1_000);
    tracker.onEditorSwitch("main.py", 2_000);
    expect(drain(tracker)).toHaveLength(0);
  });

  it("ends sessions on idle and includes the trailing gap in max gap", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abcd", 100_000);
    tracker.checkIdle(400_000); // 距最后编辑 300_000ms = 5min

    const out = drain(tracker);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("idle");
    expect(out[0].duration_ms).toBe(400_000);
    expect(out[0].typing.max_gap_ms).toBe(300_000); // 尾随空闲计入
  });

  it("does not end sessions below the idle threshold", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 300_000);
    tracker.checkIdle(599_000); // 距最后编辑 299s < 5min
    expect(drain(tracker)).toHaveLength(0);
  });

  it("ends a session at max duration and starts a fresh one", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abcd", 91 * 60_000); // 超 90min
    tracker.onEditorSwitch("main.py", 91 * 60_000 + 1_000);

    const out = drain(tracker);
    expect(out).toHaveLength(2);
    expect(out[0].ended_by).toBe("max_duration");
    expect(out[0].duration_ms).toBe(91 * 60_000);
    // 第二条:新会话从 91min 重新计时
    expect(out[1].duration_ms).toBe(1_000);
  });

  it("resumes a same-file session within the 3min window (single buffer, original start)", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEditorSwitch("a.py", 100_000); // a 结束(emit)
    tracker.onEdit("a.py", 1, 3, 0, "xy", 150_000); // 2.5min 内回来 → 续会话
    tracker.onEditorSwitch("a.py", 200_000);

    const out = drain(tracker);
    expect(out).toHaveLength(1); // 续会话,不是两条
    expect(out[0].duration_ms).toBe(200_000); // 起止沿用原会话
    expect(out[0].typing.changes).toBe(2);    // 缓冲沿用
  });

  it("does not resume when another file's session intervened", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEditorSwitch("a.py", 100_000);  // a 结束
    tracker.onEdit("b.py", 1, 5, 0, "y", 120_000);
    tracker.onEditorSwitch("b.py", 130_000);  // b 结束 → lastClosed 变为 b
    tracker.onEdit("a.py", 1, 3, 0, "xy", 140_000); // a 回来 → 不续
    tracker.onEditorSwitch("a.py", 150_000);

    const out = drain(tracker);
    expect(out).toHaveLength(3);
    expect(out[2].duration_ms).toBe(10_000); // a' 是全新会话
  });

  it("emits deactivate payloads on dispose", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 5, 0, "xx", 1_000);
    tracker.onEdit("main.py", 1, 5, 0, "xxx", 2_000);
    tracker.dispose(3_000);
    const out = drain(tracker);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("deactivate");
  });

  it("marks truncated at the change cap and stops buffering further records", () => {
    const tracker = new BehaviorSessionTracker();
    for (let i = 0; i < 5_002; i++) {
      tracker.onEdit("main.py", 1, 1, 0, "a", i);
    }
    tracker.onEditorSwitch("main.py", 5_002);
    const out = drain(tracker);
    expect(out).toHaveLength(1);
    expect(out[0].truncated).toBe(true);
    expect(out[0].typing.changes).toBe(5_000);
  });

  it("attaches diagnostics only to open sessions and skips duplicate snapshots", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 0); // 无会话 → 忽略
    tracker.onEdit("main.py", 12, 10, 0, "for i in range(10)", 1_000);
    tracker.onEdit("main.py", 12, 0, 1, "for i in range(10)", 2_000);
    tracker.onEdit("main.py", 12, 4, 0, "for i in range(10)", 3_000);
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 4_000);
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 5_000); // 重复快照
    tracker.onEditorSwitch("main.py", 6_000);

    const out = drain(tracker);
    expect(out).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen[0].msg).toBe("expected ':'");
    expect(out[0].diagnostics.unresolved).toBe(1);
  });
});