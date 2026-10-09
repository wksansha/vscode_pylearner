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
