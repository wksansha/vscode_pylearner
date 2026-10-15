// src/test/projectSnapshot.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildProjectSnapshot } from "../submission/projectSnapshot";

const root = path.join("C:", "ws");
const appDir = path.join(root, "lesson5", "weather-app");
const fileContents: Record<string, string> = {
  [path.join(appDir, "exercise.json")]: `{ "entry": "main.py" }`,
  [path.join(appDir, "main.py")]: "# entry",
  [path.join(appDir, "utils.py")]: "# u",
  [path.join(appDir, "data", "city.txt")]: "BJ",
};
const tree: Record<string, string | "dir"> = {
  [appDir]: "dir",
  [path.join(appDir, "main.py")]: "f",
  [path.join(appDir, "utils.py")]: "f",
  [path.join(appDir, "exercise.json")]: "f",
  [path.join(appDir, "data")]: "dir",
  [path.join(appDir, "data", "city.txt")]: "f",
};
const deps = {
  locator: {
    rootFsPath: root,
    join: (d: string, r: string) => path.join(d, r),
    readFile: async (p: string) => fileContents[p] ?? null,
  },
  projectFs: {
    async readDirectory(fsPath: string) {
      if (!(fsPath in tree)) return null;
      return Object.keys(tree)
        .filter((k) => k.startsWith(fsPath + path.sep) && !k.slice(fsPath.length + 1).includes(path.sep))
        .map((k) => k.slice(fsPath.length + 1))
        .map((name) => [name, tree[`${fsPath}${path.sep}${name}`] === "dir" ? { isDirectory: true } : { isDirectory: false }] as [string, { isDirectory: boolean }]);
    },
    readFile: async (p: string) => fileContents[p] ?? null,
  },
};

describe("buildProjectSnapshot（项目目录快照，无 exerciseId 逻辑）", () => {
  it("项目文件快照 + 入口内容，排除 exercise.json", async () => {
    const snap = await buildProjectSnapshot(deps, path.join(appDir, "utils.py"), "# u");
    expect(snap!.entryContent).toBe("# entry");
    expect(snap!.files.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
    expect(Object.keys(snap!)).toEqual(["files", "entryContent"]);   // 不再返回 exerciseId
  });
  it("manifest 无 exerciseId（新模型 {}）也成立，entry 缺省 main.py", async () => {
    const bare = {
      ...deps,
      locator: { ...deps.locator, readFile: async (p: string) => (p.endsWith("exercise.json") ? "{}" : fileContents[p] ?? null) },
    };
    const snap = await buildProjectSnapshot(bare, path.join(appDir, "main.py"), "# entry");
    expect(snap!.entryContent).toBe("# entry");
  });
  it("非项目文件（作业目录一级 .py）→ null", async () => {
    expect(await buildProjectSnapshot(deps, path.join(root, "lesson5", "01.py"), "print(1)")).toBeNull();
  });
  it("目录缺 exercise.json → null", async () => {
    const noManifest = {
      ...deps,
      locator: { ...deps.locator, readFile: async () => null },
    };
    expect(await buildProjectSnapshot(noManifest, path.join(appDir, "utils.py"), "# u")).toBeNull();
  });
});
