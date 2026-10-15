// src/test/exerciseLocator.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveProject, readExerciseManifest } from "../submission/exerciseLocator";

const root = path.join("C:", "ws");
const files: Record<string, string> = {
  [path.join(root, "lesson5", "weather-app", "exercise.json")]: `{ "entry": "main.py" }`,
  [path.join(root, "lesson5", "weather-app", "main.py")]: "# main",
};
const deps = {
  rootFsPath: root,
  join: (d: string, r: string) => path.join(d, r),
  readFile: async (fsPath: string) => files[fsPath] ?? null,
};

describe("exerciseLocator（项目目录判定，学生端零练习识别）", () => {
  it("项目目录内文件（含非入口 .py）→ entry + 项目目录绝对路径", async () => {
    const r = await resolveProject(deps, path.join(root, "lesson5", "weather-app", "utils.py"));
    expect(r).toEqual({ entry: "main.py", projectDirFsPath: path.join(root, "lesson5", "weather-app") });
  });
  it("manifest 合法 JSON 即项目标记：无 entry 缺省 main.py；数组 JSON → null；坏 JSON → null", async () => {
    const obj = { ...deps, readFile: async () => `{}` };
    expect(await readExerciseManifest(obj, path.join(root, "lesson5", "weather-app"))).toEqual({ entry: "main.py" });
    const arr = { ...deps, readFile: async () => `[]` };
    expect(await readExerciseManifest(arr, path.join(root, "lesson5", "weather-app"))).toBeNull();
    const bad = { ...deps, readFile: async () => "not-json" };
    expect(await readExerciseManifest(bad, path.join(root, "lesson5", "weather-app"))).toBeNull();
  });
  it("目录缺 exercise.json → null", async () => {
    const none = { ...deps, readFile: async () => null };
    expect(await resolveProject(none, path.join(root, "lesson5", "misc", "a.py"))).toBeNull();
  });
  it("作业目录一级 .py → null（单文件题快照由服务端路径定位）", async () => {
    expect(await resolveProject(deps, path.join(root, "lesson5", "01.py"))).toBeNull();
  });
  it("目录命名自由（week-5 旧约定退役）→ 照常定位", async () => {
    const files5 = {
      [path.join(root, "week-5", "weather-app", "exercise.json")]: `{ "exerciseId": "x", "entry": "main.py" }`,
    };
    const deps5 = { ...deps, readFile: async (fsPath: string) => files5[fsPath] ?? null };
    const r = await resolveProject(deps5, path.join(root, "week-5", "weather-app", "utils.py"));
    expect(r).toEqual({ entry: "main.py", projectDirFsPath: path.join(root, "week-5", "weather-app") });
  });
  it("workspace 根外 / 无根 → null", async () => {
    expect(await resolveProject(deps, path.join("D:", "other", "a.py"))).toBeNull();
    expect(await resolveProject({ ...deps, rootFsPath: "" }, path.join(root, "lesson5", "weather-app", "a.py"))).toBeNull();
  });
});
