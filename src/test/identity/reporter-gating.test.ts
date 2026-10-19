import { describe, it, expect, vi, afterEach } from "vitest";
import { createTeacherReporter } from "../../teacher/reporter";

describe("reporter 身份门控（A8：未设身份不上报，本地 L1 照记）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("identity.studentId 为 null → 不发 fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reporter = createTeacherReporter({
      teacherUrl: "http://t:3000",
      getIdentity: () => ({ studentId: null, studentName: null }),
    });
    await reporter.report({ id: "run:x", ts: new Date().toISOString(), surface: "run", kind: "execution_success", payload: { exit_code: 0 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reporter 原样上报（spec §6.1 单格式）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("全 surface 原样上报：请求体平铺 id/ts/surface/kind/payload/session_id + 身份", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);
    const reporter = createTeacherReporter({
      teacherUrl: "http://t:3000",
      getIdentity: () => ({ studentId: "2024001", studentName: "张三", classId: "3A" }),
    });
    await reporter.report({ id: "chat:01J0ARZ9V8B", ts: "2026-10-16T06:00:00.000Z", surface: "chat", kind: "user_message", payload: { text: "你好" }, session_id: "s1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://t:3000/api/events");
    expect(JSON.parse(String(init.body))).toMatchObject({
      id: "chat:01J0ARZ9V8B", surface: "chat", kind: "user_message",
      payload: { text: "你好" }, session_id: "s1",
      student_id: "2024001", student_name: "张三", class_id: "3A",
    });
  });

  it("10s 超时：abort 只记日志不抛错、不重试", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createTeacherReporter({
      teacherUrl: "http://t:3000",
      getIdentity: () => ({ studentId: "2024001", studentName: "张三" }),
    });
    const p = reporter.report({ id: "edit:01J0ARZ9V8B", ts: "2026-10-16T06:00:00.000Z", surface: "edit", kind: "code_change", payload: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 不重试
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
