// src/test/collectTargets.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectSubmissionTargets, type WorkspaceFs } from "../submission/collectTargets";

const ID_A = "01234567-89ab-cdef-0123-456789abcdef";
const ID_B = "11111111-2222-3333-4444-555555555555";
const root = path.join("C:", "ws");

/** 内存树 → WorkspaceFs（同 projectSnapshot.test.ts 手法；Windows 反斜杠语义） */
function makeFs(tree: Record<string, "dir" | "f">, files: Record<string, string>): WorkspaceFs {
  return {
    async readDirectory(fsPath) {
      if (!(fsPath in tree)) return null;
      return Object.keys(tree)
        .filter((k) => k.startsWith(fsPath + path.sep) && !k.slice(fsPath.length + 1).includes(path.sep))
        .map((k) => k.slice(fsPath.length + 1))
        .map((name) => [name, tree[`${fsPath}${path.sep}${name}`] === "dir" ? { isDirectory: true } : { isDirectory: false }] as [string, { isDirectory: boolean }]);
    },
    readFile: async (p) => files[p] ?? null,
  };
}

describe("collectSubmissionTargets（V2.0 提交按钮：一键归档全部练习）", () => {
  it("混合工作区：单文件按头部 id 收集；无头部 .py 跳过；项目目录以入口文件为锚点", async () => {
    const week02 = path.join(root, "week-02");
    const app = path.join(root, "week-03", "weather-app");
    const tree: Record<string, "dir" | "f"> = {
      [root]: "dir",
      [week02]: "dir",
      [path.join(week02, "01-hello.py")]: "f",
      [path.join(week02, "02-notes.py")]: "f",
      [path.join(root, "week-03")]: "dir",
      [app]: "dir",
      [path.join(app, "exercise.json")]: "f",
      [path.join(app, "main.py")]: "f",
      [path.join(app, "utils.py")]: "f",
    };
    const hello = `# exercise-id: ${ID_A}\nprint("hi")`;
    const files: Record<string, string> = {
      [path.join(week02, "01-hello.py")]: hello,
      [path.join(week02, "02-notes.py")]: "print('no header')",
      [path.join(app, "exercise.json")]: `{ "exerciseId": "${ID_B}", "entry": "main.py" }`,
      [path.join(app, "main.py")]: "# entry code",
      [path.join(app, "utils.py")]: "# u",
    };
    const targets = await collectSubmissionTargets(makeFs(tree, files), root);
    expect(targets).toEqual([
      { label: "week-02/01-hello.py", filePath: path.join(week02, "01-hello.py"), content: hello },
      { label: "week-03/weather-app", filePath: path.join(app, "main.py"), content: "# entry code" },
    ]);
  });

  it("无 week-XX 目录 → 空数组；根目录不可读 → 空数组", async () => {
    const tree: Record<string, "dir" | "f"> = { [root]: "dir", [path.join(root, "misc")]: "dir" };
    expect(await collectSubmissionTargets(makeFs(tree, {}), root)).toEqual([]);
    expect(await collectSubmissionTargets(makeFs({}, {}), root)).toEqual([]);
  });

  it("项目入口文件缺失 → 跳过不收集", async () => {
    const app = path.join(root, "week-04", "broken-app");
    const tree: Record<string, "dir" | "f"> = {
      [root]: "dir",
      [path.join(root, "week-04")]: "dir",
      [app]: "dir",
      [path.join(app, "exercise.json")]: "f",
    };
    const files = { [path.join(app, "exercise.json")]: `{ "exerciseId": "${ID_B}", "entry": "main.py" }` };
    expect(await collectSubmissionTargets(makeFs(tree, files), root)).toEqual([]);
  });

  it("exercise.json 非法 → 不收集；entry 缺省 → main.py", async () => {
    const bad = path.join(root, "week-05", "bad-app");
    const good = path.join(root, "week-05", "good-app");
    const tree: Record<string, "dir" | "f"> = {
      [root]: "dir",
      [path.join(root, "week-05")]: "dir",
      [bad]: "dir",
      [path.join(bad, "exercise.json")]: "f",
      [good]: "dir",
      [path.join(good, "exercise.json")]: "f",
      [path.join(good, "main.py")]: "f",
    };
    const files = {
      [path.join(bad, "exercise.json")]: "{ not json",
      [path.join(good, "exercise.json")]: `{ "exerciseId": "${ID_B}" }`,
      [path.join(good, "main.py")]: "# default entry",
    };
    const targets = await collectSubmissionTargets(makeFs(tree, files), root);
    expect(targets).toHaveLength(1);
    expect(targets[0].label).toBe("week-05/good-app");
    expect(targets[0].filePath).toBe(path.join(good, "main.py"));
    expect(targets[0].content).toBe("# default entry");
  });

  it("排序：week-02 在 week-10 之前（零填充字符串序），周内按名称", async () => {
    const tree: Record<string, "dir" | "f"> = { [root]: "dir" };
    const files: Record<string, string> = {};
    for (const week of ["week-02", "week-10"]) {
      tree[path.join(root, week)] = "dir";
      tree[path.join(root, week, "a.py")] = "f";
      files[path.join(root, week, "a.py")] = `# exercise-id: ${ID_A}\nprint(1)`;
    }
    const targets = await collectSubmissionTargets(makeFs(tree, files), root);
    expect(targets.map((t) => t.label)).toEqual(["week-02/a.py", "week-10/a.py"]);
  });
});
