// src/test/exerciseLocator.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveExercise, readExerciseManifest } from "../submission/exerciseLocator";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
const root = path.join("C:", "ws");
const files: Record<string, string> = {
  [path.join(root, "week-03", "weather-app", "exercise.json")]: `{ "exerciseId": "${ID}", "entry": "main.py" }`,
  [path.join(root, "week-03", "weather-app", "main.py")]: "# main",
};
const deps = {
  rootFsPath: root,
  join: (d: string, r: string) => path.join(d, r),
  readFile: async (fsPath: string) => files[fsPath] ?? null,
};

describe("exerciseLocator", () => {
  it("单文件：头部 id 直取，kind=file", async () => {
    const r = await resolveExercise(deps, path.join(root, "week-03", "01.py"), `# exercise-id: ${ID}\nprint(1)`);
    expect(r).toEqual({ exerciseId: ID, kind: "file" });
  });
  it("项目：当前文件（含非入口 .py）经 exercise.json 定位", async () => {
    const r = await resolveExercise(deps, path.join(root, "week-03", "weather-app", "utils.py"), "def f(): pass");
    expect(r).toEqual({ exerciseId: ID, kind: "project", entry: "main.py", projectDirFsPath: path.join(root, "week-03", "weather-app") });
  });
  it("manifest 缺 id / 非法 JSON / 无 manifest → null", async () => {
    const bad = { ...deps, readFile: async () => `{ "entry": "main.py" }` };
    expect(await resolveExercise(bad, path.join(root, "week-03", "weather-app", "utils.py"), "x")).toBeNull();
    const bad2 = { ...deps, readFile: async () => "not-json" };
    expect(await readExerciseManifest(bad2, path.join(root, "week-03", "weather-app"))).toBeNull();
    const none = { ...deps, readFile: async () => null };
    expect(await resolveExercise(none, path.join(root, "week-03", "misc", "a.py"), "x")).toBeNull();
  });
  it("week 目录外的文件 → null", async () => {
    expect(await resolveExercise(deps, path.join(root, "other", "a.py"), "x")).toBeNull();
  });
});
