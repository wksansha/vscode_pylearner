// src/test/restoreProject.test.ts
import { describe, it, expect } from "vitest";
import { restoreSubmissions, type RestoreDeps } from "../commands/restoreSubmissions";

const published = [{
  id: "a1", week: 3,
  exercises: [
    { id: "ef", filename: "01.py", kind: "file" as const },
    { id: "ep", filename: "weather-app", kind: "project" as const, dir: "weather-app" },
  ],
}];
const submissions = [
  { exerciseId: "ep", code: "# m", submittedAt: 200,
    files: [{ path: "main.py", content: "# m" }, { path: "utils.py", content: "# u" }] },
  { exerciseId: "ef", code: "# s", submittedAt: 100, files: null },
];

function makeDeps(local: Record<string, string | null>) {
  const written: { rel: string; content: string }[] = [];
  const deps: RestoreDeps = {
    teacherUrl: () => "http://t",
    getStudentId: () => "2025001",
    fetchImpl: (async (url: string) => {
      if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify(published), { status: 200 });
      if (url.includes("/api/submissions/student/")) return new Response(JSON.stringify(submissions), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
    readFile: async (rel: string) => local[rel] ?? null,
    writeFile: async (rel: string, content: string) => { written.push({ rel, content }); },
  };
  return { deps, written };
}

describe("restoreSubmissions 项目化", () => {
  it("项目行按 files 逐文件恢复；单文件行为不变", async () => {
    const { deps, written } = makeDeps({});
    const r = await restoreSubmissions(deps);
    expect(r.restored.sort()).toEqual([
      "week-03/01.py", "week-03/weather-app/main.py", "week-03/weather-app/utils.py",
    ].sort());
    void written;
  });
  it("本地一致的文件跳过（identical 按文件粒度）", async () => {
    const { deps } = makeDeps({ "week-03/weather-app/main.py": "# m" });
    const r = await restoreSubmissions(deps);
    expect(r.restored.includes("week-03/weather-app/main.py")).toBe(false);
    expect(r.restored.includes("week-03/weather-app/utils.py")).toBe(true);
    expect(r.identical).toEqual(["week-03/weather-app/main.py"]);
  });
  it("服务端下发非补零 weekDir（week-5）→ 恢复路径 week-5/weather-app/main.py", async () => {
    const { deps } = makeDeps({});
    const wdDeps: RestoreDeps = {
      ...deps,
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify([{ ...published[0], weekDir: "week-5" }]), { status: 200 });
        if (url.includes("/api/submissions/student/")) return new Response(JSON.stringify(submissions), { status: 200 });
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
    };
    const r = await restoreSubmissions(wdDeps);
    expect(r.restored.sort()).toEqual([
      "week-5/01.py", "week-5/weather-app/main.py", "week-5/weather-app/utils.py",
    ].sort());
  });
  it("旧服务端行为兼容：行无 files 字段按单文件恢复", async () => {
    const { deps } = makeDeps({});
    const r = await restoreSubmissions(deps);
    expect(r.restored).toContain("week-03/01.py");
  });
});
