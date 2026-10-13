import { describe, it, expect } from "vitest";
import { OUTCOME_TEXT } from "../../submission/submitCommand";

describe("OUTCOME_TEXT（A3 手动兜底提示文案；V2.0 纯归档语义）", () => {
  it("五种结果均有面向学生的中文提示", () => {
    expect(OUTCOME_TEXT.submitted).toContain("已归档");
    expect(OUTCOME_TEXT.submitted).toContain("自动评审");
    expect(OUTCOME_TEXT.skipped).toContain("已归档过");
    expect(OUTCOME_TEXT["not-exercise"]).toContain("不是课堂练习");
    expect(OUTCOME_TEXT["identity-missing"]).toContain("身份");
    expect(OUTCOME_TEXT.error).toContain("失败");
  });
});
