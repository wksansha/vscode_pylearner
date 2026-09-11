import { describe, it, expect } from "vitest";
import { sectionLabel } from "../../memory/sectionLabels";

describe("sectionLabel", () => {
  it("maps the prompt-canonical topic sections to Chinese", () => {
    expect(sectionLabel("Loop Control")).toBe("循环控制");
    expect(sectionLabel("List Operations")).toBe("列表操作");
    expect(sectionLabel("Function Definition")).toBe("函数定义");
    expect(sectionLabel("Dictionary Usage")).toBe("字典用法");
    expect(sectionLabel("Import Syntax")).toBe("导入语法");
    expect(sectionLabel("Exception Handling")).toBe("异常处理");
  });

  it("falls back to the original name for unknown sections", () => {
    expect(sectionLabel("Generators")).toBe("Generators");
    expect(sectionLabel("Identity")).toBe("身份信息"); // existing mapping intact
  });

  it("maps sections the LLM invented in the 2026-09-11 rebuild", () => {
    expect(sectionLabel("List Comprehensions")).toBe("列表推导式");
    expect(sectionLabel("Variable Definition")).toBe("变量定义");
    expect(sectionLabel("Syntax Errors (Colon Usage)")).toBe("语法错误（冒号用法）");
    expect(sectionLabel("Type Errors (String-Float Concatenation)")).toBe(
      "类型错误（字符串-浮点拼接）"
    );
  });
});