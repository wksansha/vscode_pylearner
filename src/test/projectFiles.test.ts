// src/test/projectFiles.test.ts
import { describe, it, expect } from "vitest";
import { canonicalFilesHash, isIgnoredEntry, listProjectFiles, type ProjectFs } from "../submission/projectFiles";

const tree: Record<string, string | "dir"> = {
  "C:\\ws\\week-03\\app": "dir",
  "C:\\ws\\week-03\\app\\main.py": "# main",
  "C:\\ws\\week-03\\app\\utils.py": "# u",
  "C:\\ws\\week-03\\app\\exercise.json": "{}",
  "C:\\ws\\week-03\\app\\data": "dir",
  "C:\\ws\\week-03\\app\\data\\city.txt": "BJ",
  "C:\\ws\\week-03\\app\\__pycache__": "dir",
  "C:\\ws\\week-03\\app\\__pycache__\\x.pyc": "bin",
  "C:\\ws\\week-03\\app\\.venv": "dir",
  "C:\\ws\\week-03\\app\\.venv\\y.py": "# v",
};

const fs: ProjectFs = {
  async readDirectory(fsPath) {
    if (!(fsPath in tree)) return null;
    return Object.keys(tree)
      .filter((k) => k.startsWith(fsPath + "\\"))
      .map((k) => k.slice(fsPath.length + 1))
      .filter((rest) => !rest.includes("\\"))
      .map((name) => [name, tree[`${fsPath}\\${name}`] === "dir" ? { isDirectory: true } : { isDirectory: false }] as [string, { isDirectory: boolean }]);
  },
  async readFile(fsPath) {
    const v = tree[fsPath];
    return typeof v === "string" ? v : null;
  },
};

describe("projectFiles", () => {
  it("listProjectFiles：递归收集、排除忽略集与 exercise.json、POSIX 相对路径", async () => {
    const files = await listProjectFiles(fs, "C:\\ws\\week-03\\app");
    expect(files!.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
  });
  it("目录不存在 → null", async () => {
    expect(await listProjectFiles(fs, "C:\\nope")).toBeNull();
  });
  it("canonicalFilesHash 与 server 契约一致（排序无关、64-hex）", () => {
    const a = [{ path: "a.py", content: "1" }, { path: "b.py", content: "2" }];
    const b = [{ path: "b.py", content: "2" }, { path: "a.py", content: "1" }];
    expect(canonicalFilesHash(a)).toBe(canonicalFilesHash(b));
    expect(canonicalFilesHash(a)).toMatch(/^[0-9a-f]{64}$/);
    // 与 server 端相同输入的期望值（人工对拍一次写入测试固定）
    expect(canonicalFilesHash([{ path: "main.py", content: "m" }]))
      .toBe("4b413594088b98ef1cca8a34afd3526675f2e75351bed3cf7593f3453481ae4d");
  });
  it("isIgnoredEntry 覆盖 server 忽略集 + exercise.json", () => {
    expect(isIgnoredEntry("__pycache__", true)).toBe(true);
    expect(isIgnoredEntry(".venv", true)).toBe(true);
    expect(isIgnoredEntry("venv", true)).toBe(true);
    expect(isIgnoredEntry(".git", true)).toBe(true);
    expect(isIgnoredEntry("x.pyc", false)).toBe(true);
    expect(isIgnoredEntry(".DS_Store", false)).toBe(true);
    expect(isIgnoredEntry("exercise.json", false)).toBe(true);
    expect(isIgnoredEntry("main.py", false)).toBe(false);
  });
});
