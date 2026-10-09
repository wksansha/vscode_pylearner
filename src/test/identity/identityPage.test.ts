import { describe, it, expect, vi } from "vitest";
import { identityErrorText, maybeOpenIdentityPage } from "../../identity/identityPage";

describe("identityErrorText（A25 文案逐字）", () => {
  it("四类错误码映射", () => {
    expect(identityErrorText("roster_empty")).toBe("教师尚未导入名册，请联系教员后再试");
    expect(identityErrorText("student_id_not_found")).toBe("学号输入有误，请检查或联系教员");
    expect(identityErrorText("name_mismatch")).toBe("姓名与该学号不匹配，请检查或联系教员");
    expect(identityErrorText("whatever")).toBe("校验失败，请稍后重试");
  });
});

describe("maybeOpenIdentityPage 节流（A8）", () => {
  const noop = () => {};
  const ctx = {} as never;
  it("有身份不打开；无身份 60s 内只打开一次", () => {
    const open = vi.fn();
    let now = 1_000_000;
    // 用假 now 注入测试节流（实现签名带 now 参数）
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: "0001" }, 60_000, () => now, open)).toBe(false);
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(true);
    now += 30_000;
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(false);   // 节流中
    now += 31_000;
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
