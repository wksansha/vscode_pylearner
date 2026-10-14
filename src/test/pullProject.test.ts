// src/test/pullProject.test.ts
import { describe, it, expect } from "vitest";
import { pullAssignments, type PullDeps } from "../pull/pullCommand";

const published = [{
  id: "a1", title: "第 3 周", week: 3,
  exercises: [
    { id: "ef", filename: "01.py", versionHash: "v1", kind: "file" as const },
    { id: "ep", filename: "weather-app", versionHash: "v2", kind: "project" as const, dir: "weather-app", entry: "main.py" },
  ],
}];
const projectContent = {
  kind: "project", filename: "weather-app", dir: "weather-app", entry: "main.py",
  files: [
    { path: "main.py", content: "# m" },
    { path: "data/city.txt", content: "BJ" },
  ],
};

function makeDeps(existing: Set<string>) {
  const written: string[] = [];
  const store = new Map<string, unknown>();
  const deps: PullDeps = {
    teacherUrl: () => "http://t",
    globalState: {
      get: (k: string) => store.get(k),
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
    fetchImpl: (async (url: string) => {
      if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify(published), { status: 200 });
      if (url.endsWith("/api/exercises/ep/content")) return new Response(JSON.stringify(projectContent), { status: 200 });
      if (url.endsWith("/api/exercises/ef/content")) return new Response(JSON.stringify({ kind: "file", filename: "01.py", content: "# s" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
    fileExists: async (rel: string) => existing.has(rel),
    writeFile: async (rel: string, content: string) => { written.push(rel); void content; },
  };
  return { deps, written };
}

describe("pullAssignments 项目化", () => {
  it("全量拉取：单文件 + 项目逐文件写入（含子目录）", async () => {
    const { deps, written } = makeDeps(new Set());
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(3);
    expect(written.sort()).toEqual([
      "week-03/01.py",
      "week-03/weather-app/data/city.txt",
      "week-03/weather-app/main.py",
    ].sort());
  });
  it("二次拉取：全部跳过；versionHash 变更提示（项目以入口文件存在为锚）", async () => {
    const { deps } = makeDeps(new Set(["week-03/01.py", "week-03/weather-app/main.py", "week-03/weather-app/data/city.txt"]));
    const r1 = await pullAssignments(deps);
    expect(r1.pulled).toBe(0);
    expect(r1.updateNotices).toEqual([]);
    // 服务端改题 → versionHash 变了，本地未改 → 仅提示
    published[0].exercises[1].versionHash = "v2-changed";
    const r2 = await pullAssignments(deps);
    expect(r2.pulled).toBe(0);
    expect(r2.updateNotices.some((n) => n.includes("weather-app") && n.includes("题目已更新"))).toBe(true);
  });
  it("部分文件缺失（学生删了 data/）：仅补缺失文件", async () => {
    const { deps, written } = makeDeps(new Set(["week-03/01.py", "week-03/weather-app/main.py"]));
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(1);
    expect(written).toEqual(["week-03/weather-app/data/city.txt"]);
  });
  it("服务端下发非补零 weekDir（week-5）→ 文件写入 week-5/", async () => {
    const { deps, written } = makeDeps(new Set());
    const wdDeps: PullDeps = {
      ...deps,
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify([{ ...published[0], weekDir: "week-5" }]), { status: 200 });
        if (url.endsWith("/api/exercises/ep/content")) return new Response(JSON.stringify(projectContent), { status: 200 });
        if (url.endsWith("/api/exercises/ef/content")) return new Response(JSON.stringify({ kind: "file", filename: "01.py", content: "# s" }), { status: 200 });
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
    };
    const r = await pullAssignments(wdDeps);
    expect(r.pulled).toBe(3);
    expect(written.sort()).toEqual([
      "week-5/01.py",
      "week-5/weather-app/data/city.txt",
      "week-5/weather-app/main.py",
    ].sort());
  });
  it("旧服务端（V1）兼容：content 返回非 JSON 纯文本 → 降级为单文件写入", async () => {
    const { deps, written } = makeDeps(new Set());
    const oldPublished = [{
      id: "a1", title: "第 3 周", week: 3,
      exercises: [{ id: "ef", filename: "01.py", versionHash: "v1", kind: "file" as const }],
    }];
    const oldDeps: PullDeps = {
      ...deps,
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify(oldPublished), { status: 200 });
        return new Response("# old server content", { status: 200 });
      }) as unknown as typeof fetch,
    };
    const r = await pullAssignments(oldDeps);
    expect(r.pulled).toBe(1);
    expect(written).toEqual(["week-03/01.py"]);
  });
});
