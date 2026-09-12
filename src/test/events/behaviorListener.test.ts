import { describe, it, expect } from "vitest";
import { BehaviorSessionTracker } from "../../events/behaviorListener";
import type { TypingSessionPayload } from "../../events/behaviorFeatures";

const RESUME_WINDOW = 3 * 60_000; // 与 tracker DEFAULTS.resumeWindowMs 一致

function drain(tracker: BehaviorSessionTracker, t: number): TypingSessionPayload[] {
  return tracker.drain(t);
}

describe("BehaviorSessionTracker", () => {
  it("ends a session on editor switch and emits one payload after the resume window", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "print(1)", 0);
    tracker.onEdit("main.py", 1, 0, 1, "print()", 1_000);
    tracker.onEdit("main.py", 2, 3, 0, "print()\nx=1", 2_000);
    tracker.onEditorSwitch("main.py", 3_000);

    expect(drain(tracker, 3_000)).toHaveLength(0); // 挂起中,等待续会话窗口
    const out = drain(tracker, 3_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("main.py");
    expect(out[0].ended_by).toBe("editor_switch");
    expect(out[0].typing.changes).toBe(3);
    expect(out[0].duration_ms).toBe(3_000);
  });

  it("drops <3-change sessions outright for every end reason", () => {
    // editor_switch
    const t1 = new BehaviorSessionTracker();
    t1.onEdit("main.py", 1, 5, 0, "x", 0);
    t1.onEdit("main.py", 1, 0, 1, "", 1_000);
    t1.onEditorSwitch("main.py", 2_000);
    expect(drain(t1, 2_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // idle
    const t2 = new BehaviorSessionTracker();
    t2.onEdit("main.py", 1, 5, 0, "x", 0);
    t2.onEdit("main.py", 1, 0, 1, "", 100_000);
    t2.checkIdle(400_000);
    expect(drain(t2, 400_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // editor_close
    const t3 = new BehaviorSessionTracker();
    t3.onEdit("main.py", 1, 5, 0, "x", 0);
    t3.onEdit("main.py", 1, 0, 1, "", 1_000);
    t3.onFileClosed("main.py", 2_000);
    expect(drain(t3, 2_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // deactivate(dispose 即时落定,无需等窗口)
    const t4 = new BehaviorSessionTracker();
    t4.onEdit("main.py", 1, 5, 0, "x", 0);
    t4.onEdit("main.py", 1, 0, 1, "", 1_000);
    t4.dispose(2_000);
    expect(drain(t4, 2_000)).toHaveLength(0);

    // max_duration(拆分点的 <3 半段同样丢弃)
    const t5 = new BehaviorSessionTracker();
    t5.onEdit("main.py", 1, 5, 0, "x", 0);
    t5.onEdit("main.py", 1, 0, 1, "", 91 * 60_000); // 超 90min → 拆分
    t5.onEditorSwitch("main.py", 91 * 60_000 + 1_000);
    expect(drain(t5, 91 * 60_000 + 1_000 + RESUME_WINDOW + 1)).toHaveLength(0);
  });

  it("ends sessions on idle and includes the trailing gap in max gap", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abcd", 100_000);
    tracker.onEdit("main.py", 2, 2, 0, "abcd\ncd", 200_000);
    tracker.checkIdle(500_000); // 距最后编辑 300_000ms = 5min

    expect(drain(tracker, 500_000)).toHaveLength(0); // 挂起中
    const out = drain(tracker, 500_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("idle");
    expect(out[0].duration_ms).toBe(500_000);
    expect(out[0].typing.max_gap_ms).toBe(300_000); // 尾随空闲计入
  });

  it("does not end sessions below the idle threshold", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abc", 100_000);
    tracker.onEdit("main.py", 2, 2, 0, "abc\nde", 300_000);
    tracker.checkIdle(599_000); // 距最后编辑 299s < 5min
    expect(drain(tracker, 599_000 + RESUME_WINDOW + 1)).toHaveLength(0);
  });

  it("ends a session at max duration and starts a fresh one", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abc", 1_000);
    tracker.onEdit("main.py", 2, 2, 0, "abc\nde", 2_000);
    tracker.onEdit("main.py", 1, 2, 0, "ab", 91 * 60_000); // 超 90min → 拆分
    tracker.onEdit("main.py", 1, 2, 0, "abc", 91 * 60_000 + 500);
    tracker.onEdit("main.py", 3, 2, 0, "abc\nde\nfg", 91 * 60_000 + 1_000);
    tracker.onEditorSwitch("main.py", 91 * 60_000 + 2_000);

    // 切走时前半段因"让位"已落定入队,后半段仍挂起
    let out = drain(tracker, 91 * 60_000 + 2_000);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("max_duration");
    expect(out[0].duration_ms).toBe(91 * 60_000);
    expect(out[0].typing.changes).toBe(3);

    // 后半段窗口过期落定,从 91min 重新计时
    out = drain(tracker, 91 * 60_000 + 2_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("editor_switch");
    expect(out[0].typing.changes).toBe(3);
    expect(out[0].duration_ms).toBe(2_000);
  });

  it("resumes a same-file session within the 3min window (single buffer, original start)", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000); // a 结束 → 挂起,未发射
    tracker.onEdit("a.py", 1, 3, 0, "xy", 150_000); // 2.5min 内回来 → 续会话
    tracker.onEditorSwitch("a.py", 200_000);

    expect(drain(tracker, 200_000)).toHaveLength(0); // 挂起中
    const out = drain(tracker, 200_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1); // 续会话只发一条,不是两条
    expect(out[0].duration_ms).toBe(200_000); // 起止沿用原会话
    expect(out[0].typing.changes).toBe(4);    // 缓冲沿用
  });

  it("does not resume when another file's session intervened", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000);  // a 结束 → 挂起
    tracker.onEdit("b.py", 1, 5, 0, "y", 120_000);
    tracker.onEdit("b.py", 1, 5, 0, "yy", 125_000);
    tracker.onEdit("b.py", 1, 5, 0, "yyy", 129_000);
    tracker.onEditorSwitch("b.py", 130_000);  // b 结束 → a 让位落定,b 挂起
    tracker.onEdit("a.py", 1, 3, 0, "xy", 140_000); // a 回来 → 不续,全新会话
    tracker.onEditorSwitch("a.py", 150_000);  // a' 结束(1 次变更 → 丢弃)

    const out = drain(tracker, 150_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(2); // a 原始 payload + b;a' 因 <3 变更被丢弃
    expect(out[0].file).toBe("a.py");
    expect(out[0].duration_ms).toBe(100_000);
    expect(out[1].file).toBe("b.py");
    expect(out[1].duration_ms).toBe(10_000);
  });

  it("does not resume after the 3min window expires", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000); // a 挂起
    tracker.onEdit("a.py", 1, 3, 0, "xy", 280_001); // 3min+1ms → 窗口已过
    tracker.onEdit("a.py", 1, 3, 0, "xyz", 280_002);
    tracker.onEdit("a.py", 1, 3, 0, "xyzw", 280_500);
    tracker.onEditorSwitch("a.py", 281_000);

    const out = drain(tracker, 281_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(2); // 原会话照常落定,新会话独立
    expect(out[0].duration_ms).toBe(100_000);
    expect(out[0].typing.changes).toBe(3);
    expect(out[1].duration_ms).toBe(999); // 281_000 - 280_001
    expect(out[1].typing.changes).toBe(3);
  });

  it("emits deactivate payloads on dispose without waiting for the resume window", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 5, 0, "xx", 1_000);
    tracker.onEdit("main.py", 1, 5, 0, "xxx", 2_000);
    tracker.dispose(3_000);
    const out = drain(tracker, 3_000);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("deactivate");
  });

  it("closes a session on file close", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 5, 0, "xx", 1_000);
    tracker.onEdit("main.py", 1, 5, 0, "xxx", 2_000);
    tracker.onFileClosed("main.py", 3_000);

    const out = drain(tracker, 3_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("editor_close");
    expect(out[0].typing.changes).toBe(3);
  });

  it("marks truncated at the change cap and stops buffering further records", () => {
    const tracker = new BehaviorSessionTracker();
    for (let i = 0; i < 5_002; i++) {
      tracker.onEdit("main.py", 1, 1, 0, "a", i);
    }
    tracker.onEditorSwitch("main.py", 5_002);
    const out = drain(tracker, 5_002 + RESUME_WINDOW + 1);
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

    const out = drain(tracker, 6_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen[0].msg).toBe("expected ':'");
    expect(out[0].diagnostics.unresolved).toBe(1);
  });
});