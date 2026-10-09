import { describe, it, expect } from "vitest";
import "../vscode-mock";
import { scanExerciseId, extractPyPathFromCommand, resolvePyFile } from "../../submission/exerciseHeader";

const EXERCISE_FILE_FIXTURE = `# -*- coding: utf-8 -*-
# ===== classroom-assistant =====
# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4
# week: 1
# ===============================
# 题目：两数之和
# ===== 代码区 =====
print(1)
`;

describe("scanExerciseId（与 server 同正则，A5）", () => {
  it("标准 fixture 解析；无/坏/超 20 行 → null", () => {
    expect(scanExerciseId(EXERCISE_FILE_FIXTURE)).toBe("3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4");
    expect(scanExerciseId("print(1)\n")).toBeNull();
    expect(scanExerciseId("# exercise-id: 坏的\n")).toBeNull();
    const late = Array.from({ length: 20 }, (_, i) => `# ${i}`).join("\n")
      + "\n# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4\n";
    expect(scanExerciseId(late)).toBeNull();
  });
});

describe("extractPyPathFromCommand / resolvePyFile（A27，真实 L1 command 样例）", () => {
  it("PowerShell 调用样式（真实数据）", () => {
    expect(extractPyPathFromCommand('& C:\\Python314\\python.exe c:/Users/kaiwa/Desktop/study.py'))
      .toBe("c:/Users/kaiwa/Desktop/study.py");
  });
  it("相对路径 / 带引号含空格 / 无 .py", () => {
    expect(extractPyPathFromCommand("python exercise-01.py")).toBe("exercise-01.py");
    expect(extractPyPathFromCommand('python -u "my code/exercise-01.py"')).toBe("my code/exercise-01.py");
    expect(extractPyPathFromCommand("pip install requests")).toBeNull();
  });
  it("resolvePyFile：绝对路径直通；相对路径 join cwd；无 cwd null；分隔符统一", () => {
    expect(resolvePyFile("python exercise-01.py", "c:\\work\\class")).toBe("c:\\work\\class\\exercise-01.py");
    expect(resolvePyFile("& C:\\P\\python.exe c:/x/study.py", undefined)).toBe("c:\\x\\study.py");
    expect(resolvePyFile("python exercise-01.py", undefined)).toBeNull();
  });
  it("resolvePyFile 覆盖 A27 两种真实来源：绝对路径命令 + 相对路径命令带 cwd", () => {
    // 真实 L1 数据（2026-09-23）：& C:\Python314\python.exe c:/Users/kaiwa/Desktop/study.py
    expect(resolvePyFile("& C:\\Python314\\python.exe c:/Users/kaiwa/Desktop/study.py", undefined))
      .toBe("c:\\Users\\kaiwa\\Desktop\\study.py");
    // 学生手敲：python week-01/exercise-01.py（cwd = 工作区根）
    expect(resolvePyFile("python week-01/exercise-01.py", "c:\\classroom"))
      .toBe("c:\\classroom\\week-01\\exercise-01.py");
  });
});
